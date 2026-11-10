import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOtariClient, createBudget, estimateCostUsd } from '../server/lib/otari.mjs';

const okRes = (content, usage = { prompt_tokens: 1000, completion_tokens: 1000 }) => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }),
});
const failRes = { ok: false, status: 500, json: async () => ({}) };

test('not configured: chat throws a typed error, no fetch attempted', async () => {
  let calls = 0;
  const client = createOtariClient({ apiKey: '', fetchImpl: async () => { calls++; return okRes('x'); } });
  assert.equal(client.isConfigured(), false);
  await assert.rejects(() => client.chat({ messages: [] }), (e) => e.code === 'otari-not-configured');
  assert.equal(calls, 0);
});

test('routing: falls back to the next model when the first fails', async () => {
  const seen = [];
  const client = createOtariClient({
    apiKey: 'otk_test',
    fetchImpl: async (url, opts) => {
      const { model } = JSON.parse(opts.body);
      seen.push(model);
      return model === 'm1' ? failRes : okRes('from fallback');
    },
  });
  const out = await client.chat({ messages: [{ role: 'user', content: 'hi' }], models: ['m1', 'm2'] });
  assert.equal(out.content, 'from fallback');
  assert.equal(out.model, 'm2');
  assert.deepEqual(seen, ['m1', 'm2']);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].ok, false);
});

test('routing: all models failing throws with attempts attached', async () => {
  const client = createOtariClient({ apiKey: 'otk_test', fetchImpl: async () => failRes });
  await assert.rejects(
    () => client.chat({ messages: [], models: ['m1', 'm2'] }),
    (e) => e.code === 'otari-all-models-failed' && e.attempts.length === 2,
  );
});

test('budget: cost is captured, charged, and the limit aborts the next run', async () => {
  // deepseek default price: (1000*0.3 + 1000*1.2)/1e6 = $0.0015 per call
  assert.ok(Math.abs(estimateCostUsd('deepseek/deepseek-v3.2', { prompt_tokens: 1000, completion_tokens: 1000 }) - 0.0015) < 1e-9);
  const budget = createBudget({ limitUsd: 0.002 });
  const client = createOtariClient({ apiKey: 'otk_test', budget, fetchImpl: async () => okRes('ok') });
  const out = await client.chat({ messages: [], models: ['deepseek/deepseek-v3.2'] });
  assert.equal(out.costUsd, 0.0015);
  assert.equal(budget.receipt().spentUsd, 0.0015);
  await assert.rejects(
    () => client.chat({ messages: [], models: ['deepseek/deepseek-v3.2'] }),
    (e) => e.code === 'budget-exceeded' || e.code === 'user-budget-exceeded',
  );
});

test('per-user budget: a capped user is blocked even under the run limit', async () => {
  const budget = createBudget({ limitUsd: 10, perUser: { alice: 0.001 } });
  const client = createOtariClient({ apiKey: 'otk_test', budget, fetchImpl: async () => okRes('ok') });
  await assert.rejects(
    () => client.chat({ messages: [], models: ['deepseek/deepseek-v3.2'], userId: 'alice' }),
    (e) => e.code === 'user-budget-exceeded',
  );
  const out = await client.chat({ messages: [], models: ['deepseek/deepseek-v3.2'], userId: 'bob' });
  assert.equal(out.content, 'ok');
});
