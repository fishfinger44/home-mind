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
    /** Whether a local reasoning model may think first. Meaningful for Ollama
     *  only — the hosted providers reject the parameter that carries it. */
    thinking?: boolean;
    /** Czy shim rozmowny jest w ogole skonfigurowany (ROZMOWA_URL w .env). */
    rozmowaDostepna?: boolean;
    /** Czy zarty/zagadki/pogawedka maja isc na sciezke rozmowna. */
    rozmowaWlaczona?: boolean;
    /** Wybrany model i wysilek. `undefined` = nie wybrano, domysli poda shim. */
    rozmowaModel?: string;
    rozmowaEffort?: string;
  };
  apply: (
    provider: "anthropic" | "openai" | "ollama" | "gemini",
    model: string,
    apiKey?: string,
    baseUrl?: string,
    searchApiKey?: string,
    thinking?: boolean
  ) => void;
  /** Osobno od `apply`, bo to inna decyzja: `apply` wymaga providera i modelu,
   *  a zwykly wlacznik nie ma po co ich odsylac.
   *
   *  Pola sa opcjonalne KAZDE Z OSOBNA, bo panel przelacza po jednej galce
   *  naraz — brak pola znaczy "nie ruszaj", a nie "wyzeruj". */
  applyRozmowa?: (zmiana: { wlaczona?: boolean; model?: string; effort?: string }) => void;
  /** Lista modeli prosto ze shima — patrz komentarz przy GET /config/rozmowa. */
  modeleRozmowy?: () => Promise<{
    modele: { id: string; nazwa: string; effort: boolean }[];
    wysilki: string[];
    domyslny?: string;
    effortDomyslny?: string;
  }>;
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
    const { provider, model, apiKey, baseUrl, searchApiKey, thinking } = req.body ?? {};
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
          "Body must be { provider: 'anthropic'|'openai'|'ollama'|'gemini', model: string, apiKey?, baseUrl?, searchApiKey?, thinking? }",
      });
    }
    // Only a real boolean is a choice. Anything else (absent, null, a string)
    // leaves the stored setting alone rather than resetting it — otherwise a
    // client that does not know about the field would silently clear it on
    // every model change.
    if (thinking !== undefined && typeof thinking !== "boolean") {
      return res.status(400).json({ error: "`thinking` must be a boolean when present" });
    }
    const key = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
    const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
    // Separate key for the billed Google project used by `gemini_micro` search.
    const searchKey =
      typeof searchApiKey === "string" && searchApiKey.trim() ? searchApiKey.trim() : undefined;
    try {
      controller.apply(provider, model.trim(), key, url, searchKey, thinking);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true, current: controller.getCurrent() });
  });

  // Sciezka ROZMOWNA — wlacznik osobno od wyboru modelu.
  //
  // 🔑 Celowo wlasny endpoint, a nie pole w POST /config/llm: tamten wymaga
  // providera i modelu, a zwykly przelacznik w HA nie ma po co ich odsylac
  // (i nie powinien miec mozliwosci przypadkowej zmiany modelu).
  // Lista modeli przychodzi ZE SHIMA przy kazdym odczycie, a nie z tablicy
  // w tym pliku. Inaczej ta sama lista lezalaby w trzech miejscach (shim,
  // serwer, integracja HA) i po dodaniu modelu w jednym dalo by sie wybrac
  // w panelu cos, czego shim nie przyjmuje — blad widoczny dopiero przy
  // pierwszym pytaniu, czyli daleko od przyczyny.
  router.get("/config/rozmowa", async (_req: Request, res: Response) => {
    const c = controller.getCurrent();
    const lista = controller.modeleRozmowy
      ? await controller.modeleRozmowy()
      : { modele: [], wysilki: [] };
    res.json({
      dostepna: c.rozmowaDostepna ?? false,
      wlaczona: c.rozmowaWlaczona ?? false,
      // Gdy nikt nie wybieral, oddajemy domysl shima — panel ma pokazywac to,
      // co sie NAPRAWDE wydarzy, a nie puste pole.
      model: c.rozmowaModel ?? lista.domyslny,
      effort: c.rozmowaEffort ?? lista.effortDomyslny,
      modele: lista.modele,
      wysilki: lista.wysilki,
    });
  });

  router.post("/config/rozmowa", async (req: Request, res: Response) => {
    const { wlaczona, model, effort } = req.body ?? {};
    if (wlaczona !== undefined && typeof wlaczona !== "boolean") {
      return res.status(400).json({ error: "`wlaczona` must be a boolean when present" });
    }
    if (model !== undefined && (typeof model !== "string" || !model.trim())) {
      return res.status(400).json({ error: "`model` must be a non-empty string when present" });
    }
    if (effort !== undefined && (typeof effort !== "string" || !effort.trim())) {
      return res.status(400).json({ error: "`effort` must be a non-empty string when present" });
    }
    if (wlaczona === undefined && model === undefined && effort === undefined) {
      return res.status(400).json({
        error: "Body must set at least one of { wlaczona, model, effort }",
      });
    }
    if (!controller.applyRozmowa) {
      return res.status(501).json({ error: "Przelacznik rozmowy niedostepny w tej wersji" });
    }
    // Wlaczanie bez skonfigurowanego shima nie ma sensu i milczace przyjecie
    // takiego zadania konczyloby sie przelacznikiem, ktory "jest wlaczony",
    // a nic nie robi. Lepiej odmowic z powodem. To samo dotyczy wyboru modelu:
    // bez shima nie ma czego wybierac.
    if ((wlaczona || model || effort) && !(controller.getCurrent().rozmowaDostepna ?? false)) {
      return res.status(409).json({
        error: "Brak adresu shima — ustaw ROZMOWA_URL w .env i zrestartuj kontener",
      });
    }
    // Sprawdzamy u ZRODLA, a nie wobec wlasnej kopii listy: zapisany model,
    // ktorego shim nie zna, zamienilby kazda rozmowe w blad 502, a panel
    // pokazywalby przy tym poprawnie wybrana pozycje.
    if ((model || effort) && controller.modeleRozmowy) {
      const lista = await controller.modeleRozmowy();
      if (model && lista.modele.length && !lista.modele.some((m) => m.id === model.trim())) {
        return res.status(400).json({
          error: `Shim nie zna modelu "${model.trim()}". Dostepne: ${lista.modele
            .map((m) => m.id)
            .join(", ")}`,
        });
      }
      if (effort && lista.wysilki.length && !lista.wysilki.includes(effort.trim())) {
        return res.status(400).json({
          error: `Nieznany poziom wysilku "${effort.trim()}". Dostepne: ${lista.wysilki.join(", ")}`,
        });
      }
    }
    try {
      controller.applyRozmowa({
        ...(typeof wlaczona === "boolean" ? { wlaczona } : {}),
        ...(model ? { model: model.trim() } : {}),
        ...(effort ? { effort: effort.trim() } : {}),
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    const c = controller.getCurrent();
    res.json({
      ok: true,
      dostepna: c.rozmowaDostepna ?? false,
      wlaczona: c.rozmowaWlaczona ?? false,
      model: c.rozmowaModel,
      effort: c.rozmowaEffort,
    });
  });

  return router;
}
