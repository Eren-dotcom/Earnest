import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

import { PUBLIC_DIR, ROOT, RUNTIME_DIR, WORKSPACE_DIR } from './lib/paths.mjs';
import { readState, update, verifyLedger, resetLedger, logEvent } from './lib/store.mjs';
import { ensureDir, exists } from './lib/fsutil.mjs';
import { DEFAULT_CONTRACT, CONTRACT_WARNINGS, approvalModeFor } from './lib/contracts.mjs';
import { CHECK_TYPES } from './lib/verify.mjs';
import { defaultWeights } from './lib/scoring.mjs';
import {
  resetWorkspace,
  startRun,
  recordReview,
  repairIncident,
  restore,
  decideApproval,
  cancelRun,
  grantOverride,
  publicState,
} from './lib/engine.mjs';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';

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
  contract.goal = typeof contract.goal === 'string' && contract.goal.trim() ? contract.goal.trim() : DEFAULT_CONTRACT.goal;
  contract.acceptanceChecks = Array.isArray(contract.acceptanceChecks)
    ? contract.acceptanceChecks
    : DEFAULT_CONTRACT.acceptanceChecks;
  contract.invariants = Array.isArray(contract.invariants)
    ? contract.invariants.map((entry, i) => {
        if (typeof entry === 'string') {
          // Prose rules cannot be machine-checked. Keep them visible and
          // report them as Unclear rather than pretending they were verified.
          return { id: `manual-${i}`, label: entry, type: 'manual', enabled: true };
        }
        return { ...entry, enabled: entry.enabled !== false };
      })
    : DEFAULT_CONTRACT.invariants;
  return contract;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function ledgerCsv(state) {
  const events = [...(state.ledger ?? []), ...(state.ledgerArchive ?? [])];
  const columns = ['seq', 'at', 'type', 'taskId', 'path', 'severity', 'text', 'hash'];
  const lines = [columns.join(',')];
  for (const event of events) {
    lines.push(columns.map((c) => csvCell(event[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const candidates = [path.join(PUBLIC_DIR, rel)];
  if (rel.startsWith('/preview/') || rel === '/preview') {
    const suffix = rel.replace(/^\/preview\/?/, '');
    candidates.unshift(path.join(WORKSPACE_DIR, suffix || 'index.html'));
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const allowedRoot =
      resolved.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) ||
      resolved.startsWith(`${path.resolve(WORKSPACE_DIR)}${path.sep}`) ||
      resolved === path.resolve(PUBLIC_DIR) ||
      resolved === path.resolve(WORKSPACE_DIR);
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

function resolveApprovalMode(requested, trust) {
  if (requested === 'tier' || requested === undefined || requested === null || requested === '') {
    return approvalModeFor(trust);
  }
  if (['auto', 'plan', 'per-edit'].includes(requested)) {
    // A low-trust tier cannot be loosened from the client.
    const floor = approvalModeFor(trust);
    if (floor === 'per-edit') return 'per-edit';
    if (floor === 'plan' && requested === 'auto') return 'plan';
    return requested;
  }
  return approvalModeFor(trust);
}

const routes = {
  'GET /api/state': async () => {
    const state = await readState();
    return { status: 200, body: publicState(state) };
  },

  'GET /api/scenarios': async () => {
    const state = await readState();
    return {
      status: 200,
      body: {
        scenarios: publicState(state).scenarios,
        contract: DEFAULT_CONTRACT,
        weights: defaultWeights(),
        checkTypes: Object.entries(CHECK_TYPES).map(([id, def]) => ({ id, label: def.label })),
        warnings: CONTRACT_WARNINGS,
        approvalMode: approvalModeFor(state.trust),
      },
    };
  },

  'GET /api/ledger/verify': async () => {
    const state = await readState();
    return { status: 200, body: verifyLedger(state) };
  },

  'GET /api/export': async (req, res, url) => {
    const state = await readState();
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
    if (format === 'csv') {
      return {
        status: 200,
        raw: ledgerCsv(state),
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="earnest-ledger.csv"',
        },
      };
    }
    return {
      status: 200,
      body: {
        project: { id: state.projectId, name: state.projectName },
        trust: state.trust,
        exportedAt: new Date().toISOString(),
        ledgerHead: state.ledgerHead ?? null,
        verification: verifyLedger(state),
        incidents: state.incidents ?? [],
        tasks: state.tasks,
        ledger: [...(state.ledger ?? []), ...(state.ledgerArchive ?? [])],
      },
      headers: {
        'Content-Disposition': 'attachment; filename="earnest-ledger.json"',
      },
    };
  },

  'POST /api/reset': async () => {
    const result = await update(async (state) => {
      const checkpoint = await resetWorkspace();
      resetLedger(state);
      state.tasks = [];
      state.run = null;
      state.runApproval = null;
      state.runPlan = null;
      state.runResults = [];
      state.runBaseline = null;
      state.runBaselineTests = null;
      state.incident = null;
      state.incidents = [];
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
      logEvent(state, {
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
      await startRun({
        scenarioId,
        contract,
        state,
        approvalMode: resolveApprovalMode(body.approvalMode, state.trust),
        weights: Array.isArray(body.weights) ? body.weights : null,
      });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/approve': async (req) => {
    const body = await readBody(req);
    const result = await update(async (state) => {
      await decideApproval({ state, decision: body.decision, index: body.index ?? null });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/cancel': async () => {
    const result = await update(async (state) => {
      cancelRun({ state });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/override': async (req) => {
    const body = await readBody(req);
    const result = await update(async (state) => {
      grantOverride({ state, note: body.note });
      return publicState(state);
    });
    return { status: 200, body: result };
  },

  'POST /api/contest': async (req) => {
    const body = await readBody(req);
    const result = await update(async (state) => {
      const events = [...(state.ledger ?? []), ...(state.ledgerArchive ?? [])];
      const target = events.find((e) => e.id === body.eventId);
      if (!target) {
        const err = new Error('That ledger event could not be found.');
        err.statusCode = 404;
        err.code = 'event-not-found';
        throw err;
      }
      logEvent(state, {
        type: 'event-contested',
        taskId: target.taskId ?? null,
        eventId: target.id,
        text: `You contested event ${target.id} (${target.type}): ${String(body.note ?? 'No reason given.').trim()}`,
        severity: 'warning',
      });
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
      const { status, body, raw, headers = {} } = await handler(req, res, url);
      send(res, status, raw ?? body, { 'Access-Control-Allow-Origin': '*', ...headers });
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

// Listen only when run directly (`node server/index.mjs`). On Vercel the
// handler is exported instead (see api/index.mjs) — serverless has no port.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`Earnest is running at http://${HOST}:${server.address().port}`);
    console.log(`Workspace: ${path.relative(ROOT, WORKSPACE_DIR)}`);
  });
}

export default server;
