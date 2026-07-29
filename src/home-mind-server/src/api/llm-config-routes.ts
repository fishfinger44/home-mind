// Endpoints to read and switch the active LLM provider/model at runtime.

import { Router, type Request, type Response } from "express";
import { AVAILABLE_MODELS } from "../llm/runtime-config.js";

export interface LlmController {
  getCurrent: () => { provider: string; model: string };
  apply: (provider: "anthropic" | "openai" | "ollama", model: string) => void;
}

export function createLlmConfigRouter(controller: LlmController): Router {
  const router = Router();

  router.get("/config/llm", (_req: Request, res: Response) => {
    res.json({ current: controller.getCurrent(), models: AVAILABLE_MODELS });
  });

  router.post("/config/llm", (req: Request, res: Response) => {
    const { provider, model } = req.body ?? {};
    if (
      (provider !== "anthropic" && provider !== "openai" && provider !== "ollama") ||
      typeof model !== "string" ||
      !model.trim()
    ) {
      return res.status(400).json({
        error: "Body must be { provider: 'anthropic'|'openai'|'ollama', model: string }",
      });
    }
    try {
      controller.apply(provider, model.trim());
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true, current: controller.getCurrent() });
  });

  return router;
}
