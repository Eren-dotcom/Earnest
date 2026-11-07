import fs from 'node:fs/promises';
import path from 'node:path';
import { CHECKPOINT_DIR, SEED_DIR, WORKSPACE_DIR } from './paths.mjs';
import { copyDir, ensureDir, removeDir, listFiles } from './fsutil.mjs';
import { createCheckpoint, restoreCheckpoint } from './checkpoints.mjs';
import { executePlan, agentClaimFor, SCENARIOS, planActions } from './scenarios.mjs';
import { runChecks, diffPreview } from './verify.mjs';
import { computeTaskScore, trustDelta, applyTrust, tierFor, nextPrivilege, projectScore } from './scoring.mjs';
import { logEvent, nextId } from './store.mjs';

/** Fresh disposable workspace + checkpoint from the pristine seed. */
export async function resetWorkspace() {
  await removeDir(WORKSPACE_DIR);
  await removeDir(CHECKPOINT_DIR);
  await ensureDir(WORKSPACE_DIR);
  await ensureDir(CHECKPOINT_DIR);
  await copyDir(SEED_DIR, WORKSPACE_DIR);
  const checkpoint = await createCheckpoint('checkpoint-before-task', 'Before the demo task');
  return checkpoint;
}

/** Snapshot of the workspace used as the baseline for scope and diffs. */
export async function snapshotWorkspace() {
  const map = {};
  for (const rel of await listFiles(WORKSPACE_DIR)) {
    map[rel] = await fs.readFile(path.join(WORKSPACE_DIR, rel));
  }
  return map;
}

export async function startRun({ scenarioId, contract, state }) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioId}"`);

  if (state.incident && state.incident.status !== 'resolved') {
    const err = new Error(
      'Repair-only mode is active. Resolve the open incident by repairing or restoring before starting new work.',
    );
    err.statusCode = 409;
    err.code = 'repair-required';
    throw err;
  }
  if (state.run && state.run.status === 'running') {
    const err = new Error('A task is already running.');
    err.statusCode = 409;
    err.code = 'run-in-progress';
    throw err;
  }

  if ((await listFiles(WORKSPACE_DIR)).length === 0) {
    await resetWorkspace();
  }

  const baseline = await snapshotWorkspace();
  const checkpoint = await createCheckpoint(`checkpoint-${Date.now().toString(36)}`, `Before “${contract.goal}”`);
  const taskId = nextId('task');
  const tier = tierFor(state.trust);

  const task = {
    id: taskId,
    scenarioId,
    scenarioName: scenario.name,
    goal: contract.goal,
    contract,
    trustBefore: state.trust,
    tierBefore: tier.mode,
    tierLabel: tier.label,
    checkpointId: checkpoint.id,
    startedAt: new Date().toISOString(),
    status: 'running',
    score: null,
    outcome: null,
    checks: null,
    diff: [],
    agentClaim: '',
    actions: [],
  };

  state.tasks.unshift(task);
  if (state.tasks.length > 40) state.tasks.length = 40;
  state.run = { taskId, scenarioId, status: 'running', startedAt: task.startedAt };
  state.runBaseline = Object.fromEntries(
    Object.entries(baseline).map(([rel, buf]) => [rel, buf.toString('base64')]),
  );

  logEvent(state, {
    type: 'task-started',
    taskId,
    text: `Task started under ${tier.label} (trust ${state.trust}/10). Checkpoint ${checkpoint.id} created.`,
    severity: 'info',
  });

  const plan = await planActions(scenarioId);
  const results = await executePlan(plan, contract, state, taskId);

  const blocked = results.filter((r) => r.decision === 'deny');
  const agentClaim = agentClaimFor(scenarioId, blocked.length > 0);

  task.actions = results.map((r) => ({
    type: r.action.type,
    path: r.action.path ?? r.action.command,
    note: r.action.note,
    decision: r.decision,
    detail: r.detail,
    code: r.code ?? null,
  }));
  task.agentClaim = agentClaim;
  task.status = 'verifying';

  state.run = { ...state.run, status: 'verifying' };

  // Only this task's events may be used as evidence. The ledger is newest-first,
  // so passing the whole thing would let a later task's events change the
  // verdict on an earlier one.
  const taskLedger = state.ledger.filter((e) => e.taskId === taskId);

  const checks = await runChecks(contract, baseline, {
    agentClaim,
    ledger: taskLedger,
    review: null,
    taskId,
  });

  task.checks = checks;
  task.diff = await diffPreview(baseline);

  const incidentLedger = state.ledger.filter((e) => e.taskId === taskId);
  const severeBlock = incidentLedger.some(
    (e) => e.type === 'action-blocked' && (e.code === 'forbidden-path' || e.code === 'forbidden-action'),
  );

  const scoring = computeTaskScore(checks, { seriousViolation: severeBlock });
  task.score = scoring.score;
  task.provisional = scoring.provisional;
  task.outcome = scoring.outcome;
  task.breakdown = scoring.breakdown;
  task.seriousViolation = scoring.seriousViolation;
  task.finishedAt = new Date().toISOString();
  task.status = 'awaiting-review';

  state.run = { ...state.run, status: 'awaiting-review' };

  // An attempt that policy blocked is still an incident. Detecting the attempt
  // and then forgetting it would let the agent quietly try again next task.
  const violations = checks.scope.violations ?? [];
  const blockedOnly = violations.length > 0 && violations.every((v) => v.applied === false);

  if (violations.length || severeBlock) {
    state.incident = {
      id: nextId('incident'),
      taskId,
      status: 'open',
      severity: severeBlock ? 'critical' : 'scope',
      blocked: blockedOnly,
      summary: severeBlock
        ? 'A protected path was targeted by the agent.'
        : blockedOnly
          ? `Out-of-scope attempt blocked: ${violations.map((v) => v.file).join(', ')}. The file is unchanged.`
          : `Out-of-scope change detected: ${violations.map((v) => v.file).join(', ')}.`,
      detail: violations.map((v) => v.text),
      openedAt: new Date().toISOString(),
    };
    logEvent(state, {
      type: 'incident-opened',
      taskId,
      text: state.incident.summary,
      severity: 'critical',
    });
  }

  logEvent(state, {
    type: 'checks-complete',
    taskId,
    text: `Checks finished. Provisional score ${scoring.score}/10 (${scoring.outcome}).`,
    severity: 'info',
  });

  return { task, scoring };
}

/**
 * Record the user's review. This is what converts a provisional score into a
 * final one, because subjective quality belongs to the user, not the model.
 */
export function recordReview({ state, verdict, note }) {
  const task = state.tasks.find((t) => t.status === 'awaiting-review');
  if (!task) {
    const err = new Error('There is no task awaiting review.');
    err.statusCode = 409;
    err.code = 'no-pending-task';
    throw err;
  }

  task.review = { verdict, note: note ?? '', at: new Date().toISOString() };
  if (task.checks) {
    task.checks.human = {
      ...task.checks.human,
      status: verdict === 'accept' ? 'pass' : 'fail',
      summary: verdict === 'accept' ? 'The user accepted the result.' : 'The user rejected the result.',
      detail: [note ? `Your note: “${note}”` : 'No note was added.'],
    };
  }

  const scoring = computeTaskScore(task.checks, { seriousViolation: task.seriousViolation });
  task.score = scoring.score;
  task.breakdown = scoring.breakdown;
  task.outcome = scoring.outcome;
  task.provisional = scoring.provisional;

  const blockedSerious = task.seriousViolation;
  const hasIncident = state.incident && state.incident.taskId === task.id && state.incident.status !== 'resolved';
  const delta = trustDelta(scoring.outcome, scoring.score, {
    seriousViolation: blockedSerious,
    repair: Boolean(task.isRepair),
    scopeViolations: task.checks?.scope?.violations?.length ?? 0,
    failingChecks:
      task.checks?.tests?.status === 'fail' || task.checks?.goal?.status === 'fail',
  });

  if (!hasIncident) {
    const from = state.trust;
    const to = applyTrust(from, delta.delta);
    state.trust = to;
    task.trustAfter = to;
    if (delta.delta !== 0) {
      state.trustHistory.unshift({
        id: nextId('trust'),
        at: new Date().toISOString(),
        from,
        to,
        reason: delta.reason,
        taskId: task.id,
      });
      logEvent(state, {
        type: 'trust-changed',
        taskId: task.id,
        text: `Trust ${from} → ${to}. ${delta.reason}`,
        severity: delta.delta > 0 ? 'success' : 'warning',
      });
    } else {
      logEvent(state, { type: 'trust-held', taskId: task.id, text: delta.reason, severity: 'info' });
    }
  } else {
    task.trustAfter = state.trust;
    logEvent(state, {
      type: 'trust-held',
      taskId: task.id,
      text: 'Trust is held until the open incident is resolved. Repair or restore first.',
      severity: 'warning',
    });
  }

  task.trustReason = delta.reason;
  task.status = 'complete';
  task.completedAt = new Date().toISOString();
  state.run = state.run ? { ...state.run, status: 'complete' } : null;

  if (verdict === 'accept' && scoring.score >= 7 && scoring.outcome !== 'fail' && !task.isRepair) {
    if (!state.badges.includes('verified-work')) state.badges.push('verified-work');
  }
  if (task.isRepair && verdict === 'accept') {
    if (!state.badges.includes('clean-repair')) state.badges.push('clean-repair');
  }

  logEvent(state, {
    type: 'review-recorded',
    taskId: task.id,
    text: `You ${verdict === 'accept' ? 'accepted' : 'rejected'} the result. Final score ${task.score}/10.`,
    severity: verdict === 'accept' ? 'success' : 'warning',
  });

  return task;
}

/** Repair the open incident by fixing the workspace inside scope, then re-verifying. */
export async function repairIncident({ state }) {
  if (!state.incident || state.incident.status === 'resolved') {
    const err = new Error('There is no open incident to repair.');
    err.statusCode = 409;
    err.code = 'no-incident';
    throw err;
  }

  const task = state.tasks.find((t) => t.id === state.incident.taskId);
  if (!task) throw new Error('The incident’s task is missing.');

  const contract = task.contract;
  const baselineBufs = state.runBaseline ?? {};
  const baseline = Object.fromEntries(
    Object.entries(baselineBufs).map(([rel, b64]) => [rel, Buffer.from(b64, 'base64')]),
  );

  // Repair = revert the out-of-scope files to their pre-task contents.
  const reverted = [];
  for (const violation of task.checks?.scope?.violations ?? []) {
    const before = baseline[violation.file];
    const target = path.join(WORKSPACE_DIR, violation.file);
    if (before) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, before);
      reverted.push(violation.file);
    } else {
      await fs.rm(target, { force: true });
      reverted.push(violation.file);
    }
  }

  logEvent(state, {
    type: 'repair-applied',
    taskId: task.id,
    text: reverted.length
      ? `Repair reverted the out-of-scope change(s): ${reverted.join(', ')}.`
      : 'Repair ran; policy had already blocked the offending action so no file needed reverting.',
    severity: 'info',
  });

  const checks = await runChecks(contract, baseline, {
    agentClaim: 'Repaired the task: reverted the out-of-scope change and re-ran the checks.',
    ledger: state.ledger.filter((e) => e.taskId === task.id),
    review: task.review ?? null,
    taskId: task.id,
    includeBlockedAttempts: false,
  });

  const scoring = computeTaskScore(checks, { seriousViolation: false });
  const scopeClean = (checks.scope.violations ?? []).length === 0;

  task.checks = checks;
  task.diff = await diffPreview(baseline);
  task.score = scoring.score;
  task.breakdown = scoring.breakdown;
  task.outcome = scoring.outcome;
  task.provisional = scoring.provisional;
  task.isRepair = true;

  if (scopeClean && scoring.outcome !== 'fail') {
    state.incident = {
      ...state.incident,
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolution: `Repair verified. Reverted: ${reverted.join(', ') || 'nothing needed (action was blocked)'}.`,
    };
    const from = state.trust;
    const to = applyTrust(from, +1);
    state.trust = to;
    task.trustAfter = to;
    state.trustHistory.unshift({
      id: nextId('trust'),
      at: new Date().toISOString(),
      from,
      to,
      reason: 'A verified repair restored one trust level. The original incident remains in the ledger.',
      taskId: task.id,
    });
    logEvent(state, {
      type: 'incident-resolved',
      taskId: task.id,
      text: `Repair verified. Trust ${from} → ${to}. New tasks are allowed again.`,
      severity: 'success',
    });
    if (!state.badges.includes('clean-repair')) state.badges.push('clean-repair');
  } else {
    logEvent(state, {
      type: 'repair-failed',
      taskId: task.id,
      text: 'Repair did not clear the violation, so the incident stays open and new work remains blocked.',
      severity: 'critical',
    });
  }

  return { task, checks, scoring, incident: state.incident, reverted };
}

/** User-initiated checkpoint restore. Always available, always verified. */
export async function restore({ state, checkpointId, taskId }) {
  const result = await restoreCheckpoint(checkpointId);
  logEvent(state, {
    type: result.ok ? 'restore-verified' : 'restore-failed',
    taskId: taskId ?? null,
    text: result.ok
      ? `Workspace restored from ${checkpointId} and verified by content hash. Nothing else changed.`
      : `Restore from ${checkpointId} could not be verified: ${result.reason}`,
    severity: result.ok ? 'success' : 'critical',
  });

  if (result.ok && state.incident && state.incident.status !== 'resolved') {
    state.incident = {
      ...state.incident,
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolution: `Restored checkpoint ${checkpointId}. The incident stays on record.`,
    };
    const task = state.tasks.find((t) => t.id === state.incident.taskId);
    if (task) task.restored = true;
    logEvent(state, {
      type: 'incident-resolved',
      taskId: state.incident.taskId,
      text: 'Checkpoint restore cleared the open incident. New tasks are allowed again.',
      severity: 'success',
    });
  }

  return result;
}

export function publicState(state) {
  const task = state.tasks[0] ?? null;
  const active = state.tasks.find((t) => t.status === 'awaiting-review') ?? null;
  return {
    project: { id: state.projectId, name: state.projectName },
    trust: state.trust,
    tier: tierFor(state.trust),
    nextPrivilege: nextPrivilege(state.trust),
    projectScore: projectScore(state.tasks),
    taskCount: state.tasks.filter((t) => t.status === 'complete').length,
    badges: state.badges,
    tasks: state.tasks,
    activeTask: active,
    latestTask: task,
    incident: state.incident,
    run: state.run,
    ledger: state.ledger.slice(0, 120),
    trustHistory: state.trustHistory.slice(0, 40),
    scenarios: Object.values(SCENARIOS),
    repairOnly: Boolean(state.incident && state.incident.status !== 'resolved'),
  };
}
