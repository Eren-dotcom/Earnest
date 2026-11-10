/**
 * Otari gateway client — the ONLY way Earnest talks to a model.
 *
 * Otari (Mozilla AI) is an OpenAI-compatible hosted gateway:
 *   POST {OTARI_BASE_URL}/chat/completions, Authorization: Bearer <token>
 * Verified live on 2026-11-11 with a real key (Bearer auth): base URL
 * https://api.otari.ai/api/v1 (the /v1 form in older docs returns 404),
 * GET /models lists 165 models, and the default model ids + catalog
 * prices below are the live values from that check. Model ids stay
 * env-configurable overrides. No direct provider calls anywhere.
 *
 * Zero dependencies: global fetch only, matching the rest of Earnest.
 */

export const DEFAULT_BASE_URL = 'https://api.otari.ai/api/v1';

// Role → ordered model list. First entry is primary, rest are fallbacks.
// Default ids are the live-verified API ids (2026-11-11); note there is no
// "qwen3-max" API id — dashboard display names differ from API ids.
export const ROLES = {
  planner: {
    label: 'Planner / writer',
    models: [
      process.env.OTARI_MODEL_PLANNER || 'alibaba/qwen3-32b',
      process.env.OTARI_MODEL_FALLBACK || 'meta/llama-4-maverick-17b-instruct',
    ],
  },
  auditor: {
    label: 'Independent auditor / verifier',
    models: [
      process.env.OTARI_MODEL_AUDITOR || 'deepseek/deepseek-v3.2',
      process.env.OTARI_MODEL_FALLBACK || 'meta/llama-4-maverick-17b-instruct',
    ],
  },
};

// Otari catalog prices, USD per 1M tokens [input, output], verified live
// 2026-11-11 via GET /models. Unknown models cost 0 in the estimate; when a
// chat response reports its own cost, that actual figure is preferred.
const PRICES = {
  'alibaba/qwen3-32b': [0.08, 0.28],
  'deepseek/deepseek-v3.2': [0.62, 1.85],
  'meta/llama-4-maverick-17b-instruct': [0.24, 0.97],
};

export function estimateCostUsd(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return 0;
  return ((usage.prompt_tokens ?? 0) * price[0] + (usage.completion_tokens ?? 0) * price[1]) / 1e6;
}

function otariError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Budget tracker: one per-run limit plus optional per-user caps.
 * check() is called before dispatch (abort, never overspend silently);
 * charge() records actual cost after a call.
 */
export function createBudget({ limitUsd = Number(process.env.OTARI_RUN_BUDGET_USD ?? 0.5), perUser = {} } = {}) {
  const spentByUser = new Map();
  const spentByModel = new Map();
  let spent = 0;
  return {
    limitUsd,
    perUserCaps: { ...perUser },
    get spentUsd() { return spent; },
    spentFor(userId) { return spentByUser.get(userId) ?? 0; },
    check(userId = 'default', estUsd = 0) {
      if (spent + estUsd > limitUsd) {
        throw otariError('budget-exceeded', `Otari run budget exceeded: $${spent.toFixed(4)} spent of $${limitUsd} limit.`);
      }
      const cap = perUser[userId];
      if (cap != null && this.spentFor(userId) + estUsd > cap) {
        throw otariError('user-budget-exceeded', `Otari budget for user "${userId}" exceeded: $${this.spentFor(userId).toFixed(4)} of $${cap} cap.`);
      }
    },
    charge(userId = 'default', usd = 0, model = null) {
      spent += usd;
      spentByUser.set(userId, this.spentFor(userId) + usd);
      if (model) spentByModel.set(model, (spentByModel.get(model) ?? 0) + usd);
      return spent;
    },
    receipt() {
      return {
        limitUsd, spentUsd: spent, remainingUsd: Math.max(0, limitUsd - spent),
        perUser: Object.fromEntries(spentByUser), perUserCaps: { ...perUser },
        byModel: Object.fromEntries(spentByModel),
        pricesAreEstimates: false,
        priceSource: 'Otari catalog prices (verified 2026-11-11); a call uses the actual cost Otari reports when the response includes one.',
      };
    },
  };
}

export function otariStatus(client) {
  return {
    configured: client.isConfigured(),
    status: client.isConfigured() ? 'configured' : 'not configured',
    baseUrl: client.baseUrl,
    gateway: client.baseUrl,
    roles: Object.fromEntries(Object.entries(ROLES).map(([id, r]) => [id, { label: r.label, models: [...r.models] }])),
  };
}

export function createOtariClient({
  apiKey = process.env.OTARI_API_KEY,
  baseUrl = process.env.OTARI_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = fetch,
  budget = createBudget(),
  timeoutMs = 30_000,
} = {}) {
  const isConfigured = () => Boolean(apiKey);

  async function tryModel(model, messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        // max_tokens 1024: Qwen3-32b reasons first, so a small cap spends the budget on reasoning and returns empty content.
        body: JSON.stringify({ model, messages, max_tokens: 1024 }),
      });
      if (!res.ok) throw otariError('otari-http', `Otari ${res.status} for model ${model}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw otariError('otari-empty', `Otari returned no content for model ${model}`);
      const usage = data.usage ?? null;
      return { content, usage, reportedCostUsd: usage?.cost_usd ?? usage?.estimated_cost ?? data.cost_usd ?? null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Chat with routing: try models in order, fall back on any failure. */
  async function chat({ role = 'planner', messages, userId = 'default', models } = {}) {
    if (!isConfigured()) {
      throw otariError('otari-not-configured', 'Otari not configured: set OTARI_API_KEY (hosted gateway token, starts with otk_).');
    }
    const ordered = models ?? ROLES[role]?.models;
    if (!ordered?.length) throw otariError('otari-no-model', `No Otari models configured for role "${role}".`);
    budget.check(userId, 0);
    const attempts = [];
    for (const [i, model] of ordered.entries()) {
      const started = Date.now();
      try {
        const { content, usage, reportedCostUsd } = await tryModel(model, messages);
        const costUsd = reportedCostUsd ?? estimateCostUsd(model, usage);
        budget.check(userId, costUsd);
        budget.charge(userId, costUsd, model);
        attempts.push({ model, role, ok: true, fallback: i > 0, ms: Date.now() - started, usage, costUsd, costSource: reportedCostUsd != null ? 'otari-reported' : 'catalog' });
        return { content, model, role, usage, costUsd, attempts, receipt: budget.receipt() };
      } catch (err) {
        if (err.code === 'budget-exceeded' || err.code === 'user-budget-exceeded') {
          err.attempts = attempts;
          err.receipt = budget.receipt();
          throw err;
        }
        attempts.push({ model, role, ok: false, fallback: i > 0, ms: Date.now() - started, error: err.message, usage: null, costUsd: 0 });
      }
    }
    const err = otariError('otari-all-models-failed', `All Otari models failed for role "${role}": ${attempts.map((a) => a.model).join(', ')}`);
    err.attempts = attempts;
    throw err;
  }

  async function listModels() {
    if (!isConfigured()) throw otariError('otari-not-configured', 'Otari not configured: set OTARI_API_KEY.');
    const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw otariError('otari-http', `Otari ${res.status} listing models`);
    return res.json();
  }

  return { chat, listModels, isConfigured, budget, baseUrl };
}

export const otari = createOtariClient();
