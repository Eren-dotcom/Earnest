import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Unit tests for the features added after the first prototype: frozen weights,
 * approval tiers, the check registry, and the hash-chained ledger.
 *
 * Every server module is imported dynamically *after* EARNEST_RUNTIME is set:
 * paths.mjs resolves the workspace at import time, and a static import would
 * be evaluated first and point at the developer's live demo workspace.
 */

const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'earnest-features-'));
process.env.EARNEST_RUNTIME = isolated;

const { defaultWeights, normalizeWeights, DIMENSIONS, computeTaskScore } = await import('../server/lib/scoring.mjs');
const { approvalModeFor, DEFAULT_CONTRACT } = await import('../server/lib/contracts.mjs');
const { initialState, logEvent, verifyLedger, resetLedger, eventHash, ZERO_HASH } = await import('../server/lib/store.mjs');
const { CHECK_TYPES, runCheckSpec, verifyInvariants, verifyGoal } = await import('../server/lib/verify.mjs');
const { WORKSPACE_DIR } = await import('../server/lib/paths.mjs');

before(async () => {
  await fs.mkdir(path.join(WORKSPACE_DIR, 'src'), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_DIR, 'src', 'site.css'), '.nav__link:focus-visible { outline: 3px solid; }\n');
  await fs.writeFile(path.join(WORKSPACE_DIR, 'src', 'Navbar.js'), '<nav aria-label="Primary"><a class="nav__link">home</a></nav>\n');
  await fs.writeFile(path.join(WORKSPACE_DIR, 'src', 'HeroImage.js'), '<img class="hero__image" alt="">\n');
});

after(async () => {
  await fs.rm(isolated, { recursive: true, force: true });
});

/* ------------------------------------------------------------- weights */

test('default weights total 100 and are copied, not shared', () => {
  const weights = defaultWeights();
  assert.equal(weights.reduce((sum, w) => sum + w.weight, 0), 100);
  weights[0].weight = 999;
  assert.equal(DIMENSIONS[0].weight, 30, 'mutating a frozen copy cannot change the defaults');
});

test('custom weights are accepted only when complete and valid', () => {
  const custom = DIMENSIONS.map((d) => ({ key: d.key, weight: d.key === 'goalCompletion' ? 100 : 0 }));
  const result = normalizeWeights(custom);
  assert.equal(result.find((r) => r.key === 'goalCompletion').weight, 100);
  assert.equal(result.find((r) => r.key === 'testsAndChecks').weight, 0);
});

test('malformed weights fall back to the defaults', () => {
  for (const bad of [null, [], [{ key: 'goalCompletion', weight: 10 }], DIMENSIONS.map((d) => ({ key: d.key, weight: -1 }))]) {
    assert.deepEqual(normalizeWeights(bad), defaultWeights());
  }
});

test('frozen weights actually change the score', () => {
  const checks = {
    goal: { id: 'goal', dimension: 'goalCompletion', status: 'pass', summary: 'ok', detail: [] },
    tests: { id: 'tests', dimension: 'testsAndChecks', status: 'fail', summary: 'bad', detail: [] },
    scope: { id: 'scope', dimension: 'scopeDiscipline', status: 'pass', summary: 'ok', detail: [], violations: [] },
    accessibility: {
      id: 'a11y', dimension: 'qualityAndAccessibility', status: 'unclear', summary: '?', detail: [],
      subchecks: [{ status: 'pass' }],
    },
    honesty: { id: 'honesty', dimension: 'honestyAndRecovery', status: 'pass', summary: 'ok', detail: [] },
    human: { id: 'review', dimension: 'qualityAndAccessibility', status: 'pass', summary: 'ok', detail: [] },
  };
  const defaultResult = computeTaskScore(checks);
  const goalOnly = computeTaskScore(checks, {
    weights: DIMENSIONS.map((d) => ({ key: d.key, weight: d.key === 'goalCompletion' ? 100 : 0 })),
  });
  assert.ok(goalOnly.score > defaultResult.score, 'weights frozen for the task drive its score');
  assert.equal(goalOnly.breakdown.find((b) => b.key === 'goalCompletion').weight, 100);
});

/* ---------------------------------------------------------- approval tiers */

test('approval mode follows the trust tier boundaries', () => {
  assert.equal(approvalModeFor(0), 'per-edit');
  assert.equal(approvalModeFor(1), 'per-edit');
  assert.equal(approvalModeFor(4), 'per-edit');
  assert.equal(approvalModeFor(5), 'plan');
  assert.equal(approvalModeFor(7), 'plan');
  assert.equal(approvalModeFor(8), 'auto');
  assert.equal(approvalModeFor(10), 'auto');
});

/* ------------------------------------------------------------ check registry */

test('the registry exposes machine-checkable rule types', () => {
  for (const type of ['alt-text-present', 'text-contains', 'file-unchanged', 'regex-present', 'regex-absent', 'element-count', 'aria-attribute']) {
    assert.ok(CHECK_TYPES[type], `${type} is registered`);
  }
});

test('an unknown rule is Unclear, never a pass', async () => {
  const result = await runCheckSpec({ type: 'not-a-real-check', label: 'Mystery' });
  assert.equal(result.status, 'unclear');
  assert.match(result.note, /no machine check|human must review/i);
});

test('file-unchanged compares against the pre-task baseline', async () => {
  const baseline = {
    'src/site.css': Buffer.from('.nav__link:focus-visible { outline: 3px solid; }\n'),
  };
  const unchanged = await runCheckSpec({ type: 'file-unchanged', file: 'src/site.css' }, { baseline });
  assert.equal(unchanged.status, 'pass');

  const changed = await runCheckSpec(
    { type: 'file-unchanged', file: 'src/site.css' },
    { baseline: { 'src/site.css': Buffer.from('different content\n') } },
  );
  assert.equal(changed.status, 'fail');
});

test('regex-present, regex-absent, element-count and aria-attribute work', async () => {
  assert.equal((await runCheckSpec({ type: 'regex-present', file: 'src/Navbar.js', pattern: 'aria-label="Primary"' })).status, 'pass');
  assert.equal((await runCheckSpec({ type: 'regex-present', file: 'src/Navbar.js', pattern: 'onclick=' })).status, 'fail');
  assert.equal((await runCheckSpec({ type: 'regex-absent', file: 'src/Navbar.js', pattern: 'onclick=' })).status, 'pass');
  assert.equal((await runCheckSpec({ type: 'element-count', file: 'src/Navbar.js', pattern: '<a\\s', min: 1, max: 1 })).status, 'pass');
  assert.equal((await runCheckSpec({ type: 'element-count', file: 'src/Navbar.js', pattern: '<a\\s', min: 3, max: 5 })).status, 'fail');
  assert.equal((await runCheckSpec({ type: 'aria-attribute', file: 'src/Navbar.js', name: 'label' })).status, 'pass');
  assert.equal((await runCheckSpec({ type: 'aria-attribute', file: 'src/Navbar.js', name: 'live' })).status, 'fail');
});

test('an invalid regex is reported as Unclear, not silently passed', async () => {
  const result = await runCheckSpec({ type: 'regex-present', file: 'src/Navbar.js', pattern: '([unclosed' });
  assert.equal(result.status, 'unclear');
});

test('invariants aggregate into a real verifier result', async () => {
  const contract = {
    invariants: [
      { id: 'a', label: 'Layout unchanged', type: 'file-unchanged', file: 'src/site.css', enabled: true },
      { id: 'b', label: 'Prose rule', type: 'manual', enabled: true },
      { id: 'c', label: 'Switched off', type: 'file-unchanged', file: 'index.html', enabled: false },
    ],
  };
  const baseline = { 'src/site.css': Buffer.from('.nav__link:focus-visible { outline: 3px solid; }\n') };
  const result = await verifyInvariants(contract, { baseline });
  assert.equal(result.status, 'unclear', 'a prose rule prevents a confident pass');
  assert.equal(result.subchecks.length, 3);
  assert.match(result.detail.join(' '), /not enforced/i);

  const strict = await verifyInvariants({ invariants: [contract.invariants[0]] }, { baseline });
  assert.equal(strict.status, 'pass');
  assert.equal(strict.violations.length, 0);
});

test('a broken invariant produces violations the scorer can use', async () => {
  const result = await verifyInvariants(
    { invariants: [{ id: 'a', label: 'Layout unchanged', type: 'file-unchanged', file: 'src/site.css' }] },
    { baseline: { 'src/site.css': Buffer.from('original layout\n') } },
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.violations.length, 1);
  assert.match(result.summary, /broken/i);
});

test('the default contract invariants are all machine-checkable', () => {
  for (const invariant of DEFAULT_CONTRACT.invariants) {
    assert.ok(CHECK_TYPES[invariant.type], `${invariant.type} used by "${invariant.label}" is registered`);
  }
});

test('verifyGoal uses the registry and reports the subchecks', async () => {
  const result = await verifyGoal({ acceptanceChecks: [{ type: 'alt-text-present', file: 'src/HeroImage.js', minLength: 12 }] }, {});
  assert.equal(result.status, 'fail');
  assert.equal(result.subchecks.length, 1);
  assert.match(result.detail.join(' '), /empty alt/i);
});

/* ------------------------------------------------------- hash-chained ledger */

test('an empty ledger starts at the zero hash', () => {
  const state = initialState();
  assert.equal(state.ledgerHead, ZERO_HASH);
  assert.equal(verifyLedger(state).ok, true);
});

test('each event links to the previous one', () => {
  const state = initialState();
  const a = logEvent(state, { type: 'first', text: 'one' });
  const b = logEvent(state, { type: 'second', text: 'two' });
  assert.equal(b.prevHash, a.hash);
  assert.equal(state.ledgerHead, b.hash);
  assert.equal(verifyLedger(state).ok, true);
  assert.equal(verifyLedger(state).count, 2);
});

test('editing a historical event breaks verification', () => {
  const state = initialState();
  logEvent(state, { type: 'first', text: 'one' });
  logEvent(state, { type: 'second', text: 'two' });
  logEvent(state, { type: 'third', text: 'three' });
  state.ledger[2].text = 'tampered';
  const result = verifyLedger(state);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match its recorded hash/i);
});

test('deleting an event breaks the chain even if hashes are recomputed', () => {
  const state = initialState();
  logEvent(state, { type: 'first', text: 'one' });
  logEvent(state, { type: 'second', text: 'two' });
  logEvent(state, { type: 'third', text: 'three' });
  state.ledger.splice(1, 1); // remove the middle event
  assert.equal(verifyLedger(state).ok, false);
});

test('eventHash is stable across key order', () => {
  assert.equal(
    eventHash({ a: 1, b: 2, prevHash: ZERO_HASH }),
    eventHash({ prevHash: ZERO_HASH, b: 2, a: 1 }),
  );
});

test('old events are archived, not silently dropped', () => {
  const state = initialState();
  for (let i = 0; i < 410; i += 1) logEvent(state, { type: 'tick', text: `event ${i}` });
  assert.equal(state.ledger.length, 400);
  assert.equal(state.ledgerArchive.length, 10);
  assert.equal(verifyLedger(state).ok, true, 'the chain survives archiving');
  assert.equal(verifyLedger(state).count, 410);
});

test('resetLedger starts a new chain', () => {
  const state = initialState();
  logEvent(state, { type: 'first', text: 'one' });
  resetLedger(state);
  assert.equal(state.ledgerHead, ZERO_HASH);
  assert.equal(state.ledger.length, 0);
  logEvent(state, { type: 'fresh', text: 'after reset' });
  assert.equal(verifyLedger(state).ok, true);
  assert.equal(verifyLedger(state).count, 1);
});
