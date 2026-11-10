import fs from 'node:fs/promises';
import path from 'node:path';
import { CHECKPOINT_DIR, SEED_DIR, WORKSPACE_DIR } from './paths.mjs';
import { copyDir, ensureDir, removeDir, listFiles } from './fsutil.mjs';
import { createCheckpoint, restoreCheckpoint } from './checkpoints.mjs';
import { executePlan, agentClaimFor, SCENARIOS, planActions } from './scenarios.mjs';
import { runChecks, diffPreview, captureTestBaseline } from './verify.mjs';
import {
  computeTaskScore,
  trustDelta,
  applyTrust,
  tierFor,
  nextPrivilege,
  projectScore,
  normalizeWeights,
} from './scoring.mjs';
import { logEvent, nextId, verifyLedger } from './store.mjs';
import { createOtariClient, createBudget, otariStatus } from './otari.mjs';
import { authorize } from './policy.mjs';

/* ---------------- Otari live path (additive; scripted runs unchanged) ---------------- */

function proposedPaths(text) {
  return [...new Set(String(text ?? '').match(/(?:src|tests)\/[A-Za-z0-9_.\/-]+|index\.html/g) ?? [])];
}

function logOtariAttempts(state, taskId, attempts) {
  for (const a of attempts ?? []) {
    logEvent(state, {
      type: 'otari-attempt',
      taskId,
      model: a.model, role: a.role, fallback: Boolean(a.fallback),
      usage: a.usage ?? null, costUsd: a.costUsd ?? 0, ms: a.ms ?? null,
      text: `Otari: ${a.role} ${a.model}${a.fallback ? ' (fallback)' : ''} — ${a.ok ? `ok in ${a.ms} ms, ${a.usage?.total_tokens ?? (a.usage?.prompt_tokens ?? 0) + (a.usage?.completion_tokens ?? 0)} tokens, $${(a.costUsd ?? 0).toFixed(4)} (estimated price)` : `failed: ${a.error}`}`,
      severity: a.ok ? 'success' : 'warning',
    });
  }
}

/**
 * Planner proposes, auditor independently audits — both only via Otari.
 * Model output proposing a write outside the frozen contract is refused
 * before execution (guardrail-block) using the existing policy authorizer.
 * Deterministic checks still decide the score; models never override them.
 */
export async function runLiveOtari({ state, task, contract, client, userId = 'default' }) {
  const base = { ...otariStatus(client), attempts: [], outputs: {}, guardrailBlocks: [], receipt: client.budget.receipt() };
  task.otari = base;
  if (!client.isConfigured()) {
    logEvent(state, {
      type: 'otari-not-configured', taskId: task.id,
      text: 'Otari: not configured — set OTARI_API_KEY to enable live models. No live model call was made; the deterministic scenario runs unchanged.',
      severity: 'warning',
    });
    return base;
  }
  const guardrailCheck = (role, content) => {
    for (const p of proposedPaths(content)) {
      const verdict = authorize({ type: 'write', path: p }, contract);
      if (verdict.decision === 'deny') {
        const block = { role, path: p, code: verdict.code, reason: verdict.reason };
        base.guardrailBlocks.push(block);
        logEvent(state, {
          type: 'guardrail-block', taskId: task.id, path: p, code: verdict.code,
          text: `Guardrail block: ${role} model proposed writing ${p}, refused before execution. ${verdict.reason}`,
          severity: verdict.code === 'out-of-scope' ? 'warning' : 'critical',
        });
      }
    }
  };
  try {
    const planner = await client.chat({
      role: 'planner', userId,
      messages: [
        { role: 'system', content: 'You are the planner for a coding task. Propose a short plan naming the files you would write. Stay inside the frozen contract scope.' },
        { role: 'user', content: `Goal: ${contract.goal}\nApproved files: ${(contract.allowedPaths ?? []).join(', ')}\nPropose the plan.` },
      ],
    });
    base.attempts.push(...planner.attempts);
    logOtariAttempts(state, task.id, planner.attempts);
    base.outputs.planner = { model: planner.model, content: planner.content, usage: planner.usage, costUsd: planner.costUsd };
    guardrailCheck('planner', planner.content);

    const auditor = await client.chat({
      role: 'auditor', userId,
      messages: [
        { role: 'system', content: 'You are an independent auditor from a different model family. Audit the plan against the frozen contract. Name any file outside the approved scope.' },
        { role: 'user', content: `Goal: ${contract.goal}\nApproved files: ${(contract.allowedPaths ?? []).join(', ')}\nPlanner (${planner.model}) proposed:\n${planner.content}\nAudit it.` },
      ],
    });
    base.attempts.push(...auditor.attempts);
    logOtariAttempts(state, task.id, auditor.attempts);
    base.outputs.auditor = { model: auditor.model, content: auditor.content, usage: auditor.usage, costUsd: auditor.costUsd };
    guardrailCheck('auditor', auditor.content);
  } catch (err) {
    if (err.attempts?.length) { base.attempts.push(...err.attempts); logOtariAttempts(state, task.id, err.attempts); }
    base.receipt = err.receipt ?? client.budget.receipt();
    base.error = { code: err.code ?? 'otari-failed', message: err.message };
    const isBudget = err.code === 'budget-exceeded' || err.code === 'user-budget-exceeded';
    task.status = isBudget ? 'budget-exceeded' : 'otari-failed';
    logEvent(state, {
      type: isBudget ? 'otari-budget-exceeded' : 'otari-failed', taskId: task.id,
      text: isBudget ? `Budget exceeded — run aborted before execution. ${err.message}` : `Otari live run aborted: ${err.message}`,
      severity: 'critical',
    });
    return { ...base, aborted: true };
  }
  base.receipt = client.budget.receipt();
  logEvent(state, {
    type: 'otari-audit-complete', taskId: task.id,
    text: `Otari: planner ${base.outputs.planner.model} and auditor ${base.outputs.auditor.model} completed via the Otari gateway. ${base.guardrailBlocks.length} guardrail block(s). Total $${base.receipt.spentUsd.toFixed(4)} of $${base.receipt.limitUsd} budget (estimated prices). Deterministic checks still decide the score.`,
    severity: 'info',
  });
  return base;
}

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

/** Snapshot of the workspace used as the baseline for scope, invariants and diffs. */
export async function snapshotWorkspace() {
  const map = {};
  for (const rel of await listFiles(WORKSPACE_DIR)) {
    map[rel] = await fs.readFile(path.join(WORKSPACE_DIR, rel));
  }
  return map;
}

function baselineFromState(state) {
  return Object.fromEntries(
    Object.entries(state.runBaseline ?? {}).map(([rel, b64]) => [rel, Buffer.from(b64, 'base64')]),
  );
}

function isMutating(action) {
  return action.type !== 'read';
}

function describeAction(action, index) {
  return {
    index,
    type: action.type,
    path: action.path ?? action.command ?? '',
    note: action.note ?? '',
    requiresApproval: isMutating(action),
    preview:
      action.type === 'write'
        ? String(action.content ?? '')
            .split('\n')
            .slice(0, 8)
            .join('\n')
        : null,
    decision: null,
  };
}

function summarizeResult(result) {
  return {
    type: result.action.type,
    path: result.action.path ?? result.action.command,
    note: result.action.note,
    decision: result.decision,
    detail: result.detail,
    code: result.code ?? null,
  };
}

function findTask(state, taskId) {
  return state.tasks.find((t) => t.id === taskId);
}

function conflict(code, message) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

/**
 * Begin a task. Whether the plan executes immediately depends on the approval
 * mode agreed for this trust tier. Nothing mutating is applied before approval.
 */
export async function startRun({
  scenarioId,
  contract,
  state,
  approvalMode = 'auto',
  weights = null,
  live = false,
  userId = 'default',
  otariClient = null,
}) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioId}"`);

  if (state.incident && state.incident.status !== 'resolved') {
    throw conflict(
      'repair-required',
      'Repair-only mode is active. Resolve the open incident by repairing or restoring before starting new work.',
    );
  }
  if (state.trust <= 0) {
    // Plan §8: at trust zero the agent may inspect, repair, or roll back, but
    // may not begin a new task. The user's escape hatches are restore, an
    // explicit override, and reset -- all of which stay available here.
    throw conflict(
      'repair-only',
      'Trust is 0/10, so the project is in repair-only mode. New tasks are blocked. You can repair an incident, restore a checkpoint, override, or reset.',
    );
  }
  if (state.runApproval) {
    throw conflict('approval-pending', 'A task is waiting for your approval. Approve, decline, or cancel it first.');
  }
  if (state.run && (state.run.status === 'running' || state.run.status === 'awaiting-approval')) {
    throw conflict('run-in-progress', 'A task is already running.');
  }

  if ((await listFiles(WORKSPACE_DIR)).length === 0) {
    await resetWorkspace();
  }

  const baseline = await snapshotWorkspace();
  const baselineTests = await captureTestBaseline(contract);
  const checkpoint = await createCheckpoint(`checkpoint-${Date.now().toString(36)}`, `Before “${contract.goal}”`);
  const taskId = nextId('task');
  const tier = tierFor(state.trust);
  const frozenWeights = normalizeWeights(weights ?? contract.weights);
  const frozenContract = { ...contract, weights: frozenWeights };
  const plan = await planActions(scenarioId);
  const planPreview = plan.map(describeAction);

  const task = {
    id: taskId,
    scenarioId,
    scenarioName: scenario.name,
    goal: contract.goal,
    contract: frozenContract,
    weights: frozenWeights,
    trustBefore: state.trust,
    tierBefore: tier.mode,
    tierLabel: tier.label,
    approvalMode,
    checkpointId: checkpoint.id,
    startedAt: new Date().toISOString(),
    status: approvalMode === 'auto' ? 'running' : 'awaiting-approval',
    score: null,
    outcome: null,
    checks: null,
    diff: [],
    agentClaim: '',
    actions: [],
    pendingPlan: planPreview,
  };

  state.tasks.unshift(task);
  if (state.tasks.length > 40) state.tasks.length = 40;
  state.run = { taskId, scenarioId, status: task.status, startedAt: task.startedAt };
  state.runBaseline = Object.fromEntries(
    Object.entries(baseline).map(([rel, buf]) => [rel, buf.toString('base64')]),
  );
  state.runBaselineTests = baselineTests;
  state.runPlan = plan;
  state.runResults = [];
  state.runApproval =
    approvalMode === 'auto'
      ? null
      : {
          mode: approvalMode,
          index: 0,
          decisions: {},
          planPreview,
        };

  logEvent(state, {
    type: 'task-started',
    taskId,
    text: `Task started under ${tier.label} (trust ${state.trust}/10). Checkpoint ${checkpoint.id} created. Approval mode: ${approvalMode}.`,
    severity: 'info',
  });
  logEvent(state, {
    type: 'criteria-frozen',
    taskId,
    text: `Evaluation criteria frozen before execution: ${frozenWeights.map((w) => `${w.label} ${w.weight}%`).join(', ')}.`,
    severity: 'info',
  });
  logEvent(state, {
    type: 'test-baseline',
    taskId,
    text: baselineTests.ok
      ? 'Pre-task test baseline recorded: the suite passes before any edit.'
      : `Pre-task test baseline recorded: ${baselineTests.failing.length} test(s) already failing before any edit.`,
    severity: baselineTests.ok ? 'info' : 'warning',
  });

  if (live) {
    task.live = true;
    const perUser = process.env.OTARI_USER_BUDGET_USD ? { [userId]: Number(process.env.OTARI_USER_BUDGET_USD) } : {};
    const client = otariClient ?? createOtariClient({ budget: createBudget({ perUser }) });
    const liveResult = await runLiveOtari({ state, task, contract: frozenContract, client, userId });
    task.otari = liveResult;
    task.otariReceipt = liveResult.receipt ?? null;
    if (liveResult.aborted) {
      state.run = { taskId, scenarioId, status: task.status, startedAt: task.startedAt };
      state.runApproval = null;
      state.runPlan = null;
      return { task, aborted: true, budgetExceeded: task.status === 'budget-exceeded' };
    }
  }

  if (approvalMode === 'auto') {
    const results = await executePlan(plan, frozenContract, state, taskId);
    state.runResults = results.map(summarizeResult);
    return finalizeRun(state, task, baseline);
  }

  return { task, pending: true, awaiting: nextAwaiting(state.runApproval) };
}

function nextAwaiting(approval) {
  if (!approval) return null;
  return approval.planPreview.find((p) => p.requiresApproval && !approval.decisions[p.index]) ?? null;
}

/**
 * Decide the next proposed edit. In plan mode one decision covers the whole
 * plan; in per-edit mode each individual edit is decided separately.
 */
export async function decideApproval({ state, decision = 'allow', index = null }) {
  const approval = state.runApproval;
  if (!approval) throw conflict('no-approval', 'There is no plan waiting for approval.');

  const task = findTask(state, state.run?.taskId);
  if (!task) throw new Error('The pending task is missing.');
  const verdict = decision === 'deny' ? 'deny' : 'allow';

  if (approval.mode === 'plan') {
    if (verdict === 'deny') return cancelRun({ state });
    for (const p of approval.planPreview) {
      if (p.requiresApproval) approval.decisions[p.index] = 'allow';
    }
    logEvent(state, {
      type: 'plan-approved',
      taskId: task.id,
      text: `You approved the ${approval.planPreview.filter((p) => p.requiresApproval).length}-step plan before any edit was applied.`,
      severity: 'success',
    });
  } else {
    const next = nextAwaiting(approval);
    if (!next) throw conflict('no-approval', 'There is no edit waiting for a decision.');
    if (index !== null && Number(index) !== next.index) {
      throw conflict('wrong-action', 'That is not the next edit awaiting approval.');
    }
    approval.decisions[next.index] = verdict;
    logEvent(state, {
      type: verdict === 'allow' ? 'edit-approved' : 'edit-declined',
      taskId: task.id,
      path: next.path,
      text:
        verdict === 'allow'
          ? `You approved: ${next.path} — ${next.note}`
          : `You declined: ${next.path}. The edit was not applied.`,
      severity: verdict === 'allow' ? 'success' : 'info',
    });
  }

  return progressRun(state, task);
}

/**
 * User override at trust zero. This is deliberately narrow: it grants exactly
 * one level, only from zero, and is recorded as an override rather than as
 * earned trust. It cannot be used to inflate trust on an ordinary task.
 */
export function grantOverride({ state, note = '' }) {
  if (state.trust > 0) {
    throw conflict('override-not-allowed', 'An override is only available at trust 0/10.');
  }
  const from = state.trust;
  const to = applyTrust(from, +1);
  state.trust = to;
  const reason = `User override at trust 0. ${String(note).trim() || 'No reason was given.'} This is a user decision, not earned trust.`;
  state.trustHistory.unshift({
    id: nextId('trust'),
    at: new Date().toISOString(),
    from,
    to,
    reason,
    taskId: null,
  });
  logEvent(state, {
    type: 'trust-overridden',
    taskId: null,
    text: `You overrode the repair-only lock. Trust ${from} → ${to}. ${reason}`,
    severity: 'warning',
  });
  return { from, to, reason };
}

/** Cancel a pending plan. No edit is applied and no trust change is recorded. */
export function cancelRun({ state }) {
  const approval = state.runApproval;
  if (!approval) throw conflict('no-approval', 'There is no plan to cancel.');
  const task = findTask(state, state.run?.taskId);
  if (task) {
    task.status = 'cancelled';
    task.cancelledAt = new Date().toISOString();
    task.pendingPlan = approval.planPreview;
  }
  logEvent(state, {
    type: 'run-cancelled',
    taskId: task?.id ?? null,
    text: 'You cancelled the proposed plan before any edit was applied. Trust is unchanged.',
    severity: 'info',
  });
  clearRun(state);
  return { cancelled: true, task };
}

function clearRun(state) {
  state.run = null;
  state.runApproval = null;
  state.runPlan = null;
  state.runResults = [];
}

/** Execute reads and already-decided edits in plan order, then stop at the next decision. */
async function progressRun(state, task) {
  const contract = task.contract;
  const plan = state.runPlan ?? [];
  const approval = state.runApproval;

  while (approval.index < plan.length) {
    const i = approval.index;
    const action = plan[i];

    if (!isMutating(action)) {
      const result = (await executePlan([action], contract, state, task.id))[0];
      state.runResults.push(summarizeResult(result));
      approval.index += 1;
      continue;
    }

    const decision = approval.decisions[i];
    if (!decision) {
      return { task, pending: true, awaiting: nextAwaiting(approval) };
    }

    if (decision === 'allow') {
      const result = (await executePlan([action], contract, state, task.id))[0];
      state.runResults.push(summarizeResult(result));
    } else {
      state.runResults.push({
        type: action.type,
        path: action.path ?? action.command,
        note: action.note,
        decision: 'deny',
        detail: 'You declined this edit. It was not applied.',
        code: 'user-denied',
      });
      logEvent(state, {
        type: 'action-declined',
        taskId: task.id,
        path: action.path ?? action.command,
        text: `Declined by you: ${action.path ?? action.command}. No file was changed.`,
        severity: 'info',
      });
    }
    approval.index += 1;
  }

  return finalizeRun(state, task, baselineFromState(state));
}

/** Verify, score, open incidents and apply the deterministic trust penalty. */
async function finalizeRun(state, task, baseline) {
  const results = state.runResults ?? [];
  const policyBlocked = results.filter((r) => r.decision === 'deny' && r.code !== 'user-denied');
  const agentClaim = agentClaimFor(task.scenarioId, policyBlocked.length > 0);

  task.actions = results;
  task.agentClaim = agentClaim;
  task.status = 'verifying';
  state.run = { ...state.run, status: 'verifying' };

  // Only this task's events may be used as evidence. The ledger is newest-first,
  // so passing the whole thing would let a later task's events change the
  // verdict on an earlier one.
  const taskLedger = state.ledger.filter((e) => e.taskId === task.id);
  const checks = await runChecks(task.contract, baseline, {
    agentClaim,
    ledger: taskLedger,
    review: null,
    taskId: task.id,
    baselineTests: state.runBaselineTests ?? null,
  });

  task.checks = checks;
  task.codeExecution = {
    label: 'Code execution',
    command: task.contract.projectTestCommand ?? 'node --test',
    status: checks.tests.status,
    summary: checks.tests.summary,
    detail: checks.tests.detail ?? [],
  };
  logEvent(state, {
    type: 'code-execution',
    taskId: task.id,
    text: `Code execution (verification): ran the project test suite \`${task.codeExecution.command}\` — ${checks.tests.summary}`,
    severity: checks.tests.status === 'fail' ? 'warning' : 'info',
  });
  task.diff = await diffPreview(baseline);

  const incidentLedger = state.ledger.filter((e) => e.taskId === task.id);
  const severeBlock = incidentLedger.some(
    (e) => e.type === 'action-blocked' && (e.code === 'forbidden-path' || e.code === 'forbidden-action'),
  );

  const scoring = computeTaskScore(checks, { seriousViolation: severeBlock, weights: task.weights });
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
    const incident = {
      id: nextId('incident'),
      taskId: task.id,
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
      resolution: null,
    };
    state.incident = incident;
    // A resolved incident is never removed from this record: a high average
    // must not hide the fact that a safety event happened at all.
    state.incidents.unshift(incident);
    logEvent(state, {
      type: 'incident-opened',
      taskId: task.id,
      text: incident.summary,
      severity: 'critical',
    });

    // Permissions are downgraded as soon as a violation is *verified*, not
    // after a human review. Scope violations are deterministic evidence; the
    // review gate exists for subjective quality, not for facts on disk.
    const delta = trustDelta('fail', scoring.score, {
      seriousViolation: severeBlock,
      scopeViolations: violations.length,
    });
    const from = state.trust;
    const to = applyTrust(from, delta.delta);
    state.trust = to;
    task.trustAfter = to;
    task.trustReason = delta.reason;
    task.violationPenaltyApplied = true;
    task.trustSettled = true;
    state.trustHistory.unshift({
      id: nextId('trust'),
      at: new Date().toISOString(),
      from,
      to,
      reason: `Violation detected: ${delta.reason}`,
      taskId: task.id,
    });
    logEvent(state, {
      type: 'trust-changed',
      taskId: task.id,
      text: `Trust ${from} → ${to} on detection of the violation. ${delta.reason}`,
      severity: 'warning',
    });
  }

  logEvent(state, {
    type: 'checks-complete',
    taskId: task.id,
    text: `Checks finished. Provisional score ${scoring.score}/10 (${scoring.outcome}).`,
    severity: 'info',
  });

  clearRun(state);
  return { task, scoring, pending: false };
}

/**
 * Record the user's review. This is what converts a provisional score into a
 * final one, because subjective quality belongs to the user, not the model.
 */
export function recordReview({ state, verdict, note }) {
  const task = state.tasks.find((t) => t.status === 'awaiting-review');
  if (!task) {
    throw conflict('no-pending-task', 'There is no task awaiting review.');
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

  const scoring = computeTaskScore(task.checks, {
    seriousViolation: task.seriousViolation,
    weights: task.weights,
  });
  task.score = scoring.score;
  task.breakdown = scoring.breakdown;
  task.outcome = scoring.outcome;
  task.provisional = scoring.provisional;

  const delta = trustDelta(scoring.outcome, scoring.score, {
    seriousViolation: task.seriousViolation,
    repair: Boolean(task.isRepair),
    scopeViolations: task.checks?.scope?.violations?.length ?? 0,
    failingChecks:
      task.checks?.tests?.status === 'fail' || task.checks?.goal?.status === 'fail' ||
      task.checks?.invariants?.status === 'fail',
  });

  // A task whose trust was already settled (violation penalty or verified
  // repair) must not be scored twice. Rewards still wait for this review on
  // clean tasks; penalties never wait for a human to confirm a fact on disk.
  if (task.trustSettled) {
    task.trustAfter = state.trust;
    logEvent(state, {
      type: 'trust-held',
      taskId: task.id,
      text: task.violationPenaltyApplied
        ? 'Trust was already downgraded when the violation was detected. Your review does not change it again.'
        : 'Trust was already settled by a verified repair. Your review does not change it again.',
      severity: 'info',
    });
  } else {
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
    task.trustReason = delta.reason;
  }

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
    throw conflict('no-incident', 'There is no open incident to repair.');
  }

  const task = findTask(state, state.incident.taskId);
  if (!task) throw new Error('The incident’s task is missing.');

  const contract = task.contract;
  const baseline = baselineFromState(state);

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
    baselineTests: state.runBaselineTests ?? null,
  });

  const scoring = computeTaskScore(checks, { seriousViolation: false, weights: task.weights });
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
    const record = state.incidents.find((i) => i.id === state.incident.id);
    if (record) Object.assign(record, { status: 'resolved', resolvedAt: state.incident.resolvedAt });

    // Only restore a level that was actually lost to this incident.
    if (task.violationPenaltyApplied) {
      const from = state.trust;
      const to = applyTrust(from, +1);
      state.trust = to;
      task.trustAfter = to;
      state.trustHistory.unshift({
        id: nextId('trust'),
        at: new Date().toISOString(),
        from,
        to,
        reason: 'A verified repair restored one trust level. The original incident remains on record.',
        taskId: task.id,
      });
      logEvent(state, {
        type: 'incident-resolved',
        taskId: task.id,
        text: `Repair verified. Trust ${from} → ${to}. New tasks are allowed again, but the safety event stays on record.`,
        severity: 'success',
      });
    } else {
      logEvent(state, {
        type: 'incident-resolved',
        taskId: task.id,
        text: 'Repair verified. New tasks are allowed again, but the safety event stays on record.',
        severity: 'success',
      });
    }
    task.trustSettled = true;
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
    const record = state.incidents.find((i) => i.id === state.incident.id);
    if (record) Object.assign(record, { status: 'resolved', resolvedAt: state.incident.resolvedAt });
    const task = findTask(state, state.incident.taskId);
    if (task) task.restored = true;
    logEvent(state, {
      type: 'incident-resolved',
      taskId: state.incident.taskId,
      text: 'Checkpoint restore cleared the open incident. Trust is not rewarded for a user rollback; the safety event stays on record.',
      severity: 'success',
    });
  }

  return result;
}

export function publicState(state) {
  const task = state.tasks[0] ?? null;
  const guardrailBlocks = (state.ledger ?? []).filter((e) => e.type === 'guardrail-block' || e.type === 'action-blocked');
  const active = state.tasks.find((t) => t.status === 'awaiting-review') ?? null;
  const incidents = state.incidents ?? [];
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
    safetyFlag: {
      active: incidents.length > 0,
      count: incidents.length,
      lastAt: incidents[0]?.openedAt ?? null,
      text: incidents.length
        ? `${incidents.length} safety incident${incidents.length === 1 ? '' : 's'} on record. A high average score never hides this.`
        : 'No safety incidents recorded for this project.',
    },
    run: state.run,
    approval: state.runApproval
      ? {
          mode: state.runApproval.mode,
          taskId: state.run?.taskId ?? null,
          plan: state.runApproval.planPreview.map((p) => ({
            ...p,
            decision: state.runApproval.decisions[p.index] ?? null,
          })),
          awaiting: nextAwaiting(state.runApproval),
          decided: Object.keys(state.runApproval.decisions).length,
          total: state.runApproval.planPreview.filter((p) => p.requiresApproval).length,
        }
      : null,
    otari: otariStatus(createOtariClient()),
    guardrails: {
      blocks: guardrailBlocks.slice(0, 40).map((e) => ({ id: e.id, at: e.at, type: e.type, path: e.path ?? null, code: e.code ?? null, text: e.text })),
      blockCount: guardrailBlocks.length,
      trust: state.trust,
      repairOnly: Boolean(state.incident && state.incident.status !== 'resolved') || state.trust <= 0,
      trustZeroLock: state.trust <= 0,
      text: state.trust <= 0
        ? 'Trust is 0/10: the repair-only lock is active and new tasks are blocked (POST /api/run returns 409).'
        : 'Policy blocks out-of-scope and protected-path writes before they reach disk.',
    },
    ledger: state.ledger.slice(0, 120),
    ledgerIntegrity: verifyLedger(state),
    ledgerHead: state.ledgerHead ?? null,
    ledgerCount: (state.ledger?.length ?? 0) + (state.ledgerArchive?.length ?? 0),
    trustHistory: state.trustHistory.slice(0, 40),
    scenarios: Object.values(SCENARIOS),
    repairOnly: Boolean(state.incident && state.incident.status !== 'resolved'),
  };
}
