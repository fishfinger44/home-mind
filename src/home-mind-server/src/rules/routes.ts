/**
 * Reading, writing and sanity-checking the house rules.
 *
 * Kept apart from the main router because these endpoints serve an editor
 * rather than the assistant, and because the conflict check is the only place
 * in the server that asks the model about the server's own configuration.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { IChatEngine } from "../llm/interface.js";
import { EDYTOR_HTML } from "./editor.js";
import { loadRules, saveRules, type HouseRule } from "./store.js";

const RuleSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  text: z.string(),
  enabled: z.boolean(),
  protected: z.boolean(),
  suggested: z.boolean().optional().default(false),
});

const SaveSchema = z.object({ rules: z.array(RuleSchema) });
const CheckSchema = z.object({
  /** Rule being added or edited. Omit to audit the whole list against itself. */
  rule: RuleSchema.partial({ id: true, enabled: true, protected: true, suggested: true }).optional(),
});

/**
 * The instruction for the conflict check.
 *
 * Text matching cannot do this job: "graj przez script.zagraj_muzyke" and
 * "wywołaj media_player.play_media" share no word and still exclude each
 * other. That pair actually existed here for a week, one in the prompt and one
 * in memory, and cost an evening of confusing behaviour before anyone noticed.
 */
const CHECK_PROMPT = `Jesteś recenzentem reguł dla asystenta domowego. Dostajesz listę reguł.
Twoim jedynym zadaniem jest wskazać SPRZECZNOŚCI — pary reguł, których nie da się spełnić naraz.

Sprzeczność to na przykład: jedna reguła zabrania wywoływać usługę, a druga każe jej używać;
jedna każe dopytywać, druga każe zgadywać; dwie podają inną wartość tego samego ustawienia.
To NIE jest sprzeczność: dwie reguły o różnych urządzeniach, uszczegółowienie, wyjątek
opisany wprost jako wyjątek.

Odpowiedz wyłącznie w formacie:
KONFLIKT: <tytuł A> ⟷ <tytuł B> — <jedno zdanie, na czym polega>
Jeśli nie ma żadnej sprzeczności, odpowiedz dokładnie: BRAK`;

export function createRulesRouter(llm: IChatEngine): Router {
  const router = Router();

  router.get("/rules", (_req: Request, res: Response) => {
    res.json({ rules: loadRules() });
  });

  router.put("/rules", (req: Request, res: Response) => {
    const parsed = SaveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
    }
    // The whole list is replaced in one go: the editor always sends everything,
    // which keeps order authoritative and avoids merging concurrent edits.
    const saved = saveRules(parsed.data.rules as HouseRule[]);
    res.json({ rules: saved });
  });

  router.post("/rules/sprawdz", async (req: Request, res: Response) => {
    const parsed = CheckSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const istniejace = loadRules().filter((r) => r.enabled);
    const nowa = parsed.data.rule;
    const doSprawdzenia = [
      ...istniejace.map((r) => `[${r.title}]\n${r.text}`),
      ...(nowa?.text?.trim() ? [`[${nowa.title || "NOWA REGUŁA"}]\n${nowa.text}`] : []),
    ];

    if (doSprawdzenia.length < 2) {
      return res.json({ wynik: "BRAK", uwaga: "Za mało włączonych reguł, żeby coś się kłóciło." });
    }

    try {
      const odpowiedz = await llm.chat({
        message: doSprawdzenia.join("\n\n---\n\n"),
        userId: "kontrola-regul",
        // A fresh id each time: this is a one-shot review, not a conversation,
        // and it must not inherit or leave any history.
        conversationId: `sprawdzenie-${Date.now()}`,
        customPrompt: CHECK_PROMPT,
        // No memory and no web search — the rules are the entire input.
        memoryTokenLimit: 0,
        webSearchLimit: 0,
      });
      res.json({ wynik: (odpowiedz.response ?? "").trim() || "BRAK" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[rules] conflict check failed:", message);
      // A failed check must not block editing — say so and let the user decide.
      res.status(200).json({ wynik: "NIEZNANE", blad: message });
    }
  });

  return router;
}

/** The editor page itself, mounted outside /api so the sidebar can point at it. */
export function createRulesPage(): Router {
  const router = Router();
  router.get("/rules", (_req: Request, res: Response) => {
    res.type("html").send(EDYTOR_HTML);
  });
  return router;
}
