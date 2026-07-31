// Endpoints to read and switch the active LLM provider/model at runtime.

import { Router, type Request, type Response } from "express";
import { AVAILABLE_MODELS, OLLAMA_SUGGESTIONS } from "../llm/runtime-config.js";
import { fetchOllamaStatus } from "../llm/ollama-catalog.js";

export interface LlmController {
  getCurrent: () => {
    provider: string;
    model: string;
    baseUrl?: string;
    hasApiKey?: boolean;
    /** Whether a separate billed key for `gemini_micro` web search is stored. */
    hasSearchApiKey?: boolean;
  };
  apply: (
    provider: "anthropic" | "openai" | "ollama" | "gemini",
    model: string,
    apiKey?: string,
    baseUrl?: string,
    searchApiKey?: string
  ) => void;
}

export function createLlmConfigRouter(
  controller: LlmController,
  /** Where a local Ollama would be, and how much VRAM the card has (null when
   *  not configured). Both only feed the `ollama` block of the GET response. */
  ollama: { baseUrl?: string; vramGb: number | null } = { vramGb: null }
): Router {
  const router = Router();

  router.get("/config/llm", async (_req: Request, res: Response) => {
    // getCurrent never returns the key itself — only whether one is set — so the
    // secret is never exposed over the API.
    //
    // The Ollama block is probed live because, unlike the hosted providers, the
    // list of models that can actually run changes whenever someone pulls one.
    // It is best-effort: a machine without Ollama still gets a working response.
    res.json({
      current: controller.getCurrent(),
      models: AVAILABLE_MODELS,
      ollama: {
        ...(await fetchOllamaStatus(ollama.baseUrl, ollama.vramGb)),
        suggestions: OLLAMA_SUGGESTIONS,
      },
    });
  });

  router.post("/config/llm", (req: Request, res: Response) => {
    const { provider, model, apiKey, baseUrl, searchApiKey } = req.body ?? {};
    if (
      (provider !== "anthropic" &&
        provider !== "openai" &&
        provider !== "ollama" &&
        provider !== "gemini") ||
      typeof model !== "string" ||
      !model.trim()
    ) {
      return res.status(400).json({
        error:
          "Body must be { provider: 'anthropic'|'openai'|'ollama'|'gemini', model: string, apiKey?, baseUrl?, searchApiKey? }",
      });
    }
    const key = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
    const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
    // Separate key for the billed Google project used by `gemini_micro` search.
    const searchKey =
      typeof searchApiKey === "string" && searchApiKey.trim() ? searchApiKey.trim() : undefined;
    try {
      controller.apply(provider, model.trim(), key, url, searchKey);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true, current: controller.getCurrent() });
  });

  return router;
}
