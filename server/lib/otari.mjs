/**
 * Otari gateway client — the ONLY way Earnest talks to a model.
 *
 * Otari (Mozilla AI) is an OpenAI-compatible hosted gateway:
 *   POST {OTARI_BASE_URL}/chat/completions, Authorization: Bearer <token>
 * Verified from the Otari help-centre quickstart (2026-10-01):
 * base URL https://api.otari.ai/v1, tokens start with `otk_`, example model
 * id `deepseek/deepseek-v4-pro-0813` (provider/model slash form). Other
 * Otari SDK docs show a colon form instead, so model ids below are
 * env-configurable defaults, not verified facts — confirm with listModels()
 * once a real key is available. No direct provider calls anywhere.
 *
 * Zero dependencies: global fetch only, matching the rest of Earnest.
 */

export const DEFAULT_BASE_URL = 'https://api.otari.ai/v1';

// Role → ordered model list. First entry is primary, rest are fallbacks.
// shortcut: default ids follow the quickstart slash convention; upgrade by
// setting OTARI_MODEL_* once GET /v1/models confirms the real catalog ids.
export const ROLES = {
  planner: {
    label: 'Planner / writer',
    models: [
      process.env.OTARI_MODEL_PLANNER || 'alibaba/qwen3-max',
      process.env.OTARI_MODEL_FALLBACK || 'meta/llama-4-maverick',
    ],
  },
  auditor: {
    label: 'Independent auditor / verifier',
    models: [
      process.env.OTARI_MODEL_AUDITOR || 'deepseek/deepseek-v3.2',
      process.env.OTARI_MODEL_FALLBACK || 'meta/llama-4-maverick',
    ],
  },
};

// Best-effort USD per 1M tokens [input, output]; unknown models cost 0 and
// are flagged so a receipt never silently understates a known model.
// shortcut: placeholder prices for the budget receipt — replace with the Otari
// catalog prices once the key gives access to /v1/models pricing.
const PRICES = {
  'alibaba/qwen3-max': [1.2, 6.0],
  'deepseek/deepseek-v3.2': [0.3, 1.2],
  'meta/llama-4-maverick': [0.2, 0.8],
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
  let spent = 0;
  return {
    limitUsd,
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
    charge(userId = 'default', usd = 0) {
      spent += usd;
      spentByUser.set(userId, this.spentFor(userId) + usd);
      return spent;
    },
    receipt() {
      return { limitUsd, spentUsd: spent, remainingUsd: Math.max(0, limitUsd - spent), perUser: Object.fromEntries(spentByUser) };
    },
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
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) throw otariError('otari-http', `Otari ${res.status} for model ${model}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw otariError('otari-empty', `Otari returned no content for model ${model}`);
      return { content, usage: data.usage ?? null };
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
    for (const model of ordered) {
      const started = Date.now();
      try {
        const { content, usage } = await tryModel(model, messages);
        const costUsd = estimateCostUsd(model, usage);
        budget.check(userId, costUsd);
        budget.charge(userId, costUsd);
        attempts.push({ model, ok: true, ms: Date.now() - started });
        return { content, model, role, usage, costUsd, attempts, receipt: budget.receipt() };
      } catch (err) {
        if (err.code === 'budget-exceeded' || err.code === 'user-budget-exceeded') throw err;
        attempts.push({ model, ok: false, ms: Date.now() - started, error: err.message });
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

  return { chat, listModels, isConfigured, budget };
}

export const otari = createOtariClient();
