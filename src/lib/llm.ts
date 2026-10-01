// Free-tier friendly LLM client. All four providers speak (or accept) the
// OpenAI chat-completions dialect except Anthropic, which gets its own
// request shape below. Providers are tried in order; a rate limit (429),
// server error, or timeout falls through to the next one.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export type ProviderName = 'openrouter' | 'google' | 'anthropic' | 'ollama';

interface Provider { name: ProviderName; url: string; key: string; model: string; headers?: Record<string, string>; anthropic?: boolean }

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
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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
  const order = (process.env.PROVIDER_ORDER || 'openrouter,google,ollama,anthropic').split(',').map((s) => s.trim()).filter(Boolean);
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
  for (const p of providers(override)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      const isAnthropic = !!p.anthropic;
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system');
      const body = isAnthropic
        ? { model: p.model, max_tokens: opts.maxTokens ?? 2000, ...(sys ? { system: sys } : {}), messages: rest }
        : {
            model: p.model,
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
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const data: any = await r.json();
      const text: string | undefined = isAnthropic
        ? data?.content?.find((b: any) => b.type === 'text')?.text
        : data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty response');
      return { text, provider: p.name, model: p.model };
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.length ? `All AI providers failed — ${errors.join(' | ')}` : 'No AI provider configured');
}
