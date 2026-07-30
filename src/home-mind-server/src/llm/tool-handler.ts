import type { HomeAssistantClient, HistoryEntry } from "../ha/client.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor, WebSearchMode } from "./interface.js";
import type { ExtractedFact } from "../memory/types.js";
import { filterFacts } from "../memory/fact-patterns.js";
import {
  type SearchBackend,
  markExhausted,
  quotaFor,
  recordSearch,
  searchChain,
  usedThisMonth,
} from "./search-usage.js";

/** Max history entries to return to the LLM to avoid blowing context window */
const MAX_HISTORY_ENTRIES = 200;

/**
 * Normalize a timestamp to ensure it has timezone info.
 * If the timestamp lacks a Z suffix or ±HH:MM offset, append Z (UTC).
 */
export function normalizeTimestamp(ts: string | undefined): string | undefined {
  if (ts === undefined) return undefined;
  // Already has Z suffix or ±HH:MM / ±HHMM offset
  if (/Z$/i.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts) || /[+-]\d{4}$/.test(ts)) {
    return ts;
  }
  return ts + "Z";
}

/**
 * Downsample history to avoid blowing the LLM context window.
 * Strips bulky attributes and evenly samples entries when over the limit.
 */
export function truncateHistory(
  entries: HistoryEntry[]
): { entity_id: string; state: string; last_changed: string }[] {
  // Strip attributes — they're huge (friendly_name, unit, icon, device_class, etc.)
  // and the LLM only needs state + timestamp
  const slim = entries.map((e) => ({
    entity_id: e.entity_id,
    state: e.state,
    last_changed: e.last_changed,
  }));

  if (slim.length <= MAX_HISTORY_ENTRIES) return slim;

  // Evenly sample, always keeping first and last
  const step = (slim.length - 1) / (MAX_HISTORY_ENTRIES - 1);
  const sampled: typeof slim = [];
  for (let i = 0; i < MAX_HISTORY_ENTRIES; i++) {
    sampled.push(slim[Math.round(i * step)]);
  }

  console.log(`[tool] get_history truncated ${entries.length} → ${sampled.length} entries`);
  return sampled;
}

/** Per-request web-search settings, resolved from the HA options + server config. */
export interface WebSearchSettings {
  mode?: WebSearchMode;
  /** Key of a billed Google project, used by the `gemini_micro` mode. */
  searchApiKey?: string;
}

/**
 * Decide which backend actually answers a `web_search` tool call.
 *
 * `grounding` never lands here in the normal flow — in that mode the model
 * searches server-side and the tool is not even offered. It does land here when
 * the engine cannot ground (a non-Gemini provider, or a key whose project has
 * no grounding), so we degrade instead of failing: the billed micro-call when a
 * search key exists, Tavily otherwise. `gemini_micro` without a key degrades the
 * same way, since the alternative is an error the user cannot act on mid-sentence.
 */
export function resolveSearchMode(
  requested: WebSearchMode | undefined,
  hasSearchKey: boolean
): Exclude<WebSearchMode, "grounding"> {
  const mode = (requested ?? "grounding").toLowerCase() as WebSearchMode;
  if (mode === "tavily" || mode === "brave") return mode;
  if (hasSearchKey) return "gemini_micro";
  if (mode === "gemini_micro") {
    console.warn(
      "[tool] web_search mode is gemini_micro but no search API key is set — falling back to Tavily"
    );
  }
  return "tavily";
}

/**
 * Answer a search with one small grounded Gemini request on a separate key.
 *
 * The prompt is just the query, so this costs a fraction of inline grounding in
 * tokens — the expensive part of this mode is that the *conversation* needs a
 * second full-prompt round-trip to use the result.
 */
export async function groundedGeminiSearch(
  query: string,
  apiKey: string
): Promise<{ answer: string; results: { title: string; url: string }[]; queries: string[] }> {
  const model = process.env.GEMINI_SEARCH_MODEL ?? "gemini-3.6-flash";
  const base = process.env.GEMINI_NATIVE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

  const response = await fetch(`${base}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Search the web and answer concisely, in the language of the question. " +
                `Question: ${query}`,
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[tool] web_search grounded micro-call error: ${response.status} ${text.slice(0, 200)}`);
    // 429 here means either the monthly grounding allowance is gone or the
    // project cannot ground at all (free tier) — both are "stop using this
    // backend", not "retry in a second".
    if (response.status === 429 || response.status === 402) {
      throw new QuotaError("gemini_micro", `HTTP ${response.status}`);
    }
    throw new Error(`Gemini search error ${response.status}`);
  }

  const data = (await response.json()) as any;
  const cand = data?.candidates?.[0];
  const answer = (cand?.content?.parts ?? [])
    .map((p: any) => p?.text ?? "")
    .join("")
    .trim();
  const meta = cand?.groundingMetadata ?? {};
  const results = (meta.groundingChunks ?? [])
    .map((c: any) => ({ title: c?.web?.title ?? "", url: c?.web?.uri ?? "" }))
    .filter((r: { url: string }) => r.url);
  const queries: string[] = meta.webSearchQueries ?? [];

  console.log(
    `[search] grounded micro-call: queries=${JSON.stringify(queries)} sources=${results.length}`
  );
  return { answer, results, queries };
}

/** Thrown when a search backend says it is out of quota (HTTP 429/402). */
export class QuotaError extends Error {
  constructor(
    readonly backend: SearchBackend,
    reason: string
  ) {
    super(`${backend} out of quota (${reason})`);
    this.name = "QuotaError";
  }
}

export interface SearchResult {
  answer: string;
  results: { title: string; url: string; snippet?: string }[];
  /** Which backend actually answered — surfaced so the model can cite it. */
  provider?: SearchBackend;
  queries?: string[];
}

async function searchTavily(query: string, maxResults: number): Promise<SearchResult> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_answer: true,
      include_links: true,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[tool] web_search Tavily error: ${response.status} ${text.slice(0, 200)}`);
    if (response.status === 429 || response.status === 402) {
      throw new QuotaError("tavily", `HTTP ${response.status}`);
    }
    throw new Error(`Tavily API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  return {
    answer: data.answer ?? "",
    results: Array.isArray(data.results)
      ? data.results.map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet }))
      : [],
  };
}

async function searchBrave(query: string, maxResults: number): Promise<SearchResult> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.BRAVE_API_KEY as string,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[tool] web_search Brave error: ${response.status} ${text.slice(0, 200)}`);
    if (response.status === 429 || response.status === 402) {
      throw new QuotaError("brave", `HTTP ${response.status}`);
    }
    throw new Error(`Brave API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  return {
    // Brave has no synthesized answer field — only snippets.
    answer: "",
    results: Array.isArray(data?.web?.results)
      ? data.web.results
          .slice(0, maxResults)
          .map((r: any) => ({ title: r.title, url: r.url, snippet: r.description }))
      : [],
  };
}

/** Whether a backend can be used at all (its key is configured). */
function backendAvailable(backend: SearchBackend, searchKey: string): boolean {
  if (backend === "gemini_micro") return Boolean(searchKey);
  if (backend === "tavily") return Boolean(process.env.TAVILY_API_KEY);
  return Boolean(process.env.BRAVE_API_KEY);
}

/**
 * Run one web search, moving down the backend chain when a backend is out of
 * quota. The preferred backend comes from the HA option; the rest are fallbacks
 * ordered by how much monthly allowance they have left, so a search still
 * succeeds after the primary provider's free tier runs out.
 */
export async function runWebSearch(
  query: string,
  maxResults: number,
  search?: WebSearchSettings
): Promise<SearchResult | { error: string }> {
  const searchKey = search?.searchApiKey || process.env.GEMINI_SEARCH_API_KEY || "";
  const preferred = resolveSearchMode(
    search?.mode ??
      (process.env.WEB_SEARCH_MODE as WebSearchMode | undefined) ??
      (process.env.WEB_SEARCH_PROVIDER as WebSearchMode | undefined),
    Boolean(searchKey)
  );

  const chain = searchChain(preferred, (b) => backendAvailable(b, searchKey));
  if (chain.length === 0) {
    return {
      error:
        "No web search backend is configured — set TAVILY_API_KEY, BRAVE_API_KEY, " +
        "or a search API key for grounded micro-calls",
    };
  }

  let lastError = "";
  for (const backend of chain) {
    try {
      const out =
        backend === "gemini_micro"
          ? await groundedGeminiSearch(query, searchKey)
          : backend === "brave"
            ? await searchBrave(query, maxResults)
            : await searchTavily(query, maxResults);

      recordSearch(backend);
      const used = usedThisMonth(backend);
      const quota = quotaFor(backend);
      console.log(
        `[search] ${backend} answered${backend !== preferred ? ` (fallback from ${preferred})` : ""}` +
          ` — ${used}${quota > 0 ? `/${quota}` : ""} this month`
      );
      return { ...out, provider: backend };
    } catch (e) {
      if (e instanceof QuotaError) {
        markExhausted(e.backend, e.message);
        lastError = e.message;
        continue; // try the next backend in the chain
      }
      lastError = e instanceof Error ? e.message : String(e);
      console.log(`[search] ${backend} failed: ${lastError} — trying the next backend`);
    }
  }

  return { error: `All web search backends failed. Last error: ${lastError}` };
}

export async function handleToolCall(
  ha: HomeAssistantClient,
  toolName: string,
  input: Record<string, unknown>,
  search?: WebSearchSettings
): Promise<unknown> {
  const start = Date.now();
  console.log(`[tool] ${toolName} called with: ${JSON.stringify(input)}`);

  try {
    let result: unknown;

    switch (toolName) {
      case "get_state":
        result = await ha.getState(input.entity_id as string);
        break;

      case "get_entities":
        result = await ha.getEntities(input.domain as string | undefined);
        break;

      case "search_entities":
        result = await ha.searchEntities(input.query as string);
        break;

      case "call_service":
        result = await ha.callService(
          input.domain as string,
          input.service as string,
          input.entity_id as string | undefined,
          input.data as Record<string, unknown> | undefined,
          input.return_response === true
        );
        break;

      case "get_history": {
        const startTime = normalizeTimestamp(input.start_time as string | undefined);
        const endTime = normalizeTimestamp(input.end_time as string | undefined);
        const history = await ha.getHistory(
          input.entity_id as string,
          startTime,
          endTime
        );
        result = truncateHistory(history);
        break;
      }
      case "web_search": {
        result = await runWebSearch(
          input.query as string,
          (input.max_results as number | undefined) ?? 3,
          search
        );
        break;
      }
      default:
        result = { error: `Unknown tool: ${toolName}` };
    }

    const elapsed = Date.now() - start;
    console.log(`[tool] ${toolName} completed in ${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[tool] ${toolName} failed in ${elapsed}ms: ${message}`);
    return { error: message };
  }
}

/**
 * Filter out garbage facts that the LLM extracted despite prompt instructions.
 * Delegates to shared pattern matching in fact-patterns.ts.
 */
export function filterExtractedFacts(facts: ExtractedFact[]): { kept: ExtractedFact[]; skipped: { fact: ExtractedFact; reason: string }[] } {
  return filterFacts(facts);
}

/**
 * Recall the user's facts for this turn, honouring a per-request token budget.
 *
 * The budget is what the user set in HA (`memory_token_limit`), falling back to
 * the server's MEMORY_TOKEN_LIMIT. A budget of 0 means "no memory in the
 * prompt": we skip the Shodh round-trip entirely instead of asking for zero
 * tokens' worth of facts.
 */
export async function recallFacts(
  memory: IMemoryStore,
  userId: string,
  message: string,
  requestLimit: number | undefined,
  configLimit: number
): Promise<string[]> {
  const limit = requestLimit ?? configLimit;
  if (limit <= 0) return [];

  const facts = await memory.getFactsWithinTokenLimit(userId, limit, message);
  return facts.map((f) => f.content);
}

export async function extractAndStoreFacts(
  memory: IMemoryStore,
  extractor: IFactExtractor,
  userId: string,
  userMessage: string,
  assistantResponse: string
): Promise<number> {
  const existingFacts = await memory.getFacts(userId);

  const extractedFacts = await extractor.extract(
    userMessage,
    assistantResponse,
    existingFacts
  );

  // Filter out garbage
  const { kept, skipped } = filterExtractedFacts(extractedFacts);

  for (const { fact, reason } of skipped) {
    console.debug(`[filter] Skipped fact for ${userId}: "${fact.content}" — ${reason}`);
  }

  if (kept.length === 0) return 0;

  // Delete replaced facts first
  for (const fact of kept) {
    if (fact.replaces && fact.replaces.length > 0) {
      for (const oldFactId of fact.replaces) {
        const deleted = await memory.deleteFact(userId, oldFactId);
        if (deleted) {
          console.log(`Replaced old fact ${oldFactId} for ${userId}`);
        }
      }
    }
  }

  // Batch store all kept facts
  const ids = await memory.addFacts(
    userId,
    kept.map((f) => ({ content: f.content, category: f.category, confidence: f.confidence }))
  );

  for (const fact of kept) {
    console.log(`Stored new fact for ${userId}: ${fact.content}`);
  }

  return ids.length;
}
