/**
 * Shodh Memory REST API Client
 *
 * Implements cognitive memory with Hebbian learning, natural decay,
 * and semantic search via Shodh Memory service.
 *
 * API: https://github.com/varun29ankuS/shodh-memory
 */

import type { Fact, FactCategory } from "./types.js";

// Map our fact categories to Shodh memory types
const CATEGORY_TO_SHODH_TYPE: Record<FactCategory, string> = {
  baseline: "Observation",
  preference: "Preference",
  identity: "Context",
  device: "Context",
  pattern: "Observation",
  correction: "Learning",
};

// Reverse mapping for recall
const SHODH_TYPE_TO_CATEGORY: Record<string, FactCategory> = {
  Observation: "baseline",
  Preference: "preference",
  Context: "identity",
  Learning: "correction",
  Decision: "preference",
  Insight: "pattern",
  Error: "correction",
  Success: "pattern",
};

/**
 * How many tagged facts we ask for in one go.
 *
 * Generous on purpose: depth is free here. The tag endpoint is an index read,
 * and it does not care how deep we go — measured on this household at 2.3 ms
 * for a limit of 100, 1000 and 5000 alike. The old value of 100 was not a
 * budget, it was a guess, and it was the kind of guess that stops working
 * without saying so once the fact set outgrows it.
 */
const FACT_SET_LIMIT = 5000;

interface ShodhExperience {
  content: string;
  memory_type: string;
  tags: string[];
}

interface ShodhMemory {
  id: string;
  experience?: ShodhExperience; // present in /api/recall and /api/recall/tags
  // Flat fields from /api/proactive_context (no experience wrapper)
  content?: string;
  memory_type?: string;
  tags?: string[];
  importance: number;
  created_at: string;
  last_accessed?: string;
  access_count?: number;
  score?: number;
}

interface ShodhRecallResponse {
  memories: ShodhMemory[];
  count: number;
}

interface ShodhRememberResponse {
  id: string;
  success: boolean;
}

interface ShodhBatchRememberResponse {
  created: number;
  failed: number;
  memory_ids: string[];
  errors: string[];
}

interface ShodhProactiveContextResponse {
  memories: ShodhMemory[];
  due_reminders?: unknown[];
  context_reminders?: unknown[];
  memory_count?: number;
}

interface ShodhRecallByTagsResponse {
  memories: ShodhMemory[];
  count: number;
}

export interface ShodhConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export class ShodhMemoryClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: ShodhConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 60000; // 60s to handle Shodh cold start
  }

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: unknown,
    retries: number = 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
            "Connection": "keep-alive",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Shodh API error ${response.status}: ${text}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err as Error;

        // Don't retry on abort (timeout)
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }

        // Retry on all fetch failures (connection issues, socket errors, DNS)
        if (attempt < retries - 1) {
          const delay = Math.min(500 * Math.pow(2, attempt), 3000);
          console.log(`Shodh request failed (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    throw lastError || new Error("Shodh request failed after retries");
  }

  /**
   * Check if Shodh service is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.request("/health", "GET");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store a fact in Shodh memory
   */
  async remember(
    userId: string,
    content: string,
    category: FactCategory,
    confidence: number = 0.8
  ): Promise<string> {
    const memoryType = CATEGORY_TO_SHODH_TYPE[category];

    const response = await this.request<ShodhRememberResponse>(
      "/api/remember",
      "POST",
      {
        user_id: userId,
        content,
        memory_type: memoryType,
        importance: confidence,
        tags: [category, "home-mind"],
      }
    );

    return response.id;
  }

  /**
   * Recall memories using semantic search
   */
  async recall(
    userId: string,
    query?: string,
    limit: number = 50
  ): Promise<Fact[]> {
    const response = await this.request<ShodhRecallResponse>(
      "/api/recall",
      "POST",
      {
        user_id: userId,
        query: query || "all memories",
        limit,
      }
    );

    if (response.memories.length >= limit) {
      console.warn(
        `[shodh] relevance window for ${userId} filled (${limit}) — anything ranked ` +
          `below it was not considered. Unlike tag recall this degrades gently ` +
          `(the window holds the best matches), but a fact can still sit outside it ` +
          `when the store is mostly non-facts. Raise RELEVANCE_WINDOW.`
      );
    }

    return response.memories.map((mem) => this.toFact(mem, userId));
  }

  /**
   * Store multiple facts in one batch call.
   * POST /api/remember/batch
   */
  async rememberBatch(
    userId: string,
    memories: { content: string; category: FactCategory; confidence?: number }[]
  ): Promise<string[]> {
    const batch = memories.map((m) => ({
      content: m.content,
      memory_type: CATEGORY_TO_SHODH_TYPE[m.category],
      importance: m.confidence ?? 0.8,
      tags: [m.category, "home-mind"],
    }));

    const response = await this.request<ShodhBatchRememberResponse>(
      "/api/remember/batch",
      "POST",
      { user_id: userId, memories: batch }
    );

    if (response.failed > 0) {
      console.warn(
        `[shodh] Batch remember: ${response.created} created, ${response.failed} failed`,
        response.errors
      );
    }

    return response.memory_ids;
  }

  /**
   * Recall memories by tags using Shodh's /api/recall/tags endpoint.
   *
   * The endpoint has no pagination — `offset`, `skip`, `page` and `cursor` are
   * all accepted and all ignored (measured: every variant returned the same
   * full set). So the only way to fetch the whole fact set is to ask
   * for more than it holds, and the only way to know we failed is to notice
   * that the answer came back exactly the size of the question.
   *
   * That check is the point of this function. The endpoint returns facts in a
   * non-deterministic order — the same request twice puts a different fact
   * first — so a truncated answer is not "the oldest N" or "the strongest N",
   * it is an arbitrary N, and the fact that goes missing changes between
   * calls. Silently. This is why the caller gets a warning rather than a
   * shorter list.
   */
  async recallByTags(userId: string, limit: number = FACT_SET_LIMIT): Promise<Fact[]> {
    const response = await this.request<ShodhRecallByTagsResponse>(
      "/api/recall/tags",
      "POST",
      { user_id: userId, tags: ["home-mind"], limit }
    );

    if (response.memories.length >= limit) {
      console.warn(
        `[shodh] tag recall for ${userId} filled its window (${limit}) — the fact ` +
          `set is at least this big and some of it is not being read. Facts are ` +
          `returned in arbitrary order, so which ones are missing varies per call. ` +
          `Raise FACT_SET_LIMIT.`
      );
    }

    return response.memories.map((mem) => this.toFact(mem, userId));
  }

  /**
   * Get proactive context using Shodh's graph-based spreading activation.
   * POST /api/proactive_context
   */
  async getProactiveContext(
    userId: string,
    currentContext: string,
    limit: number = 20
  ): Promise<Fact[]> {
    const response = await this.request<ShodhProactiveContextResponse>(
      "/api/proactive_context",
      "POST",
      { user_id: userId, context: currentContext, limit }
    );

    return response.memories.map((mem) => this.toFact(mem, userId));
  }

  /**
   * Reinforce memories (Hebbian learning - strengthens the connection)
   */
  async reinforce(userId: string, memoryIds: string[]): Promise<void> {
    await this.request("/api/reinforce", "POST", {
      user_id: userId,
      ids: memoryIds,
      outcome: "positive",
    });
  }

  /**
   * Forget a memory explicitly
   */
  async forget(userId: string, memoryId: string): Promise<void> {
    await this.request(
      `/api/forget/${encodeURIComponent(memoryId)}?user_id=${encodeURIComponent(userId)}`,
      "DELETE"
    );
  }

  /**
   * Convert Shodh memory to our Fact type.
   * Handles two response shapes:
   * - /api/recall, /api/recall/tags: nested `experience` object
   * - /api/proactive_context: flat fields (content, memory_type, tags at top level)
   */
  private toFact(mem: ShodhMemory, userId: string): Fact {
    // Normalize: proactive_context uses flat fields, recall uses experience wrapper
    const content = mem.experience?.content ?? mem.content ?? "";
    const tags = mem.experience?.tags ?? mem.tags ?? [];
    const memoryType = mem.experience?.memory_type ?? mem.memory_type ?? "";

    // Try to get category from tags
    let category: FactCategory = "preference";
    for (const tag of tags) {
      if (
        ["baseline", "preference", "identity", "device", "pattern", "correction"].includes(
          tag
        )
      ) {
        category = tag as FactCategory;
        break;
      }
    }

    // Fallback to mapping from memory_type
    if (memoryType in SHODH_TYPE_TO_CATEGORY) {
      category = SHODH_TYPE_TO_CATEGORY[memoryType];
    }

    return {
      id: mem.id,
      userId,
      content,
      category,
      confidence: mem.importance,
      createdAt: new Date(mem.created_at),
      lastUsed: mem.last_accessed ? new Date(mem.last_accessed) : new Date(mem.created_at),
      useCount: mem.access_count || 0,
      // Only /api/recall carries a score; the tag endpoint has no question to
      // score against. Kept undefined rather than 0 in that case — see `Fact`.
      trafnosc: typeof mem.score === "number" ? mem.score : undefined,
    };
  }
}

/**
 * How deep the relevance query looks before its hits are intersected with the
 * tagged fact set.
 *
 * It has to be generous, because the query does not rank facts against facts —
 * it ranks them against everything stored under that user_id, and most of what
 * is stored is not ours. This household's index holds 88 verbatim utterances
 * beside 12 facts, and they outscore the facts even when both are in the same
 * language: the best-matching fact for "jakie światło wolę w salonie" sits at
 * position 4, and for "czy mogę napić się kawy o dwudziestej" at position 15.
 * A window of 20 would have dropped the second one. Nothing is paid for the
 * extra depth — the intersection throws the non-facts away regardless.
 *
 * "Nothing is paid" is now measured rather than assumed: the query costs the
 * same at a window of 100, 500 and 2000 (~100 ms, flat). Practically all of it
 * is embedding the question, which is a fixed cost — the search behind it does
 * not show up. So the window is set to cover a store far larger than today's,
 * because a window that is too small fails the same silent way the tag cap did:
 * the relevant fact is simply not in the slice, and nothing says so.
 *
 * Shodh can filter by tag server-side (`tags` on /api/recall), which would make
 * this window cheaper still — and we deliberately do not use it. Measured
 * against the client-side intersection on four questions, it disagreed on two:
 * it dropped one tagged fact outright for "ile lat ma mój syn" (10 vs 11) and
 * reordered the set for "co lubię jeść". Membership stays on our side, where it
 * is decided by an explicit set intersection we can reason about.
 */
const RELEVANCE_WINDOW = 2000;

/**
 * How good the best match has to be before we believe the ranking understood
 * the question at all.
 *
 * Below this the whole ranking is noise, and we send everything instead of
 * filtering. Measured on this household — the top score when the question
 * genuinely landed, against the top score when nothing in memory was relevant:
 *
 *   landed:  0.610 "picie kawy" · 0.476 "jak głośno gra muzyka"
 *            0.467 "ile lat ma mój syn" · 0.362 "co lubię jeść"
 *            0.328 "zapal światło w salonie"
 *   noise:   0.303 "hodowla alpak" (nothing about alpacas exists)
 *            0.204 "zrób mi kawę" · 0.164 "kawa wieczorem"
 *
 * The two groups nearly touch (0.328 against 0.303), so this cannot be used to
 * judge individual facts — that was tried and it does not separate them. It is
 * only good enough for the coarser question of whether to filter at all, and
 * the value sits above the overlap on purpose: a question we are unsure about
 * is treated as not understood, and nothing is withheld.
 */
const PROG_ZAUFANIA = 0.35;

/**
 * How far below the best match a fact may sit and still be sent.
 *
 * Safe to set anywhere in this range, which is the surprising part: when a
 * fact is the right answer it does not sit mid-tail, it sits at the top. The
 * expected fact came back at position 1 or 2 and at 99–100% of the best score
 * in every question that scored it at all. So this number decides how much
 * unrelated background goes out, and not whether the answer survives.
 */
const PASMO_TRAFNOSCI = 0.5;

/**
 * Pick the facts worth putting in the prompt.
 *
 * The rule that matters is not the band — it is that the band only applies
 * when the ranking is credible. Relevance here is bimodal: either the fact
 * that answers the question is ranked first, or it is **not ranked at all**.
 * "Zrób mi kawę" does not rank "Lech nie pije kawy po 18:00" anywhere, at any
 * window size we tried. So a filter that simply kept the top of every ranking
 * would have thrown that fact out of a prompt it currently reaches — inventing
 * the exact failure the filter exists to prevent, and doing it to the example
 * that motivated the whole feature.
 *
 * Hence: filter when the question was clearly understood, send everything when
 * it was not. Facts that the query never scored are kept in the second case
 * and dropped in the first, which is the same principle read twice — an
 * unscored fact is only evidence of irrelevance if the scoring was working.
 */
export function wybierzPoTrafnosci(fakty: Fact[]): Fact[] {
  const oceniona = fakty.filter((f) => typeof f.trafnosc === "number");
  if (oceniona.length === 0) return fakty;

  const czolowka = Math.max(...oceniona.map((f) => f.trafnosc!));
  if (czolowka < PROG_ZAUFANIA) return fakty;

  const prog = czolowka * PASMO_TRAFNOSCI;
  return fakty.filter((f) => typeof f.trafnosc === "number" && f.trafnosc >= prog);
}

/**
 * Memory store that uses Shodh for long-term facts and in-memory storage
 * for short-term conversation history. Shodh excels at semantic memory;
 * conversation state is transient and lost on restart (by design).
 */
export class ShodhMemoryStore {
  private shodh: ShodhMemoryClient;

  constructor(shodhConfig: ShodhConfig) {
    this.shodh = new ShodhMemoryClient(shodhConfig);
  }

  /**
   * Check if Shodh is available
   */
  async isHealthy(): Promise<boolean> {
    return this.shodh.isHealthy();
  }

  /**
   * Get all facts for a user using semantic recall
   */
  async getFacts(userId: string): Promise<Fact[]> {
    return this.shodh.recallByTags(userId);
  }

  /**
   * Get facts within a token limit using a hybrid recall strategy:
   *   1. Always pull the user's tagged fact set (deterministic baseline).
   *   2. If we have a current message, also run a semantic recall for it
   *      and promote the hits to the front, so the LLM sees query-relevant
   *      memories first — and so that they are the ones that survive when
   *      the budget cannot hold everything.
   *
   * Rationale: tag recall guarantees that any stored fact reaches the prompt
   * as long as the budget allows, but its order is arbitrary — the moment
   * there are more facts than budget, an arbitrary order means an arbitrary
   * choice of what the assistant forgets. The relevance layer decides that
   * choice instead.
   *
   * Why `recall` and not `proactive_context`: the graph walk behind
   * proactive_context returned facts unrelated to the question here, while
   * plain semantic recall found the right ones. Neither endpoint is ours to
   * fix, so the layer simply uses the one that answers.
   *
   * ⚠️ The relevance layer only REORDERS the tagged set — it never adds to it.
   * Shodh's index holds more than our facts: raw conversation turns live under
   * the same `user_id` without the `home-mind` tag, and a semantic query
   * happily ranks them first (measured on this household: a question about
   * coffee returned twelve transcript fragments and not one fact). Letting
   * `recall` contribute members would push verbatim speech into the prompt as
   * if it were remembered knowledge, and crowd the real facts out of the
   * budget. Tagged recall stays the sole source of membership.
   */
  async getFactsWithinTokenLimit(
    userId: string,
    maxTokens: number,
    currentContext?: string
  ): Promise<Fact[]> {
    // Baseline: every fact tagged home-mind for this user
    const tagFactsPromise = this.shodh.recallByTags(userId);
    // Relevance boost when we have a query (tolerate failure)
    const relevantPromise = currentContext
      ? this.shodh.recall(userId, currentContext, RELEVANCE_WINDOW).catch((err) => {
          console.warn("[shodh] recall failed, using tag recall only:", err);
          return [] as Fact[];
        })
      : Promise.resolve([] as Fact[]);

    const [tagFacts, relevantFacts] = await Promise.all([tagFactsPromise, relevantPromise]);

    // Order: the tagged facts the query hit, in the order it ranked them, then
    // the rest of the tagged set. Anything `recall` returned that is not a
    // tagged fact is dropped — see the note above.
    const tagged = new Map(tagFacts.map((f) => [f.id, f]));
    const merged: Fact[] = [];
    const seen = new Set<string>();
    for (const hit of relevantFacts) {
      const fact = tagged.get(hit.id);
      if (!fact || seen.has(fact.id)) continue;
      seen.add(fact.id);
      // The tag copy has no score — carry the ranked copy's across, it is the
      // only place the question's verdict on this fact exists.
      merged.push({ ...fact, trafnosc: hit.trafnosc });
    }
    for (const fact of tagFacts) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      merged.push(fact);
    }

    const wybrane = wybierzPoTrafnosci(merged);

    // Trim to token budget (rough 4-char/token estimate)
    const result: Fact[] = [];
    let tokenCount = 0;
    const charsPerToken = 4;

    for (const fact of wybrane) {
      const factTokens = Math.ceil(fact.content.length / charsPerToken);
      if (tokenCount + factTokens > maxTokens) break;
      result.push(fact);
      tokenCount += factTokens;
    }

    // Reinforce the whole tagged set, not the facts we chose to send.
    //
    // These two used to be the same list, and making the filter decide both
    // would have quietly started deleting memories: Shodh ages facts out on
    // `days_since_reinforcement`, so a fact that rarely matches a question
    // would stop being reinforced, weaken, and eventually be forgotten — with
    // nothing in our log to say so. What the model is shown is a privacy
    // decision; what memory keeps is not, and they must not be one knob.
    //
    // The cost is that natural forgetting stays switched off, which is fine
    // while this house has eleven facts and wrong once it has a thousand. That
    // is a threshold to set deliberately, not to inherit from a filter.
    if (merged.length > 0) {
      const ids = merged.map((f) => f.id);
      this.shodh.reinforce(userId, ids).catch(() => {
        // Non-critical, ignore errors
      });
    }

    return result;
  }

  /**
   * Add a new fact
   */
  async addFact(
    userId: string,
    content: string,
    category: FactCategory,
    confidence: number = 0.8
  ): Promise<string> {
    return this.shodh.remember(userId, content, category, confidence);
  }

  /**
   * Add multiple facts in a single batch call
   */
  async addFacts(
    userId: string,
    facts: { content: string; category: FactCategory; confidence?: number }[]
  ): Promise<string[]> {
    if (facts.length === 0) return [];
    if (facts.length === 1) {
      const f = facts[0];
      const id = await this.addFact(userId, f.content, f.category, f.confidence);
      return [id];
    }
    return this.shodh.rememberBatch(userId, facts);
  }

  /**
   * Check if a fact exists (semantic similarity check)
   * With Shodh, we rely on semantic deduplication
   */
  async factExists(userId: string, content: string): Promise<boolean> {
    const similar = await this.shodh.recall(userId, content, 5);
    // Check if any memory is very similar (this is approximate)
    return similar.some(
      (fact) =>
        fact.content.toLowerCase().includes(content.toLowerCase().slice(0, 50)) ||
        content.toLowerCase().includes(fact.content.toLowerCase().slice(0, 50))
    );
  }

  /**
   * Add fact if it doesn't already exist
   */
  async addFactIfNew(
    userId: string,
    content: string,
    category: FactCategory,
    confidence: number = 0.8
  ): Promise<string | null> {
    // Shodh handles deduplication via semantic similarity
    // We can just add and let it manage
    return this.addFact(userId, content, category, confidence);
  }

  /**
   * Delete a fact explicitly
   */
  async deleteFact(userId: string, factId: string): Promise<boolean> {
    try {
      await this.shodh.forget(userId, factId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all facts for a user
   */
  async clearUserFacts(userId: string): Promise<number> {
    const facts = await this.getFacts(userId);
    let deleted = 0;
    for (const fact of facts) {
      try {
        await this.shodh.forget(userId, fact.id);
        deleted++;
      } catch {
        // Ignore individual failures
      }
    }
    return deleted;
  }

  /**
   * Get fact count for a user
   */
  async getFactCount(userId: string): Promise<number> {
    const facts = await this.shodh.recallByTags(userId);
    return facts.length;
  }

  close(): void {
    // No resources to clean up for the Shodh HTTP client
  }
}
