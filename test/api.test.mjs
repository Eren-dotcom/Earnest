import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * HTTP integration tests: they drive the real server the way the dashboard does.
 * Each run gets its own runtime directory and port so it cannot collide with a
 * developer's running demo.
 */

const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'earnest-api-'));
const port = 5300 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let server;

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  server = spawn('node', ['server/index.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', EARNEST_RUNTIME: runtime },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.ok) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start in time');
});

after(async () => {
  server?.kill('SIGKILL');
  await fs.rm(runtime, { recursive: true, force: true });
});

test('serves the dashboard page with a language and a single h1', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, 'exactly one top-level heading');
  assert.match(html, /aria-live="polite"/, 'has a polite live region');
  assert.match(html, /role="alert"/, 'has an assertive alert region');
  assert.match(html, /skip-link/, 'offers a skip link');
});

test('serves static assets with correct content types', async () => {
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('GET /api/state returns everything the UI reads', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  for (const key of ['trust', 'tier', 'nextPrivilege', 'projectScore', 'scenarios', 'ledger', 'trustHistory', 'repairOnly']) {
    assert.ok(key in body, `state exposes ${key}`);
  }
  assert.equal(body.trust, 5);
  assert.equal(body.scenarios.length, 4);
});

test('GET /api/scenarios returns the contract and the four scenarios', async () => {
  const { status, body } = await get('/api/scenarios');
  assert.equal(status, 200);
  assert.ok(body.contract.allowedPaths.includes('src/HeroImage.js'));
  assert.equal(body.scenarios.length, 4);
  for (const scenario of body.scenarios) {
    assert.ok(scenario.name && scenario.tagline && scenario.description);
  }
});

test('full success loop: run, review, and a trust reward', async () => {
  await post('/api/reset');
  const run = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(run.status, 200);
  const task = run.body.activeTask;
  assert.equal(task.checks.human.status, 'waiting');
  assert.equal(task.provisional, true);

  const review = await post('/api/review', { verdict: 'accept', note: 'Reads well.' });
  assert.equal(review.body.trust, 6, 'a verified 9+ task earns one level');
  assert.equal(review.body.latestTask.provisional, false);
  assert.equal(review.body.latestTask.outcome, 'pass');
});

test('violation loop: blocked write, repair-only lock, verified repair', async () => {
  await post('/api/reset');
  const run = await post('/api/run', { scenarioId: 'scope-violation' });
  assert.equal(run.body.repairOnly, true);
  assert.ok(run.body.incident);

  const blocked = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(blocked.status, 409, 'new work is refused in repair-only mode');
  assert.equal(blocked.body.code, 'repair-required');

  await post('/api/review', { verdict: 'accept' });
  const repair = await post('/api/repair');
  assert.equal(repair.body.incident.status, 'resolved');
  assert.equal(repair.body.repairOnly, false);

  const allowed = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(allowed.status, 200, 'work resumes after a verified repair');
});

test('restore endpoint reverts the workspace and reports verification', async () => {
  await post('/api/reset');
  const run = await post('/api/run', { scenarioId: 'scoped-runner' });
  const checkpointId = run.body.latestTask.checkpointId;

  const restored = await post('/api/restore', { checkpointId });
  assert.equal(restored.body.restore.ok, true);
  assert.match(restored.body.restore.reason, /matches the checkpoint/);
  assert.equal(restored.body.state.repairOnly, false);
});

test('a custom contract is enforced, not merely displayed', async () => {
  await post('/api/reset');
  const run = await post('/api/run', {
    scenarioId: 'scope-violation',
    contract: {
      goal: 'Add alt text',
      allowedPaths: ['src/HeroImage.js', 'src/Navbar.js'],
    },
  });

  // With Navbar.js allowed, the same agent action is no longer a block.
  const navbarAction = run.body.activeTask.actions.find((a) => a.path === 'src/Navbar.js');
  assert.equal(navbarAction.decision, 'allow');
  assert.equal(run.body.activeTask.checks.scope.status, 'pass');
});

test('unknown endpoints and unknown scenarios fail cleanly', async () => {
  const missing = await get('/api/nope');
  assert.equal(missing.status, 404);

  const bad = await post('/api/run', { scenarioId: 'does-not-exist' });
  assert.equal(bad.status, 500);
  assert.match(bad.body.error, /Unknown scenario/);
});

test('the sample project preview is served from the disposable workspace', async () => {
  await post('/api/reset');
  const res = await fetch(`${base}/preview/index.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Workshop/);

  const css = await fetch(`${base}/preview/src/site.css`);
  assert.equal(css.status, 200);
});

test('path traversal cannot escape the served directories', async () => {
  for (const attempt of ['/preview/../../server/lib/paths.mjs', '/preview/%2e%2e/%2e%2e/package.json']) {
    const res = await fetch(base + attempt);
    const body = await res.text().catch(() => '');
    assert.ok(!body.includes('RUNTIME_DIR') && !body.includes('"name": "earnest"'), `blocked: ${attempt}`);
  }
});

test('reset returns the demo to its documented starting point', async () => {
  await post('/api/run', { scenarioId: 'safe-success' });
  const reset = await post('/api/reset');
  assert.equal(reset.body.trust, 5);
  assert.equal(reset.body.taskCount, 0);
  assert.equal(reset.body.projectScore, null);
  assert.equal(reset.body.repairOnly, false);
  assert.equal(reset.body.latestTask, null);
});
