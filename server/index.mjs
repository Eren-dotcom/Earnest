import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

import { PUBLIC_DIR, ROOT, RUNTIME_DIR, WORKSPACE_DIR } from './lib/paths.mjs';
import { readState, update } from './lib/store.mjs';
import { ensureDir, exists } from './lib/fsutil.mjs';
import { DEFAULT_CONTRACT } from './lib/contracts.mjs';
import {
  resetWorkspace,
  startRun,
  recordReview,
  repairIncident,
  restore,
  publicState,
} from './lib/engine.mjs';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sanitizeContract(input) {
  const contract = { ...DEFAULT_CONTRACT, ...(input ?? {}) };
  contract.allowedPaths = Array.isArray(contract.allowedPaths) && contract.allowedPaths.length
    ? contract.allowedPaths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : DEFAULT_CONTRACT.allowedPaths;
  contract.allowedCommands = Array.isArray(contract.allowedCommands)
    ? contract.allowedCommands
    : DEFAULT_CONTRACT.allowedCommands;
  contract.invariants = Array.isArray(contract.invariants) ? contract.invariants : DEFAULT_CONTRACT.invariants;
  contract.goal = typeof contract.goal === 'string' && contract.goal.trim() ? contract.goal.trim() : DEFAULT_CONTRACT.goal;
  return contract;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const candidates = [path.join(PUBLIC_DIR, rel)];
  if (rel.startsWith('/preview/')) {
    candidates.unshift(path.join(WORKSPACE_DIR, rel.replace('/preview/', '')));
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const allowedRoot = resolved.startsWith(path.resolve(PUBLIC_DIR)) || resolved.startsWith(path.resolve(WORKSPACE_DIR));
    if (!allowedRoot) continue;
    if (!(await exists(resolved))) continue;
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
    return true;
  }
  return false;
}

const routes = {
  'GET /api/state': async () => {
    const state = await readState();
    return { status: 200, body: publicState(state) };
  },

  'GET /api/scenarios': async () => {
    const state = await readState();
    return { status: 200, body: { scenarios: publicState(state).scenarios, contract: DEFAULT_CONTRACT } };
  },

  'POST /api/reset': async () => {
    const result = await update(async (state) => {
      const checkpoint = await resetWorkspace();
      state.tasks = [];
      state.ledger = [];
      state.run = null;
      state.incident = null;
      state.badges = [];
      state.trust = 5;
      state.trustHistory = [
        {
          id: 'trust-seed',
          at: new Date().toISOString(),
          from: 5,
          to: 5,
          reason: 'Workspace reset. New agent/project pairing starts at 5/10.',
          taskId: null,
        },
      ];
      state.ledger.unshift({
        id: 'evt-reset',
        at: new Date().toISOString(),
        type: 'workspace-reset',
        text: `Workspace reset from the pristine sample and checkpoint ${checkpoint.id} created.`,
        severity: 'info',
      });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/run': async (req) => {
    const body = await readBody(req);
    const contract = sanitizeContract(body.contract);
    const scenarioId = body.scenarioId ?? 'safe-success';
    const result = await update(async (state) => {
      await startRun({ scenarioId, contract, state });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/review': async (req) => {
    const body = await readBody(req);
    const verdict = body.verdict === 'reject' ? 'reject' : 'accept';
    const result = await update(async (state) => {
      recordReview({ state, verdict, note: body.note });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/repair': async () => {
    const result = await update(async (state) => {
      await repairIncident({ state });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/restore': async (req) => {
    const body = await readBody(req);
    const result = await update(async (state) => {
      const outcome = await restore({
        state,
        checkpointId: body.checkpointId ?? state.tasks[0]?.checkpointId ?? 'checkpoint-before-task',
        taskId: body.taskId,
      });
      return { restore: outcome, state: publicState(state) };
    });
    return { status: 200, body: result };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const handler = routes[key];
    if (handler) {
      const { status, body } = await handler(req, res);
      send(res, status, body, { 'Access-Control-Allow-Origin': '*' });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      send(res, 404, { error: 'Unknown API endpoint', path: url.pathname });
      return;
    }

    if (await serveStatic(req, res, url.pathname)) return;

    if (await serveStatic(req, res, '/index.html')) return;
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error('[earnest]', error);
    send(res, status, { error: error.message, code: error.code ?? null });
  }
});

await ensureDir(RUNTIME_DIR);
if (!(await exists(WORKSPACE_DIR))) {
  await resetWorkspace();
}

server.listen(PORT, HOST, () => {
  console.log(`Earnest is running at http://${HOST}:${PORT}`);
  console.log(`Workspace: ${path.relative(ROOT, WORKSPACE_DIR)}`);
});
