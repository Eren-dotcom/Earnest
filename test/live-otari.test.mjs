import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated runtime, same discipline as engine.test.mjs: no shared workspace,
// no network — every Otari call goes through a stubbed fetch.
const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'earnest-live-test-'));
process.env.EARNEST_RUNTIME = isolated;

const { WORKSPACE_DIR } = await import('../server/lib/paths.mjs');
const { resetWorkspace, startRun } = await import('../server/lib/engine.mjs');
const { initialState, writeState } = await import('../server/lib/store.mjs');
const { DEFAULT_CONTRACT } = await import('../server/lib/contracts.mjs');
const { createOtariClient, createBudget } = await import('../server/lib/otari.mjs');

after(async () => { await fs.rm(isolated, { recursive: true, force: true }); });

async function freshState() {
  await resetWorkspace();
  const state = initialState();
  await writeState(state);
  return state;
}

const okRes = (content, usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }) => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }),
});
const failRes = { ok: false, status: 500, json: async () => ({}) };

const PLANNER = 'Plan: write src/HeroImage.js with descriptive alt text, then run the project tests.';
const AUDITOR = 'Audit: the plan only writes src/HeroImage.js, which is inside the approved scope. Approved.';

function stubClient(handler, budget = createBudget({ limitUsd: 0.5 })) {
  return createOtariClient({
    apiKey: 'otk_test',
    budget,
    fetchImpl: async (url, opts) => handler(JSON.parse(opts.body).model),
  });
}
const byModel = (plannerOut, auditorOut) => (model) =>
  model.includes('qwen') || model.includes('llama') ? plannerOut : auditorOut;

test('live path: planner + auditor via Otari, deterministic checks still decide', async () => {
  const state = await freshState();
  const client = stubClient(byModel(okRes(PLANNER), okRes(AUDITOR)));
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  assert.equal(task.otari.configured, true);
  assert.match(task.otari.outputs.planner.model, /qwen/);
  assert.match(task.otari.outputs.auditor.model, /deepseek/);
  assert.equal(task.otari.attempts.length, 2);
  assert.ok(task.otari.attempts.every((a) => a.ok && a.fallback === false));
  assert.equal(state.ledger.filter((e) => e.type === 'otari-attempt').length, 2);
  assert.ok(state.ledger.some((e) => e.type === 'otari-audit-complete'));
  assert.ok(state.ledger.some((e) => e.type === 'code-execution'), 'test execution is labelled as code execution');
  assert.equal(task.codeExecution.label, 'Code execution');
  // Code decides, not the models:
  assert.equal(task.checks.goal.status, 'pass');
  assert.equal(task.checks.tests.status, 'pass');
  assert.ok(task.otariReceipt.spentUsd > 0);
  assert.ok(task.otariReceipt.byModel['alibaba/qwen3-32b'] > 0);
  assert.ok(task.otariReceipt.byModel['deepseek/deepseek-v3.2'] > 0);
  const hero = await fs.readFile(path.join(WORKSPACE_DIR, 'src/HeroImage.js'), 'utf8');
  assert.match(hero, /alt="A wooden workshop table/);
});

test('regression: gateway returns cost_usd as a string, run still completes with a numeric receipt', async () => {
  const state = await freshState();
  // The real gateway sends usage.cost_usd as a string, e.g. "0.000109".
  const stringCost = (content) => okRes(content, { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cost_usd: '0.000109' });
  const client = stubClient(byModel(stringCost(PLANNER), stringCost(AUDITOR)));
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  assert.equal(task.otari.attempts.length, 2, 'planner and auditor both ran');
  assert.ok(task.otari.attempts.every((a) => a.ok && typeof a.costUsd === 'number' && a.costSource === 'otari-reported'));
  assert.ok(state.ledger.some((e) => e.type === 'otari-audit-complete'), 'run reached the auditor');
  assert.equal(typeof task.otariReceipt.spentUsd, 'number');
  assert.ok(Math.abs(task.otariReceipt.spentUsd - 0.000218) < 1e-9, 'two reported string costs summed as numbers, not concatenated');
  const auditLine = state.ledger.find((e) => e.type === 'otari-audit-complete');
  assert.match(auditLine.text, /Total \$0\.0002 of \$0\.5 budget/, 'receipt total formats with toFixed');
  assert.equal(task.checks.goal.status, 'pass');
});

test('live path: planner failure falls back to the next model and is logged', async () => {
  const state = await freshState();
  const client = stubClient((model) => {
    if (model.includes('qwen')) return failRes;
    if (model.includes('llama')) return okRes(PLANNER);
    return okRes(AUDITOR);
  });
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  assert.equal(task.otari.outputs.planner.model, 'meta/llama-4-maverick-17b-instruct');
  const plannerAttempts = task.otari.attempts.filter((a) => a.role === 'planner');
  assert.equal(plannerAttempts.length, 2);
  assert.equal(plannerAttempts[0].ok, false);
  assert.equal(plannerAttempts[1].fallback, true);
  const logged = state.ledger.filter((e) => e.type === 'otari-attempt' && e.role === 'planner');
  assert.equal(logged.length, 2);
  assert.equal(logged.find((e) => e.model.includes('llama')).fallback, true);
  assert.equal(task.checks.goal.status, 'pass');
});

test('guardrail: planner proposing an out-of-scope write is refused before execution', async () => {
  const state = await freshState();
  const navbarBefore = await fs.readFile(path.join(WORKSPACE_DIR, 'src/Navbar.js'), 'utf8');
  const client = stubClient(byModel(
    okRes('Plan: write src/HeroImage.js, and also write src/Navbar.js to rename a link.'),
    okRes(AUDITOR),
  ));
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  const block = task.otari.guardrailBlocks.find((b) => b.path === 'src/Navbar.js');
  assert.ok(block, 'guardrail block recorded on the task');
  assert.equal(block.code, 'out-of-scope');
  assert.ok(state.ledger.some((e) => e.type === 'guardrail-block' && e.path === 'src/Navbar.js'));
  const navbarAfter = await fs.readFile(path.join(WORKSPACE_DIR, 'src/Navbar.js'), 'utf8');
  assert.equal(navbarAfter, navbarBefore, 'the refused file was never written');
});

test('budget: a call costing more than the run budget aborts before execution', async () => {
  const state = await freshState();
  const huge = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };
  const client = stubClient(() => okRes(PLANNER, huge), createBudget({ limitUsd: 0.001 }));
  const result = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  assert.equal(result.aborted, true);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.task.status, 'budget-exceeded');
  assert.equal(result.task.otari.error.code, 'budget-exceeded');
  assert.ok(state.ledger.some((e) => e.type === 'otari-budget-exceeded'));
  assert.equal(result.task.checks, null, 'no scoring happened');
  const hero = await fs.readFile(path.join(WORKSPACE_DIR, 'src/HeroImage.js'), 'utf8');
  assert.match(hero, /alt=""/, 'nothing was executed');
});

test('not configured: live flag without a key makes no call and says so honestly', async () => {
  const state = await freshState();
  let calls = 0;
  const client = createOtariClient({ apiKey: '', fetchImpl: async () => { calls++; return okRes('x'); } });
  const { task } = await startRun({ scenarioId: 'safe-success', contract: DEFAULT_CONTRACT, state, live: true, otariClient: client });

  assert.equal(calls, 0);
  assert.equal(task.otari.configured, false);
  assert.equal(task.otari.status, 'not configured');
  assert.ok(state.ledger.some((e) => e.type === 'otari-not-configured'));
  assert.equal(state.ledger.filter((e) => e.type === 'otari-attempt').length, 0);
  assert.equal(task.checks.goal.status, 'pass', 'the deterministic scenario still runs unchanged');
});
