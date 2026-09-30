// Free, no-API-key web search for the agent's research capability. Scrapes
// DuckDuckGo's HTML endpoint (no JS, no key) rather than calling a paid
// search API — good enough for grounding a chat answer, not a replacement
// for a real search product. Swap this out if quality becomes an issue.
export interface SearchResult { title: string; url: string; snippet: string }

const RESULT_RE = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.*?)<\/a>/g;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
}

export async function webSearch(query: string, max = 5): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kiln-agent/1.0; +https://klin-web-pmp0.onrender.com)' },
    });
    if (!res.ok) throw new Error(`search ${res.status}`);
    const html = await res.text();
    const results: SearchResult[] = [];
    let m: RegExpExecArray | null;
    while ((m = RESULT_RE.exec(html)) && results.length < max) {
      let link = m[1];
      const uddg = link.match(/uddg=([^&]+)/); // DDG wraps results as /l/?uddg=<encoded target>
      if (uddg) link = decodeURIComponent(uddg[1]);
      results.push({ title: stripHtml(m[2]), url: link, snippet: stripHtml(m[3]) });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// Cheap heuristic for "does this goal need live web info", so a normal chat
// question doesn't pay the extra search round-trip. Errs toward searching —
// a wasted search is cheaper than a stale or made-up answer.
const RESEARCH_HINTS = /\b(search|look ?up|latest|current|currently|recent|news|today|this (week|month|year)|price of|stock|weather|who is|what is|what's|when (is|did|was)|research|find (out|info)|compare|website|documentation|docs for|release notes|changelog|version of)\b/i;

export function needsResearch(goal: string): boolean {
  return RESEARCH_HINTS.test(goal);
}
