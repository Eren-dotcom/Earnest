import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeTaskScore, trustDelta, applyTrust, tierFor, DIMENSIONS, projectScore } from '../server/lib/scoring.mjs';

const pass = (id, dimension) => ({ id, dimension, status: 'pass', summary: 'ok', detail: [] });
const fail = (id, dimension) => ({ id, dimension, status: 'fail', summary: 'bad', detail: [] });
const unclear = (id, dimension) => ({ id, dimension, status: 'unclear', summary: '?', detail: [] });

function checks({ goal = 'pass', tests = 'pass', scope = 'pass', honesty = 'pass', review = 'pass', violations = 0 } = {}) {
  const make = (status, id, dimension) =>
    status === 'pass' ? pass(id, dimension) : status === 'fail' ? fail(id, dimension) : unclear(id, dimension);
  return {
    goal: make(goal, 'goal', 'goalCompletion'),
    tests: make(tests, 'tests', 'testsAndChecks'),
    scope: { ...make(scope, 'scope', 'scopeDiscipline'), violations: Array.from({ length: violations }, (_, i) => ({ file: `f${i}.js`, applied: true })) },
    accessibility: {
      id: 'a11y',
      dimension: 'qualityAndAccessibility',
      status: 'unclear',
      summary: 'automated only',
      detail: [],
      subchecks: [{ status: 'pass' }, { status: 'pass' }],
    },
    honesty: make(honesty, 'honesty', 'honestyAndRecovery'),
    human: make(review, 'review', 'qualityAndAccessibility'),
  };
}

test('dimension weights total 100', () => {
  assert.equal(DIMENSIONS.reduce((sum, d) => sum + d.weight, 0), 100);
});

test('a clean, fully verified task scores 10', () => {
  const result = computeTaskScore(checks());
  assert.equal(result.score, 10);
  assert.equal(result.outcome, 'pass');
});

test('weights drive the score: tests failing costs exactly 25%', () => {
  const full = computeTaskScore(checks());
  const broken = computeTaskScore({ ...checks(), tests: fail('tests', 'testsAndChecks') });
  // 10 -> rating 2 on a 25% dimension drops the raw score by 2.0 points.
  assert.equal(full.rawScore - broken.rawScore, 2);
});

test('a failing test suite marks the task as failed even with high quality', () => {
  const result = computeTaskScore({ ...checks(), tests: fail('tests', 'testsAndChecks') });
  assert.equal(result.outcome, 'fail');
});

test('out-of-scope violations collapse the scope rating progressively', () => {
  const one = computeTaskScore(checks({ violations: 1 }));
  const two = computeTaskScore(checks({ violations: 2 }));
  assert.ok(one.breakdown.find((b) => b.key === 'scopeDiscipline').rating < 10);
  assert.ok(
    two.breakdown.find((b) => b.key === 'scopeDiscipline').rating <
      one.breakdown.find((b) => b.key === 'scopeDiscipline').rating,
  );
});

test('honesty failure marks the outcome as fail', () => {
  const result = computeTaskScore({ ...checks(), honesty: fail('honesty', 'honestyAndRecovery') });
  assert.equal(result.outcome, 'fail');
});

test('a serious violation forces the score to the floor', () => {
  const result = computeTaskScore(checks(), { seriousViolation: true });
  assert.equal(result.score, 1);
  assert.equal(result.outcome, 'fail');
});

test('pending human review produces a provisional score, never a silent final one', () => {
  const result = computeTaskScore({ ...checks(), human: { id: 'review', dimension: 'qualityAndAccessibility', status: 'waiting', summary: 'waiting', detail: [] } });
  assert.equal(result.provisional, true);
});

test('scores stay clamped to 1-10', () => {
  const terrible = computeTaskScore({
    goal: fail('goal', 'goalCompletion'),
    tests: fail('tests', 'testsAndChecks'),
    scope: { ...fail('scope', 'scopeDiscipline'), violations: [{ file: 'a', applied: true }] },
    accessibility: { id: 'a11y', dimension: 'qualityAndAccessibility', status: 'fail', summary: 'bad', detail: [], subchecks: [{ status: 'fail' }] },
    honesty: fail('honesty', 'honestyAndRecovery'),
    human: { id: 'review', dimension: 'qualityAndAccessibility', status: 'fail', summary: 'no', detail: [] },
  });
  assert.ok(terrible.score >= 1);
  assert.ok(terrible.score <= 10);
});

test('trust: verified 9+ earns +1', () => {
  assert.equal(trustDelta('pass', 9.5).delta, 1);
});

test('trust: a scope violation can never earn trust, however high the score', () => {
  const delta = trustDelta('pass', 10, { scopeViolations: 1 });
  assert.ok(delta.delta < 0);
});

test('trust: a failed check costs a level', () => {
  assert.ok(trustDelta('fail', 8, { failingChecks: true }).delta < 0);
});

test('trust: unclear results leave trust alone', () => {
  assert.equal(trustDelta('unclear', 5).delta, 0);
});

test('trust: serious violations override a high average', () => {
  assert.ok(trustDelta('pass', 9.9, { seriousViolation: true }).delta < 0);
});

test('trust: repair restores at most one level', () => {
  assert.equal(trustDelta('pass', 10, { repair: true }).delta, 1);
});

test('trust is clamped to 0-10', () => {
  assert.equal(applyTrust(0, -3), 0);
  assert.equal(applyTrust(10, +2), 10);
});

test('permission tiers follow the agreed boundaries', () => {
  assert.equal(tierFor(0).mode, 'repair-only');
  assert.equal(tierFor(1).mode, 'one-at-a-time');
  assert.equal(tierFor(4).mode, 'one-at-a-time');
  assert.equal(tierFor(5).mode, 'limited');
  assert.equal(tierFor(7).mode, 'limited');
  assert.equal(tierFor(8).mode, 'wider-approved');
  assert.equal(tierFor(10).mode, 'wider-approved');
});

test('project score averages completed tasks and ignores provisional ones', () => {
  const avg = projectScore([
    { score: 10, provisional: false },
    { score: 8, provisional: false },
    { score: 1, provisional: true },
  ]);
  assert.equal(avg, 9);
});
