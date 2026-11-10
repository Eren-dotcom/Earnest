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
// PORT 0 lets the OS assign a free port, so concurrent test runs never collide.
// The server logs its actual port on startup; before() reads it from stdout.
let base;
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

/** Run a scenario and approve whatever the current trust tier asks for. */
const runScenario = async (body) => {
  let result = await post('/api/run', body);
  if (result.status !== 200) return result;
  let guard = 0;
  while (result.body?.approval && guard < 20) {
    result = await post('/api/approve', { decision: 'allow' });
    guard += 1;
  }
  assert.ok(guard < 20, 'approval loop terminated');
  return result;
};

const hero = () => fs.readFile(path.join(runtime, 'workspace', 'src', 'HeroImage.js'), 'utf8');
const navbar = () => fs.readFile(path.join(runtime, 'workspace', 'src', 'Navbar.js'), 'utf8');
const siteCss = () => fs.readFile(path.join(runtime, 'workspace', 'src', 'site.css'), 'utf8');

before(async () => {
  server = spawn('node', ['server/index.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', EARNEST_RUNTIME: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  base = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    let out = '';
    server.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    server.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
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
  assert.match(html, /id="approval-panel"/, 'offers an approval panel');
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
  await post('/api/reset');
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  for (const key of [
    'trust', 'tier', 'nextPrivilege', 'projectScore', 'scenarios', 'ledger',
    'trustHistory', 'repairOnly', 'approval', 'safetyFlag', 'ledgerIntegrity',
  ]) {
    assert.ok(key in body, `state exposes ${key}`);
  }
  assert.equal(body.trust, 5);
  assert.equal(body.scenarios.length, 5);
  assert.equal(body.ledgerIntegrity.ok, true);
  assert.equal(body.safetyFlag.active, false);
});

test('GET /api/scenarios returns the contract, weights and the check registry', async () => {
  const { status, body } = await get('/api/scenarios');
  assert.equal(status, 200);
  assert.ok(body.contract.allowedPaths.includes('src/HeroImage.js'));
  assert.equal(body.scenarios.length, 5);
  assert.equal(body.weights.length, 5);
  assert.ok(body.checkTypes.some((c) => c.id === 'file-unchanged'));
  assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0);
  assert.equal(body.approvalMode, 'plan', 'trust 5 requires a plan preview');
  for (const scenario of body.scenarios) {
    assert.ok(scenario.name && scenario.tagline && scenario.description);
  }
});

test('full success loop: preview, approve, review, and a trust reward', async () => {
  await post('/api/reset');
  const first = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(first.status, 200);
  assert.ok(first.body.approval, 'the tier requires a plan preview');
  assert.equal(first.body.activeTask, null, 'nothing has run yet');
  assert.match(await hero(), /alt=""/, 'no edit was applied before approval');

  const run = await post('/api/approve', { decision: 'allow' });
  const task = run.body.activeTask;
  assert.equal(task.checks.human.status, 'waiting');
  assert.equal(task.provisional, true);
  assert.equal(task.checks.invariants.status, 'pass');
  assert.match(await hero(), /alt="A wooden workshop table/);

  const review = await post('/api/review', { verdict: 'accept', note: 'Reads well.' });
  assert.equal(review.body.trust, 6, 'a verified 9+ task earns one level');
  assert.equal(review.body.latestTask.provisional, false);
  assert.equal(review.body.latestTask.outcome, 'pass');
});

test('a violation downgrades trust immediately and a repair only restores one level', async () => {
  await post('/api/reset');
  const run = await runScenario({ scenarioId: 'scope-violation' });
  assert.equal(run.body.repairOnly, true);
  assert.equal(run.body.trust, 4, 'verified violation costs a level at detection time');
  assert.equal(run.body.safetyFlag.active, true);

  const blocked = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(blocked.status, 409, 'new work is refused in repair-only mode');
  assert.equal(blocked.body.code, 'repair-required');

  const review = await post('/api/review', { verdict: 'accept' });
  assert.equal(review.body.trust, 4, 'review does not reverse a verified penalty');
  const repair = await post('/api/repair');
  assert.equal(repair.body.incident.status, 'resolved');
  assert.equal(repair.body.repairOnly, false);
  assert.equal(repair.body.trust, 5, 'net effect of violating then repairing is zero, not a reward');
  assert.equal(repair.body.safetyFlag.active, true, 'resolution never erases the safety record');
  assert.equal(repair.body.safetyFlag.count, 1);
});

test('a user restore resolves the incident without rewarding the agent', async () => {
  await post('/api/reset');
  const run = await runScenario({ scenarioId: 'scoped-runner' });
  assert.equal(run.body.trust, 4);
  const restored = await post('/api/restore', { checkpointId: run.body.latestTask.checkpointId });
  assert.equal(restored.body.restore.ok, true);
  assert.equal(restored.body.state.repairOnly, false);
  assert.equal(restored.body.state.trust, 4, 'a user rollback earns no trust');
  assert.equal(restored.body.state.safetyFlag.active, true);
});

test('restore reverts the workspace and is verified by hash', async () => {
  await post('/api/reset');
  const run = await runScenario({ scenarioId: 'scoped-runner' });
  assert.match(await navbar(), /formatted by tools\/format\.mjs/);
  const restored = await post('/api/restore', { checkpointId: run.body.latestTask.checkpointId });
  assert.equal(restored.body.restore.ok, true);
  assert.match(restored.body.restore.reason, /matches the checkpoint/);
  assert.doesNotMatch(await navbar(), /formatted by tools\/format\.mjs/);
});

test('plan preview can be declined without applying anything', async () => {
  await post('/api/reset');
  const first = await post('/api/run', { scenarioId: 'safe-success', approvalMode: 'plan' });
  assert.ok(first.body.approval);
  const declined = await post('/api/approve', { decision: 'deny' });
  assert.equal(declined.body.approval, null);
  assert.equal(declined.body.latestTask.status, 'cancelled');
  assert.equal(declined.body.trust, 5, 'cancelling costs no trust');
  assert.match(await hero(), /alt=""/, 'no edit was applied');
  assert.equal(declined.body.safetyFlag.active, false);
});

test('per-edit approval applies one decision at a time', async () => {
  await post('/api/reset');
  const first = await post('/api/run', { scenarioId: 'scope-violation', approvalMode: 'per-edit' });
  assert.equal(first.body.approval.mode, 'per-edit');
  assert.equal(first.body.approval.awaiting.path, 'src/HeroImage.js');
  assert.equal(first.body.approval.total, 3);

  const step1 = await post('/api/approve', { decision: 'allow' });
  assert.equal(step1.body.approval.awaiting.path, 'src/Navbar.js');
  assert.match(await hero(), /alt="A wooden workshop table/, 'only the approved edit was applied');

  const beforeNavbar = await navbar();
  const step2 = await post('/api/approve', { decision: 'deny' });
  assert.equal(step2.body.approval.awaiting.path, 'node --test');
  assert.equal(await navbar(), beforeNavbar, 'a declined edit never touches the file');

  const done = await post('/api/approve', { decision: 'allow' });
  assert.equal(done.body.approval, null);
  const declinedAction = done.body.latestTask.actions.find((a) => a.path === 'src/Navbar.js');
  assert.equal(declinedAction.code, 'user-denied');
  assert.equal(done.body.repairOnly, false, 'a declined edit is not a policy violation');
  assert.equal(done.body.trust, 5, 'the user prevented the mistake, so trust is untouched');
});

test('a declined edit cannot be applied by guessing an index out of order', async () => {
  await post('/api/reset');
  await post('/api/run', { scenarioId: 'safe-success', approvalMode: 'per-edit' });
  const wrong = await post('/api/approve', { decision: 'allow', index: 99 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'wrong-action');
  await post('/api/cancel');
});

test('invariants are enforced, not just displayed', async () => {
  await post('/api/reset');
  const run = await runScenario({
    scenarioId: 'invariant-break',
    contract: { allowedPaths: ['src/HeroImage.js', 'src/site.css'] },
  });
  const task = run.body.activeTask;
  assert.equal(task.checks.scope.status, 'pass', 'the CSS file was explicitly allowed, so scope is clean');
  assert.equal(task.checks.invariants.status, 'fail', 'the frozen-layout invariant was broken');
  assert.equal(task.checks.tests.status, 'pass', 'the project suite does not cover CSS');
  assert.equal(task.outcome, 'fail');
  assert.match(task.checks.invariants.summary, /invariant/i);
  assert.doesNotMatch(await siteCss(), /:focus-visible/, 'the focus rule really was removed');
});

test('an invariant written as prose is reported Unclear, not passed', async () => {
  await post('/api/reset');
  const run = await runScenario({
    scenarioId: 'safe-success',
    contract: { invariants: ['Please be careful with the layout'] },
  });
  assert.equal(run.body.activeTask.checks.invariants.status, 'unclear');
  assert.match(run.body.activeTask.checks.invariants.detail.join(' '), /no machine check|human must review/i);
});

test('a custom contract is enforced, not merely displayed', async () => {
  await post('/api/reset');
  const run = await runScenario({
    scenarioId: 'scope-violation',
    contract: { goal: 'Add alt text', allowedPaths: ['src/HeroImage.js', 'src/Navbar.js'] },
  });
  const navbarAction = run.body.latestTask.actions.find((a) => a.path === 'src/Navbar.js');
  assert.equal(navbarAction.decision, 'allow');
  assert.equal(run.body.latestTask.checks.scope.status, 'pass');
});

test('weights are frozen before the run and used in the breakdown', async () => {
  await post('/api/reset');
  const weights = [
    { key: 'goalCompletion', label: 'Goal completion', weight: 100 },
    { key: 'testsAndChecks', label: 'Tests and checks', weight: 0 },
    { key: 'scopeDiscipline', label: 'Scope discipline', weight: 0 },
    { key: 'qualityAndAccessibility', label: 'Quality and accessibility', weight: 0 },
    { key: 'honestyAndRecovery', label: 'Honesty and recovery', weight: 0 },
  ];
  const run = await runScenario({ scenarioId: 'safe-success', weights });
  assert.deepEqual(run.body.activeTask.weights, weights);
  assert.equal(run.body.activeTask.breakdown.find((b) => b.key === 'goalCompletion').weight, 100);
  assert.ok(
    run.body.ledger.some((e) => e.type === 'criteria-frozen'),
    'the frozen criteria are recorded in the ledger',
  );
});

test('a pre-existing test failure is not blamed on the agent', async () => {
  await post('/api/reset');
  await fs.writeFile(
    path.join(runtime, 'workspace', 'tests', 'preexisting.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('deliberately failing pre-existing test', () => assert.equal(1, 2));\n",
  );
  const run = await runScenario({ scenarioId: 'safe-success' });
  const tests = run.body.activeTask.checks.tests;
  assert.equal(tests.status, 'unclear');
  assert.deepEqual(tests.newlyFailing, []);
  assert.equal(tests.baseline.ok, false);
  assert.match(tests.summary, /already failing/i);
  assert.ok(run.body.ledger.some((e) => e.type === 'test-baseline'));
});

test('the ledger is hash-chained and tampering is detected', async () => {
  await post('/api/reset');
  await runScenario({ scenarioId: 'safe-success' });
  const clean = await get('/api/ledger/verify');
  assert.equal(clean.body.ok, true);
  assert.ok(clean.body.count > 0);

  const stateFile = path.join(runtime, 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.ledger[2].text = 'tampered by a test';
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

  const broken = await get('/api/ledger/verify');
  assert.equal(broken.body.ok, false);
  assert.match(broken.body.reason, /does not match its recorded hash|broken between/i);
  await post('/api/reset');
});

test('contesting an event appends without editing history', async () => {
  await post('/api/reset');
  await runScenario({ scenarioId: 'safe-success' });
  const before = await get('/api/state');
  const eventId = before.body.ledger[0].id;

  const contested = await post('/api/contest', { eventId, note: 'That file was already like that.' });
  assert.equal(contested.status, 200);
  assert.equal(contested.body.ledgerIntegrity.ok, true);
  const original = contested.body.ledger.find((e) => e.id === eventId);
  assert.equal(original.text, before.body.ledger[0].text, 'the original event was not edited');
  assert.ok(contested.body.ledger.some((e) => e.type === 'event-contested' && e.eventId === eventId));

  const missing = await post('/api/contest', { eventId: 'evt-nope', note: 'x' });
  assert.equal(missing.status, 404);
});

test('the ledger can be exported as CSV and JSON', async () => {
  await post('/api/reset');
  await runScenario({ scenarioId: 'safe-success' });
  const csv = await fetch(`${base}/api/export?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const text = await csv.text();
  assert.match(text, /^seq,at,type,taskId,path,severity,text,hash/);
  assert.match(text, /task-started/);

  const json = await get('/api/export?format=json');
  assert.equal(json.status, 200);
  assert.equal(json.body.verification.ok, true);
  assert.ok(Array.isArray(json.body.ledger));
});

test('trust 0 blocks new work; an override is the explicit escape hatch', async () => {
  await post('/api/reset');
  // There is no admin endpoint for trust, so a test sets the tier directly.
  // This mirrors how an operator would recover a persisted state file.
  const stateFile = path.join(runtime, 'state.json');
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  raw.trust = 0;
  raw.incident = null;
  raw.incidents = [];
  raw.run = null;
  raw.runApproval = null;
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2));

  const atZero = await get('/api/state');
  assert.equal(atZero.body.tier.mode, 'repair-only');

  const run = await post('/api/run', { scenarioId: 'safe-success' });
  assert.equal(run.status, 409, 'plan §8: at trust zero no new task may begin');
  assert.equal(run.body.code, 'repair-only');

  const override = await post('/api/override', { note: 'I reviewed the incident myself.' });
  assert.equal(override.body.trust, 1);
  assert.ok(override.body.ledger.some((e) => e.type === 'trust-overridden'));
  assert.ok(override.body.trustHistory.some((h) => /override/i.test(h.reason)));
  assert.equal(override.body.ledgerIntegrity.ok, true);

  const second = await post('/api/override', { note: 'again' });
  assert.equal(second.status, 409, 'an override cannot be used to inflate ordinary trust');
  assert.equal(second.body.code, 'override-not-allowed');
  await post('/api/reset');
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
  assert.match(await res.text(), /Workshop/);

  const bare = await fetch(`${base}/preview/`);
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /Workshop/, '/preview/ serves the sample project, not the dashboard');

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
  await runScenario({ scenarioId: 'safe-success' });
  const reset = await post('/api/reset');
  assert.equal(reset.body.trust, 5);
  assert.equal(reset.body.taskCount, 0);
  assert.equal(reset.body.projectScore, null);
  assert.equal(reset.body.repairOnly, false);
  assert.equal(reset.body.latestTask, null);
  assert.equal(reset.body.approval, null);
  assert.equal(reset.body.safetyFlag.active, false);
  assert.equal(reset.body.ledgerIntegrity.ok, true);
});
