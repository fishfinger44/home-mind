// Endpoints to read and switch the active LLM provider/model at runtime.

import { Router, type Request, type Response } from "express";
import { AVAILABLE_MODELS } from "../llm/runtime-config.js";

export interface LlmController {
  getCurrent: () => {
    provider: string;
    model: string;
    baseUrl?: string;
    hasApiKey?: boolean;
  };
  apply: (
    provider: "anthropic" | "openai" | "ollama" | "gemini",
    model: string,
    apiKey?: string,
    baseUrl?: string
  ) => void;
}

export function createLlmConfigRouter(controller: LlmController): Router {
  const router = Router();

  router.get("/config/llm", (_req: Request, res: Response) => {
    // getCurrent never returns the key itself — only whether one is set — so the
    // secret is never exposed over the API.
    res.json({ current: controller.getCurrent(), models: AVAILABLE_MODELS });
  });

  router.post("/config/llm", (req: Request, res: Response) => {
    const { provider, model, apiKey, baseUrl } = req.body ?? {};
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
          "Body must be { provider: 'anthropic'|'openai'|'ollama'|'gemini', model: string, apiKey?, baseUrl? }",
      });
    }
    const key = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
    const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
    try {
      controller.apply(provider, model.trim(), key, url);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true, current: controller.getCurrent() });
  });

  return router;
}
