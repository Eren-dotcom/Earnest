import { STATUS } from './verify.mjs';

/**
 * Scoring.
 *
 * Two numbers are produced and they are deliberately never merged:
 *   - the final task score (1-10) for one task
 *   - the project trust level (0-10) that controls permissions
 *
 * Trust only moves on a *verified* result. An `unclear` outcome leaves trust
 * alone, because ambiguity is not proof of agent fault.
 */

export const DIMENSIONS = [
  { key: 'goalCompletion', label: 'Goal completion', weight: 30 },
  { key: 'testsAndChecks', label: 'Tests and checks', weight: 25 },
  { key: 'scopeDiscipline', label: 'Scope discipline', weight: 20 },
  { key: 'qualityAndAccessibility', label: 'Quality and accessibility', weight: 15 },
  { key: 'honestyAndRecovery', label: 'Honesty and recovery', weight: 10 },
];

/**
 * Rating per check status. A `waiting` check has no rating at all, which is
 * what makes the score provisional -- it must never be treated as a zero.
 */
const RATING = {
  [STATUS.pass]: 10,
  [STATUS.unclear]: 5,
  [STATUS.fail]: 2,
  [STATUS.waiting]: null,
};

function ratingFor(status) {
  const value = RATING[status];
  return value === undefined ? null : value;
}

export const TRUST_TIERS = [
  {
    min: 8,
    max: 10,
    mode: 'wider-approved',
    label: 'Wider approved scope',
    description:
      'Reversible edits inside a larger approved scope can be applied without a prompt. Every change still runs the checks afterwards.',
  },
  {
    min: 5,
    max: 7,
    mode: 'limited',
    label: 'Limited scope, preview first',
    description: 'Edits are allowed in the approved scope, and you see a preview before changes are applied.',
  },
  {
    min: 1,
    max: 4,
    mode: 'one-at-a-time',
    label: 'One change at a time',
    description: 'Each individual edit needs your approval before the agent may apply it.',
  },
  {
    min: 0,
    max: 0,
    mode: 'repair-only',
    label: 'Repair-only',
    description: 'The agent may inspect, repair, or roll back the current task. It may not start new work.',
  },
];

export function tierFor(trust) {
  const clamped = Math.max(0, Math.min(10, trust));
  return TRUST_TIERS.find((t) => clamped >= t.min && clamped <= t.max);
}

export function permissionModeFor(trust) {
  return tierFor(trust).mode;
}

/** Next privilege the agent could earn, and what it would take. */
export function nextPrivilege(trust) {
  if (trust >= 8) {
    return {
      earned: true,
      label: 'Highest tier reached',
      detail: 'Deployment, deletion, spending, and external actions stay behind hard approval gates even at 10/10.',
    };
  }
  const target = trust < 5 ? 5 : trust < 8 ? 8 : 10;
  return {
    earned: false,
    label: tierFor(target).label,
    detail:
      trust < 5
        ? `A verified task scoring 9 or above, with no unresolved violation, returns ${trust} → ${trust + 1}. Reach 5 to leave one-change-at-a-time mode.`
        : `Verified tasks scoring 9+ raise trust by 1. ${target - trust} more to unlock "${tierFor(target).label}".`,
  };
}

/**
 * Turn check results into dimension ratings.
 * Human review replaces the automated accessibility estimate when present,
 * because a person can judge what an automated scan cannot.
 */
export function rateDimensions(checks) {
  const ratings = {};

  ratings.goalCompletion = {
    rating: ratingFor(checks.goal.status),
    evidence: checks.goal.summary,
    checkId: 'goal',
  };

  ratings.testsAndChecks = {
    rating: ratingFor(checks.tests.status),
    evidence: checks.tests.summary,
    checkId: 'tests',
  };

  const violations = checks.scope.violations ?? [];
  // One out-of-scope change already hurts; repeated ones collapse the rating.
  const scopeRating = violations.length === 0 ? 10 : Math.max(0, 10 - 5 * violations.length);
  ratings.scopeDiscipline = {
    rating: scopeRating,
    evidence: checks.scope.summary,
    checkId: 'scope',
  };

  const a11yFailed = (checks.accessibility.subchecks ?? []).some((s) => s.status === STATUS.fail);
  let qualityRating = a11yFailed ? 4 : 8;
  let qualityEvidence = checks.accessibility.summary;

  if (checks.human.status === STATUS.pass) {
    qualityRating = a11yFailed ? 5 : 10;
    qualityEvidence = `${checks.accessibility.summary} You accepted the result.`;
  } else if (checks.human.status === STATUS.fail) {
    qualityRating = 3;
    qualityEvidence = 'You rejected the result, so quality cannot be credited.';
  } else {
    qualityEvidence = `${checks.accessibility.summary} Your review is still pending, so this dimension is not final.`;
  }

  ratings.qualityAndAccessibility = {
    rating: qualityRating,
    evidence: qualityEvidence,
    checkId: 'a11y',
  };

  ratings.honestyAndRecovery = {
    rating: ratingFor(checks.honesty.status),
    evidence: checks.honesty.summary,
    checkId: 'honesty',
  };

  return ratings;
}

export function computeTaskScore(checks, { seriousViolation = false } = {}) {
  const ratings = rateDimensions(checks);
  const reviewPending = checks.human?.status === STATUS.waiting;

  const breakdown = DIMENSIONS.map((dim) => {
    const entry = ratings[dim.key];
    const rating = entry.rating;
    const weighted = rating === null ? null : (rating * dim.weight) / 100;
    return {
      key: dim.key,
      label: dim.label,
      weight: dim.weight,
      rating,
      weighted,
      evidence: entry.evidence,
      checkId: entry.checkId,
    };
  });

  // Weighted ratings are 0-10 by construction (rating x weight / 100 summed over
  // a total weight of 100). When a dimension is not yet scored, renormalise by
  // the weight that actually contributed instead of silently scoring it zero.
  const scored = breakdown.filter((b) => b.weighted !== null);
  const weightSum = scored.reduce((sum, b) => sum + b.weight, 0);
  let raw = weightSum ? (scored.reduce((sum, b) => sum + b.weighted, 0) * 100) / weightSum : 0;

  // A task is provisional when any dimension is unrated, or when the user has
  // not yet reviewed a result that automation cannot fully judge.
  const pendingReview = breakdown.some((b) => b.weighted === null) || reviewPending;
  const hasUnclear = breakdown.some((b) => b.rating === 5);

  if (seriousViolation) raw = Math.min(raw, 1);

  const score = Math.max(1, Math.min(10, Math.round(raw * 10) / 10));

  // A user rejection is a failed review, not a matter of taste that scoring
  // can average away: the task did not deliver what the user needed.
  const outcome = seriousViolation
    ? 'fail'
    : checks.goal.status === STATUS.fail ||
        checks.scope.status === STATUS.fail ||
        checks.tests.status === STATUS.fail ||
        checks.honesty.status === STATUS.fail ||
        checks.human.status === STATUS.fail
      ? 'fail'
      : pendingReview || hasUnclear
        ? 'unclear'
        : 'pass';

  return {
    score,
    rawScore: Math.round(raw * 10) / 10,
    breakdown,
    outcome,
    provisional: pendingReview || hasUnclear,
    seriousViolation,
    dimensionsUnclear: breakdown.filter((b) => b.rating === 5).map((b) => b.label),
    awaitingReview: reviewPending,
  };
}

/**
 * Trust delta for a completed task, following the agreed table.
 *
 * Two deliberate rules sit on top of the score bands:
 *   - a serious policy violation always overrides the average, and
 *   - an out-of-scope violation can never earn trust, however high the score,
 *     because the score measures one task while trust is about reliability.
 */
export function trustDelta(
  outcome,
  score,
  { seriousViolation = false, repair = false, scopeViolations = 0, failingChecks = false } = {},
) {
  if (seriousViolation) {
    return { delta: -3, reason: 'A serious policy violation forces an immediate restriction, independent of the average score.' };
  }
  if (repair) {
    return { delta: +1, reason: 'A verified repair restores up to one level. The original incident stays in the ledger.' };
  }
  if (outcome === 'fail') {
    return {
      delta: -1,
      reason: 'A check on this task failed or the agent’s report was contradicted, so trust drops one level.',
    };
  }
  if (failingChecks) {
    return {
      delta: -1,
      reason: 'A check failed on this task, so trust drops one level and the result requires correction.',
    };
  }
  if (outcome === 'unclear') {
    return { delta: 0, reason: 'The result is unclear, so trust is unchanged. Ambiguity is not treated as agent fault.' };
  }
  if (scopeViolations > 0) {
    return {
      delta: -1,
      reason: `The agent broke the agreed scope ${scopeViolations === 1 ? 'once' : `${scopeViolations} times`}, so this task cannot earn trust regardless of its score.`,
    };
  }
  if (score >= 9) return { delta: +1, reason: 'Verified work that scored 9.0 or above and stayed in scope earns +1 trust.' };
  if (score >= 7) return { delta: 0, reason: 'A score between 7.0 and 8.9 keeps trust steady and earns a process badge only.' };
  if (score >= 4) return { delta: -1, reason: 'A score between 4.0 and 6.9 costs one trust level and requires correction.' };
  return { delta: -2, reason: 'A score below 4.0 costs two trust levels and narrows permissions.' };
}

export function applyTrust(current, delta) {
  return Math.max(0, Math.min(10, current + delta));
}

export function projectScore(tasks) {
  const scored = tasks.filter((t) => typeof t.score === 'number' && !t.provisional);
  if (!scored.length) return null;
  const avg = scored.reduce((sum, t) => sum + t.score, 0) / scored.length;
  return Math.round(avg * 10) / 10;
}
