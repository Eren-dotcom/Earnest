import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate the engine suite: it exercises the real workspace on disk, so it must
// never share state with a running server or with a developer's demo data.
const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'earnest-test-'));
process.env.EARNEST_RUNTIME = isolated;

const { WORKSPACE_DIR, RUNTIME_DIR } = await import('../server/lib/paths.mjs');
const { resetWorkspace, startRun, recordReview, repairIncident, restore, publicState, snapshotWorkspace } = await import(
  '../server/lib/engine.mjs'
);
const { initialState, readState, writeState } = await import('../server/lib/store.mjs');
const { DEFAULT_CONTRACT } = await import('../server/lib/contracts.mjs');
const { exists } = await import('../server/lib/fsutil.mjs');

/**
 * End-to-end engine tests. They drive real scenarios against the disposable
 * workspace, so they fail if enforcement, scoring, or recovery regress.
 */

async function freshState() {
  await resetWorkspace();
  const state = initialState();
  await writeState(state);
  return state;
}


// The suite owns its own state rather than clobbering a running server's file.
before(async () => {
  await freshState();
});

after(async () => {
  await fs.rm(isolated, { recursive: true, force: true });
});

test('safe scenario passes every check and scores highly', async () => {
  const state = await freshState();
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state });

  assert.equal(task.checks.goal.status, 'pass');
  assert.equal(task.checks.tests.status, 'pass');
  assert.equal(task.checks.scope.status, 'pass');
  assert.equal(task.checks.honesty.status, 'pass');
  assert.equal(task.checks.human.status, 'waiting', 'human review is required, not assumed');
  assert.ok(task.score >= 9, `expected a high score, got ${task.score}`);
  assert.equal(task.provisional, true, 'score is provisional until a person reviews it');
  assert.equal(state.incident, null);

  const hero = await fs.readFile(path.join(WORKSPACE_DIR, 'src/HeroImage.js'), 'utf8');
  assert.match(hero, /alt="A wooden workshop table/, 'the alt text was actually written');
});

test('out-of-scope write is blocked at the filesystem boundary', async () => {
  const state = await freshState();
  const before = await fs.readFile(path.join(WORKSPACE_DIR, 'src/Navbar.js'), 'utf8');
  const { task } = await startRun({ scenarioId: 'scope-violation', contract: DEFAULT_CONTRACT, state });

  const blocked = task.actions.find((a) => a.path === 'src/Navbar.js');
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.code, 'out-of-scope');

  const after = await fs.readFile(path.join(WORKSPACE_DIR, 'src/Navbar.js'), 'utf8');
  assert.equal(after, before, 'the protected file must be byte-identical, proving enforcement');

  assert.equal(task.checks.scope.status, 'fail', 'a blocked attempt is still a violation');
  assert.equal(task.checks.honesty.status, 'fail', 'an undisclosed attempt is dishonest');
  assert.ok(state.incident, 'an incident is opened');
  assert.equal(state.incident.blocked, true);
});

test('an open incident blocks new work until it is resolved', async () => {
  const state = await freshState();
  await startRun({ scenarioId: 'scope-violation', contract: DEFAULT_CONTRACT, state });

  await assert.rejects(
    () => startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state }),
    (error) => error.code === 'repair-required',
  );
});

test('repair resolves the incident and restores one trust level', async () => {
  const state = await freshState();
  await startRun({ scenarioId: 'scoped-runner', contract: DEFAULT_CONTRACT, state });
  recordReview({ state, verdict: 'accept', note: 'Looks right apart from the extra edit.' });

  const trustAfterReview = state.trust;
  const result = await repairIncident({ state });

  assert.equal(result.incident.status, 'resolved');
  assert.equal(state.trust, Math.min(10, trustAfterReview + 1));
  assert.ok(state.trustHistory.some((h) => /verified repair/i.test(h.reason)));
  assert.ok(
    state.ledger.some((e) => e.type === 'incident-resolved'),
    'the resolution is on the record',
  );

  const navbar = await fs.readFile(path.join(WORKSPACE_DIR, 'src/Navbar.js'), 'utf8');
  assert.doesNotMatch(navbar, /formatted by tools\/format\.mjs/, 'the out-of-scope change was reverted');

  // New work is possible again once the incident is resolved.
  const next = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state });
  assert.ok(next.task.id);
});

test('checkpoint restore reverts the workspace and is verified by hash', async () => {
  const state = await freshState();
  const snapshot = await snapshotWorkspace();
  const { task } = await startRun({ scenarioId: 'scoped-runner', contract: DEFAULT_CONTRACT, state });

  const restored = await restore({ state, checkpointId: task.checkpointId, taskId: task.id });
  assert.equal(restored.ok, true);

  const now = await snapshotWorkspace();
  assert.deepEqual(
    Object.keys(now).sort(),
    Object.keys(snapshot).sort(),
    'the same files exist after restore',
  );
  for (const [rel, buf] of Object.entries(snapshot)) {
    assert.ok(now[rel].equals(buf), `${rel} was restored byte-for-byte`);
  }
  assert.equal(state.incident.status, 'resolved');
});

test('the agent claim is checked against evidence, not trusted', async () => {
  const state = await freshState();
  const { task } = await startRun({ scenarioId: 'test-breakage', contract: DEFAULT_CONTRACT, state });

  const { runCommandInWorkspace } = await import('../server/lib/commands.mjs');
  const raw = await runCommandInWorkspace('node --test');
  console.error('RAW', JSON.stringify({ code: raw.code, out: raw.stdout.slice(0, 500), err: raw.stderr.slice(0, 400) }));

  assert.equal(task.checks.tests.status, 'fail');
  assert.equal(task.checks.honesty.status, 'fail', 'claiming all tests pass while they fail is dishonest');
  assert.match(task.checks.honesty.detail.join(' '), /claimed all checks passed|contradict/i);
});

test('trust only moves after a review, and a rejecting user does not reward the agent', async () => {
  const state = await freshState();
  await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state });
  assert.equal(state.trust, 5, 'trust is untouched while review is pending');

  recordReview({ state, verdict: 'reject', note: 'The alt text is too vague for this image.' });
  assert.ok(state.trust < 5, 'a rejected result must not earn trust');
});

test('public state exposes what the UI needs and nothing secret', async () => {
  const state = await freshState();
  await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state });
  const pub = publicState(state);

  assert.ok(pub.tier.description);
  assert.ok(pub.nextPrivilege.detail);
  assert.ok(Array.isArray(pub.scenarios));
  assert.ok(pub.latestTask.breakdown.length === 5);
  assert.equal(typeof pub.trust, 'number');
});

test('workspace is reset from the pristine seed, not from a dirty copy', async () => {
  await freshState();
  await fs.writeFile(path.join(WORKSPACE_DIR, 'src/HeroImage.js'), 'corrupted');
  await resetWorkspace();
  const hero = await fs.readFile(path.join(WORKSPACE_DIR, 'src/HeroImage.js'), 'utf8');
  assert.match(hero, /alt=""/, 'reset restores the original, unfinished hero component');
});

test('state survives a round trip through disk', async () => {
  const state = await freshState();
  await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state });
  await writeState(state);
  const reloaded = await readState();
  assert.equal(reloaded.tasks.length, state.tasks.length);
  assert.ok(await exists(path.join(RUNTIME_DIR, 'state.json')));
});
