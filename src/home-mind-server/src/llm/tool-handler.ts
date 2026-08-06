import type { HomeAssistantClient, HistoryEntry } from "../ha/client.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor, WebSearchMode } from "./interface.js";
import type { ExtractedFact, Fact } from "../memory/types.js";
import { IMPERSONAL_FACT_CATEGORIES, isImpersonal } from "../memory/types.js";
import { filterFacts } from "../memory/fact-patterns.js";
import { envOrUndefined } from "../env.js";
import {
  type SearchBackend,
  SEARCH_BACKENDS,
  markExhausted,
  quotaFor,
  recordSearch,
  remoteQuotaAge,
  searchChain,
  setRemoteQuota,
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
  if (mode === "tavily" || mode === "brave" || mode === "searxng") return mode;
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
  const model = envOrUndefined("GEMINI_SEARCH_MODEL") ?? "gemini-3.6-flash";
  const base =
    envOrUndefined("GEMINI_NATIVE_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta";

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

/** How long the provider's own figures are trusted before we ask again. */
const QUOTA_REFRESH_MS = 60 * 60 * 1000;

/**
 * Ask Tavily what it has actually charged this key.
 *
 * Free to call (it is an account endpoint, not a search) and worth far more
 * than our local tally: it counts searches made from anywhere, and it shows
 * `paygo_usage` — money already spent past the free plan. Any pay-as-you-go
 * usage takes the backend out immediately; the point of this accounting is to
 * not spend, so the first cent is the signal, not a threshold to tune.
 */
export async function refreshTavilyQuota(): Promise<void> {
  if (!process.env.TAVILY_API_KEY) return;
  if (remoteQuotaAge("tavily") < QUOTA_REFRESH_MS) return;

  try {
    const response = await fetch("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;

    const data = (await response.json()) as any;
    const account = data?.account ?? {};
    const used = Number(account.plan_usage ?? 0);
    const quota = Number(account.plan_limit ?? 0);
    const paygo = Number(account.paygo_usage ?? 0);

    setRemoteQuota("tavily", {
      used,
      quota,
      stance: "free_until_quota",
      checkedAt: new Date().toISOString(),
    });
    console.log(
      `[search] tavily reports ${used}/${quota || "?"} used this month ` +
        `(plan ${account.current_plan ?? "?"})`
    );
    if (paygo > 0) {
      markExhausted("tavily", `pay-as-you-go usage has started (${paygo})`);
    }
  } catch (err) {
    // A quota probe must never break the search that follows it.
    console.warn(`[search] could not read Tavily usage: ${(err as Error).message}`);
  }
}

/**
 * Brave states its limits on every response: `x-ratelimit-limit: 50, 2000` is
 * per-second and per-month, with `x-ratelimit-remaining` alongside.
 *
 * A monthly limit of 0 is what a credit-based plan reports: there is no cap in
 * queries because the cap is in dollars (5 USD of renewable credit). Nothing
 * useful to record then — the derived quota and our local count stay in charge.
 */
export function readBraveQuotaHeaders(headers: Headers): void {
  const monthly = (name: string): number | undefined => {
    const parts = headers.get(name)?.split(",");
    if (!parts || parts.length < 2) return undefined;
    const value = Number(parts[1].trim());
    return Number.isFinite(value) ? value : undefined;
  };

  const limit = monthly("x-ratelimit-limit");
  const remaining = monthly("x-ratelimit-remaining");
  if (limit === undefined || limit <= 0) return;

  setRemoteQuota("brave", {
    used: remaining === undefined ? 0 : Math.max(limit - remaining, 0),
    quota: limit,
    stance: "free_until_quota",
    checkedAt: new Date().toISOString(),
  });
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

  // Brave reports its allowance on every response, including refusals.
  readBraveQuotaHeaders(response.headers);

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

/**
 * Search our own SearXNG instance.
 *
 * A metasearch front-end to the public engines, running on the same machine as
 * the assistant: no key, no account, no monthly allowance, and the query never
 * reaches a search API as a paying customer. It returns links and snippets
 * rather than a written answer — the model reads them, exactly as it does with
 * Brave. The engines can rate-limit the house IP, so this is a good fallback
 * and a poor sole dependency, which is why it sits in a chain.
 */
async function searchSearxng(query: string, maxResults: number): Promise<SearchResult> {
  const base = (envOrUndefined("SEARXNG_URL") ?? "http://127.0.0.1:8888").replace(/\/$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[tool] web_search SearXNG error: ${response.status} ${text.slice(0, 200)}`);
    throw new Error(`SearXNG error ${response.status}`);
  }

  const data = (await response.json()) as any;
  const results = Array.isArray(data?.results)
    ? data.results.slice(0, maxResults).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }))
    : [];

  return {
    // SearXNG surfaces an engine's direct answer (calculators, definitions)
    // when there is one; otherwise the snippets carry the information.
    answer: Array.isArray(data?.answers) && data.answers.length ? String(data.answers[0]) : "",
    results,
  };
}

/** Whether a backend can be used at all (its key is configured). */
function backendAvailable(backend: SearchBackend, searchKey: string): boolean {
  if (backend === "gemini_micro") return Boolean(searchKey);
  if (backend === "tavily") return Boolean(process.env.TAVILY_API_KEY);
  // Self-hosted and keyless: available as soon as an instance is pointed at.
  if (backend === "searxng") return Boolean(envOrUndefined("SEARXNG_URL"));
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
  const searchKey = search?.searchApiKey || envOrUndefined("GEMINI_SEARCH_API_KEY") || "";
  const preferred = resolveSearchMode(
    search?.mode ??
      (envOrUndefined("WEB_SEARCH_MODE") as WebSearchMode | undefined) ??
      (envOrUndefined("WEB_SEARCH_PROVIDER") as WebSearchMode | undefined),
    Boolean(searchKey)
  );

  // Ask the provider what it has actually charged before deciding anything —
  // our own tally only ever saw the searches this server made.
  if (backendAvailable("tavily", searchKey)) await refreshTavilyQuota();

  const configured = SEARCH_BACKENDS.filter((b) => backendAvailable(b, searchKey));
  const chain = searchChain(preferred, (b) => backendAvailable(b, searchKey));

  if (chain.length === 0) {
    if (configured.length === 0) {
      return {
        error:
          "No web search backend is configured — set TAVILY_API_KEY, BRAVE_API_KEY, " +
          "or a search API key for grounded micro-calls",
      };
    }
    // Keys exist, but using them now would cost money. Say so in words the
    // model can pass on, rather than searching anyway and billing the card.
    const state = configured
      .map((b) => `${b} ${usedThisMonth(b)}/${quotaFor(b) || "?"}`)
      .join(", ");
    console.warn(`[search] blocked — no free allowance left (${state})`);
    return {
      error:
        "Web search is unavailable: this month's free search allowance is used up " +
        `(${state}), and paid searches are switched off. Answer from what you already ` +
        "know and tell the user the free allowance has run out — it resets next month.",
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
            : backend === "searxng"
              ? await searchSearxng(query, maxResults)
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
  configLimit: number,
  /**
   * Whether facts about a person may be recalled.
   *
   * False on a shared device. What that profile has learned about the house is
   * still worth having — knowing which entity the "main light" is turns two
   * tool calls into one — so the recall happens, filtered to the categories
   * that describe the home rather than anybody in it. The filter also covers
   * profiles that collected personal facts before that rule existed.
   */
  allowPersonal: boolean = true,
  /**
   * The profile holding what the whole house knows, when the speaker has their
   * own profile as well.
   *
   * Recall then reads both: being recognised must not cut someone off from the
   * device nicknames and sensor baselines everyone else taught the assistant.
   * Omitted (or equal to `userId`) when there is nothing to combine — an
   * unidentified speaker is already reading the shared profile directly.
   */
  sharedUserId?: string
): Promise<string[]> {
  const limit = requestLimit ?? configLimit;
  if (limit <= 0) return [];

  const personalOnly = (facts: Fact[]) =>
    allowPersonal ? facts : facts.filter((f) => isImpersonal(f.category));

  if (!sharedUserId || sharedUserId === userId) {
    const facts = await memory.getFactsWithinTokenLimit(userId, limit, message);
    return personalOnly(facts).map((f) => f.content);
  }

  // Each profile is asked for the full budget and the merged result is trimmed
  // back to it. Splitting the budget up front would be worse: it would cap the
  // speaker's own memory at half even when the shared profile has nothing to
  // say, which is exactly the state this house is in today.
  const [ownFacts, sharedFacts] = await Promise.all([
    memory.getFactsWithinTokenLimit(userId, limit, message),
    memory.getFactsWithinTokenLimit(sharedUserId, limit, message),
  ]);

  // The shared profile is filtered regardless of `allowPersonal`: it is not
  // anybody's profile, so a personal fact in it is either legacy or a mistake,
  // and reading it out to whoever is standing there is the harm we are avoiding.
  const merged = [
    ...personalOnly(ownFacts),
    ...sharedFacts.filter((f) => isImpersonal(f.category)),
  ];

  const contents: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const fact of merged) {
    if (seen.has(fact.content)) continue;
    const factTokens = Math.ceil(fact.content.length / 4);
    if (tokens + factTokens > limit) break;
    seen.add(fact.content);
    contents.push(fact.content);
    tokens += factTokens;
  }
  return contents;
}

export async function extractAndStoreFacts(
  memory: IMemoryStore,
  extractor: IFactExtractor,
  userId: string,
  userMessage: string,
  assistantResponse: string,
  /**
   * Whether facts about the speaker may be stored.
   *
   * False for a shared device, where we do not know who is talking. It does
   * not silence learning entirely — the assistant still picks up how the house
   * works (see `IMPERSONAL_FACT_CATEGORIES`) — it only refuses to file
   * anything as a statement about a person, because on a shared profile that
   * person is a guess and a wrong guess cannot be untangled afterwards.
   */
  allowPersonal: boolean = true,
  /**
   * Where impersonal facts belong when the speaker has their own profile.
   *
   * Knowing who is talking should add a personal memory, not privatise the
   * house: "the main light is light.wled_kitchen" is as true for everyone else
   * as it is for the speaker, so it keeps going to the shared profile while
   * only statements about the person land in theirs.
   */
  sharedUserId?: string
): Promise<number> {
  const splitProfiles = Boolean(sharedUserId && sharedUserId !== userId);

  // Which profile a fact came from, so a replacement deletes the original
  // rather than silently failing against the wrong one.
  const ownFacts = await memory.getFacts(userId);
  const sharedFacts = splitProfiles ? await memory.getFacts(sharedUserId!) : [];
  const profileOfFact = new Map<string, string>();
  for (const f of ownFacts) profileOfFact.set(f.id, userId);
  for (const f of sharedFacts) profileOfFact.set(f.id, sharedUserId!);

  // The extractor sees both profiles, otherwise it would keep "discovering"
  // house facts that the shared profile already holds.
  const existingFacts = [...ownFacts, ...sharedFacts];

  const extractedFacts = await extractor.extract(
    userMessage,
    assistantResponse,
    existingFacts
  );

  // Filter out garbage
  const { kept: notGarbage, skipped } = filterExtractedFacts(extractedFacts);

  for (const { fact, reason } of skipped) {
    console.debug(`[filter] Skipped fact for ${userId}: "${fact.content}" — ${reason}`);
  }

  // On a shared profile, keep only what is true of the house rather than of
  // whoever happened to be speaking.
  const kept = allowPersonal
    ? notGarbage
    : notGarbage.filter((f) => IMPERSONAL_FACT_CATEGORIES.includes(f.category));

  if (!allowPersonal && kept.length < notGarbage.length) {
    const dropped = notGarbage.length - kept.length;
    console.log(
      `[identity] ${dropped} personal fact(s) not stored for shared profile ${userId}`
    );
  }

  if (kept.length === 0) return 0;

  // Delete replaced facts first, each from the profile that actually holds it.
  for (const fact of kept) {
    if (fact.replaces && fact.replaces.length > 0) {
      for (const oldFactId of fact.replaces) {
        const owner = profileOfFact.get(oldFactId) ?? userId;
        const deleted = await memory.deleteFact(owner, oldFactId);
        if (deleted) {
          console.log(`Replaced old fact ${oldFactId} for ${owner}`);
        }
      }
    }
  }

  // Route each fact to the profile it is true of: the house, or the speaker.
  const byProfile = new Map<string, ExtractedFact[]>();
  for (const fact of kept) {
    const target =
      splitProfiles && isImpersonal(fact.category) ? sharedUserId! : userId;
    const bucket = byProfile.get(target);
    if (bucket) bucket.push(fact);
    else byProfile.set(target, [fact]);
  }

  let stored = 0;
  for (const [target, facts] of byProfile) {
    const ids = await memory.addFacts(
      target,
      facts.map((f) => ({
        content: f.content,
        category: f.category,
        confidence: f.confidence,
      }))
    );
    stored += ids.length;
    for (const fact of facts) {
      console.log(`Stored new fact for ${target}: ${fact.content}`);
    }
  }

  return stored;
}
