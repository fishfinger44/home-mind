/**
 * LLM Interface
 *
 * Provider-agnostic interfaces for chat and fact extraction.
 * Concrete implementations (Anthropic, OpenAI, etc.) implement these.
 */

import type { ExtractedFact, Fact } from "../memory/types.js";

/**
 * How the assistant reaches the internet.
 *
 * - `grounding` — the model itself searches, server-side, inside the same
 *   request (Gemini's `googleSearch` tool). One API call, the whole prompt is
 *   sent once: the cheapest and fastest option. Requires a Google project WITH
 *   billing — the free tier lists Search grounding as "Not available" and
 *   rejects such requests with 429 RESOURCE_EXHAUSTED.
 * - `gemini_micro` — we expose our own `web_search` tool and answer it with a
 *   separate, tiny grounded request against a SECOND (billed) key. Lets the
 *   conversation run on a free key while search runs on a billed project, at
 *   the cost of a second full-prompt round-trip.
 * - `tavily` / `brave` — our own `web_search` tool backed by a third-party
 *   search API. Google sees nothing, not even the query; results are raw
 *   snippets rather than a synthesized answer.
 * - `searxng` — the same tool, answered by a SearXNG instance we host
 *   ourselves. No key, no account, no allowance to run out of; the public
 *   engines behind it can rate-limit the house IP, so it works best as the
 *   fallback the metered backends drop into.
 */
export type WebSearchMode = "grounding" | "gemini_micro" | "tavily" | "searxng" | "brave";

export const WEB_SEARCH_MODES: readonly WebSearchMode[] = [
  "grounding",
  "gemini_micro",
  "tavily",
  "searxng",
  "brave",
] as const;

// Chat types (LLM-agnostic)
export interface ChatRequest {
  message: string;
  userId: string;
  conversationId?: string;
  isVoice?: boolean;
  customPrompt?: string;
  /** Entity IDs exposed to Assist in HA; when set, the home layout + device
   *  cheat sheet are restricted to these (keeps unselected entities out of the
   *  prompt). */
  exposedEntities?: string[];
  /** Max web_search calls the model may make per request (HA option). 0 = no
   *  internet; default 1. Higher = more thorough but more LLM round-trips. */
  webSearchLimit?: number;
  /** Token budget for recalled facts sent to the LLM (HA option). 0 = send no
   *  memory at all (and skip the recall round-trip); omitted = server default
   *  (MEMORY_TOKEN_LIMIT). More memory = better personalisation, more tokens
   *  on every single request. */
  memoryTokenLimit?: number;
  /** How the assistant reaches the internet (HA option). See WebSearchMode. */
  webSearchMode?: WebSearchMode;
}

/**
 * Structured failure information emitted when chat produces no usable
 * response (no text and no tool call). The HA integration surfaces
 * `hint` to the user instead of the generic "I received your request but
 * got no response." fallback, so failures are diagnosable from HA Assist
 * without needing server logs.
 */
export interface ChatError {
  code:
    | "EMPTY_CONTENT"
    | "MAX_TOKENS_TRUNCATED"
    | "CONTENT_FILTERED";
  hint: string;
}

export interface ChatResponse {
  response: string;
  toolsUsed: string[];
  factsLearned: number;
  error?: ChatError;
}

export type StreamCallback = (chunk: string) => void;

// Provider interfaces
export interface IChatEngine {
  chat(request: ChatRequest, onChunk?: StreamCallback): Promise<ChatResponse>;
}

export interface IFactExtractor {
  extract(
    userMessage: string,
    assistantResponse: string,
    existingFacts?: Fact[]
  ): Promise<ExtractedFact[]>;
}
