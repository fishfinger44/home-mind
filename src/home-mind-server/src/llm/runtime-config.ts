// Runtime LLM override: lets the provider/model be switched at runtime (via the
// HA integration options flow) and persisted so it survives a server restart.
// Falls back to the .env config when no override is stored.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OVERRIDE_PATH = process.env.LLM_OVERRIDE_PATH ?? "/data/llm-override.json";

export interface LlmOverride {
  provider: "anthropic" | "openai" | "ollama" | "gemini";
  model: string;
  /** API key for the selected provider, when set from the HA options flow.
   *  When absent, the provider's key falls back to the .env config. */
  apiKey?: string;
  /** Base URL override (OpenAI-compatible endpoints, e.g. Gemini). */
  baseUrl?: string;
  /** Key of a BILLED Google project, used only for `gemini_micro` web search.
   *  Kept separate from `apiKey` so the conversation can run on a free-tier key
   *  while search — which the free tier does not offer — runs on a paid one. */
  searchApiKey?: string;
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
};
