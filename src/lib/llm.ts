// Free-tier friendly LLM client. All four providers speak (or accept) the
// OpenAI chat-completions dialect except Anthropic, which gets its own
// request shape below. Providers are tried in order; a rate limit (429),
// server error, or timeout falls through to the next one.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export type ProviderName = 'openrouter' | 'google' | 'anthropic' | 'ollama';

interface Provider { name: ProviderName; url: string; key: string; model: string; fallbackModels?: string[]; headers?: Record<string, string>; anthropic?: boolean }

// Gemini retires models without much warning (gemini-2.5-flash now 404s for new
// users). If the configured model is gone we walk this list, newest first.
const GEMINI_FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

// A provider that just rate-limited us (or rejected its key) is skipped for a
// while instead of burning a round trip on every request. Per-process memory.
const cooldownUntil = new Map<string, number>();
const deadModels = new Set<string>(); // `${provider}:${model}` that returned 404 NOT_FOUND

/** Pull the human message out of a provider error body (JSON or text), kept short. */
function briefError(status: number, body: string): string {
  let msg = body;
  try {
    const j: any = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    msg = e?.message || e?.metadata?.raw || (typeof e === 'string' ? e : body);
  } catch { /* not JSON */ }
  return `${status} ${String(msg).replace(/\s+/g, ' ').slice(0, 160)}`;
}

// A person's choice from Settings -> Model (stored in user_settings.model_routing).
// `provider` is moved to the front of the try-order; `model` overrides that
// provider's default model. Everything still falls back to the next provider
// on failure — this only changes preference, not availability.
export interface ModelOverride { provider?: ProviderName; model?: string }

function basProviders(): Provider[] {
  const list: Provider[] = [];
  if (process.env.OPENROUTER_API_KEY) {
    list.push({
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'openrouter/free',
      headers: { 'HTTP-Referer': process.env.FRONTEND_URL || 'https://klin-web.onrender.com', 'X-Title': 'klin' },
    });
  }
  if (process.env.GEMINI_API_KEY) {
    list.push({
      name: 'google',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || GEMINI_FALLBACKS[0],
      fallbackModels: GEMINI_FALLBACKS,
    });
  }
  // Ollama Cloud — hosted open models (gpt-oss, kimi, deepseek, ...) behind
  // an OpenAI-compatible endpoint, keyed the same way as the providers above.
  if (process.env.OLLAMA_API_KEY) {
    list.push({
      name: 'ollama',
      url: 'https://ollama.com/v1/chat/completions',
      key: process.env.OLLAMA_API_KEY,
      model: process.env.OLLAMA_MODEL || 'gpt-oss:20b',
    });
  }
  // Paid, opt-in. Only used if a key is set and — by default — only after the free
  // providers above have been tried, so the free tiers stay the default cost path.
  if (process.env.ANTHROPIC_API_KEY) {
    list.push({
      name: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      anthropic: true,
    });
  }
  return list;
}

function providers(override?: ModelOverride): Provider[] {
  const list = basProviders();
  // Optional: PROVIDER_ORDER=google,openrouter — server-wide default order.
  const order = (process.env.PROVIDER_ORDER || 'google,openrouter,ollama,anthropic').split(',').map((s) => s.trim()).filter(Boolean);
  const rank = (n: string) => { const i = order.indexOf(n); return i === -1 ? order.length : i; };
  list.sort((a, b) => rank(a.name) - rank(b.name));

  if (!override?.provider) return list;
  const idx = list.findIndex((p) => p.name === override.provider);
  if (idx === -1) return list; // chosen provider has no key set on the server — fall back silently
  const [chosen] = list.splice(idx, 1);
  if (override.model) chosen.model = override.model;
  return [chosen, ...list];
}

export const llmConfigured = () => basProviders().length > 0;
export const availableProviders = (): ProviderName[] => basProviders().map((p) => p.name);

export async function chat(messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number } = {}, override?: ModelOverride) {
  const errors: string[] = [];
  const all = providers(override);
  const now = Date.now();
  // Skip providers cooling down — unless that would leave nothing to try.
  const ready = all.filter((p) => (cooldownUntil.get(p.name) ?? 0) <= now);
  const queue = ready.length ? ready : all;

  for (const p of queue) {
    const models = [p.model, ...(p.fallbackModels ?? [])]
      .filter((m, i, a) => a.indexOf(m) === i && !deadModels.has(`${p.name}:${m}`));
    if (!models.length) models.push(p.model);

    for (const model of models) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90_000);
        const isAnthropic = !!p.anthropic;
        const sys = messages.find((m) => m.role === 'system')?.content;
        const rest = messages.filter((m) => m.role !== 'system');
        const body = isAnthropic
          ? { model, max_tokens: opts.maxTokens ?? 2000, ...(sys ? { system: sys } : {}), messages: rest }
          : {
              model,
              messages,
              max_tokens: opts.maxTokens ?? 2000,
              ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
            };
        const r = await fetch(p.url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: isAnthropic
            ? { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}`, ...p.headers },
          body: JSON.stringify(body),
        }).finally(() => clearTimeout(timer));
        if (!r.ok) {
          const text = await r.text();
          const err: any = new Error(briefError(r.status, text));
          err.status = r.status;
          err.retryAfter = Number(r.headers.get('retry-after')) || 0;
          throw err;
        }
        const data: any = await r.json();
        const text: string | undefined = isAnthropic
          ? data?.content?.find((b: any) => b.type === 'text')?.text
          : data?.choices?.[0]?.message?.content;
        if (!text) throw new Error('empty response');
        cooldownUntil.delete(p.name);
        return { text, provider: p.name, model };
      } catch (e: any) {
        errors.push(`${p.name}/${model}: ${e instanceof Error ? e.message : String(e)}`);
        if (e?.status === 404 && p.fallbackModels?.length) {
          // Model retired or unavailable: remember, and try the next candidate.
          deadModels.add(`${p.name}:${model}`);
          continue;
        }
        if (e?.status === 429) cooldownUntil.set(p.name, Date.now() + Math.max(e.retryAfter * 1000, 10 * 60_000));
        else if (e?.status === 401 || e?.status === 403) cooldownUntil.set(p.name, Date.now() + 30 * 60_000);
        break; // next provider
      }
    }
  }
  throw new Error(errors.length ? `All AI providers failed — ${errors.join(' | ')}` : 'No AI provider configured');
}

/** Test hook: forget cooldowns and retired-model memory. */
export function _resetLlmState() { cooldownUntil.clear(); deadModels.clear(); }
