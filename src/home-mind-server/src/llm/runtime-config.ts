// Runtime LLM override: lets the provider/model be switched at runtime (via the
// HA integration options flow) and persisted so it survives a server restart.
// Falls back to the .env config when no override is stored.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { envOrUndefined } from "../env.js";

const OVERRIDE_PATH = envOrUndefined("LLM_OVERRIDE_PATH") ?? "/data/llm-override.json";

export interface LlmOverride {
  provider: "anthropic" | "openai" | "ollama" | "gemini";
  model: string;
  /** API key for the selected provider, when set from the HA options flow.
   *  When absent, the provider's key falls back to the .env config. */
  apiKey?: string;
  /** Every provider's key, by provider name.
   *
   *  Keeping only the active provider's key made switching provider a silent,
   *  unrecoverable loss: come back and the key falls through to the .env one,
   *  which is a DIFFERENT Google project — a free-tier key entered in the UI
   *  would quietly be replaced by a billed one. Trying a local model must not
   *  cost money, so the keys survive the round trip. */
  apiKeys?: Record<string, string>;
  /** Base URL override (OpenAI-compatible endpoints, e.g. Gemini). */
  baseUrl?: string;
  /** Every provider's base URL, by provider name. Same reason as `apiKeys`:
   *  the Gemini endpoint and an Ollama address must not evict each other. */
  baseUrls?: Record<string, string>;
  /** Key of a BILLED Google project, used only for `gemini_micro` web search.
   *  Kept separate from `apiKey` so the conversation can run on a free-tier key
   *  while search — which the free tier does not offer — runs on a paid one. */
  searchApiKey?: string;
}

/** Only the string entries of an untrusted object — the override file is
 *  hand-editable, so a malformed map must not become part of the config. */
function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1]
    )
  );
}

export function loadLlmOverride(): LlmOverride | null {
  try {
    if (!existsSync(OVERRIDE_PATH)) return null;
    const data = JSON.parse(readFileSync(OVERRIDE_PATH, "utf8"));
    if (data && typeof data.provider === "string" && typeof data.model === "string") {
      return {
        provider: data.provider,
        model: data.model,
        ...(typeof data.apiKey === "string" && data.apiKey ? { apiKey: data.apiKey } : {}),
        ...(typeof data.baseUrl === "string" && data.baseUrl ? { baseUrl: data.baseUrl } : {}),
        // Files written before per-provider storage carry only the active
        // provider's key; fold it in so the first switch does not lose it.
        apiKeys: {
          ...(typeof data.apiKey === "string" && data.apiKey
            ? { [data.provider]: data.apiKey }
            : {}),
          ...asStringMap(data.apiKeys),
        },
        baseUrls: {
          ...(typeof data.baseUrl === "string" && data.baseUrl
            ? { [data.provider]: data.baseUrl }
            : {}),
          ...asStringMap(data.baseUrls),
        },
        ...(typeof data.searchApiKey === "string" && data.searchApiKey
          ? { searchApiKey: data.searchApiKey }
          : {}),
      };
    }
  } catch (err) {
    console.warn(`[llm-config] could not read override: ${(err as Error).message}`);
  }
  return null;
}

export function saveLlmOverride(override: LlmOverride): void {
  try {
    mkdirSync(dirname(OVERRIDE_PATH), { recursive: true });
    writeFileSync(OVERRIDE_PATH, JSON.stringify(override, null, 2));
  } catch (err) {
    // Non-fatal: the switch still applies in memory for this process lifetime.
    console.warn(`[llm-config] could not persist override: ${(err as Error).message}`);
  }
}

export interface OllamaSuggestion {
  /** Ollama tag, i.e. what `ollama pull` takes and LLM_MODEL becomes. */
  name: string;
  /** VRAM the model needs to run fully on the GPU, GB. Weights plus the KV
   *  cache and buffers Home Mind's long prompt makes it reserve. */
  vramGb: number;
  /** What to expect of it as a house assistant — the only thing that decides
   *  whether a local model is usable here is whether it calls the six HA tools
   *  correctly in Polish, which is where small models fall down first. */
  note: string;
}

// Local models worth pulling, smallest first. Deliberately short: the picker
// accepts any tag typed by hand, so this is guidance, not a catalogue.
export const OLLAMA_SUGGESTIONS: OllamaSuggestion[] = [
  {
    name: "qwen3:4b",
    vramGb: 3.8,
    note: "fits a 4 GB card — the cheapest way to find out whether local tool calling works at all",
  },
  {
    name: "gemma3:4b",
    vramGb: 4.3,
    note: "same class as qwen3:4b, usually the stronger writer and the weaker tool caller",
  },
  {
    name: "qwen3:8b",
    vramGb: 6.4,
    note: "needs 8 GB; the first size where tool calls stop being a lottery",
  },
  {
    name: "gemma3:12b",
    vramGb: 9.3,
    note: "needs 12 GB — good Polish, heavier than qwen3:14b for the same job",
  },
  {
    name: "qwen3:14b",
    vramGb: 10.5,
    note: "needs 12 GB; the practical target for a household assistant on a local card",
  },
];

// Suggested models per provider (the POST endpoint accepts any string too).
export const AVAILABLE_MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
  ],
  openai: [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    // Flash-Lite has its own, far larger free-tier daily allowance than Flash
    // (the quota is per model), and still calls functions reliably — so it is
    // the practical choice for a free-tier household assistant.
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ],
  // Native Gemini API + Google Search grounding (same models, native endpoint).
  gemini: [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ],
  // Local inference. Unlike the hosted providers this list is a shopping list,
  // not an inventory — only a model that has been pulled onto the machine can
  // actually run. What is installed comes from GET /api/config/llm (`ollama`).
  ollama: OLLAMA_SUGGESTIONS.map((m) => m.name),
};
