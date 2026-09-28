// Free-tier friendly LLM client. Both providers speak the OpenAI chat-completions
// dialect, so one fetch-based adapter covers them. Providers are tried in order;
// a rate limit (429), server error, or timeout falls through to the next one.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

interface Provider { name: string; url: string; key: string; model: string; headers?: Record<string, string> }

function providers(): Provider[] {
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
  // Optional: PROVIDER_ORDER=google,openrouter
  const order = (process.env.PROVIDER_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (order.length) list.sort((a, b) => (order.indexOf(a.name) + 99) % 99 - (order.indexOf(b.name) + 99) % 99);
  return list;
}

export const llmConfigured = () => providers().length > 0;

export async function chat(messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number } = {}) {
  const errors: string[] = [];
  for (const p of providers()) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      const r = await fetch(p.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}`, ...p.headers },
        body: JSON.stringify({
          model: p.model,
          messages,
          max_tokens: opts.maxTokens ?? 2000,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      }).finally(() => clearTimeout(timer));
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const data: any = await r.json();
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('empty response');
      return { text, provider: p.name, model: p.model };
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.length ? `All AI providers failed — ${errors.join(' | ')}` : 'No AI provider configured');
}
