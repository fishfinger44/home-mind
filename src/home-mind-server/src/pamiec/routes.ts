/**
 * Dziennik odrzuceń: odczyt, usuwanie i przyjmowanie wpisów do pamięci.
 *
 * Same fakty obsługuje istniejące API pamięci (`/api/memory/:userId`) — tutaj
 * jest tylko to, czego ono nie umie: druga strona filtrów, czyli materiał,
 * którego pamięć NIE przyjęła.
 *
 * Świadomie nie ma edycji faktów ani ich wyłączania. Shodh nie zna aktualizacji
 * — poprawka literówki znaczyłaby usunięcie i dodanie na nowo, a więc utratę
 * identyfikatora, licznika użyć i wagi, którą fakt zbierał tygodniami. Nie ma
 * też pojęcia „jest, ale nieaktywny". Udawanie obu rzeczy w panelu psułoby
 * model pamięci, żeby interfejs wyglądał symetrycznie do edytora reguł.
 */

import { Router, type Request, type Response } from "express";

import type { IFactExtractor } from "../llm/interface.js";
import { extractAndStoreFacts } from "../llm/tool-handler.js";
import type { IMemoryStore } from "../memory/interface.js";
import { czytajPominiecia, usunPominiecie } from "../memory/pominiete.js";
import { VALID_CATEGORIES } from "../memory/extraction-prompt.js";
import { SHARED_PROFILE_ID } from "../memory/types.js";
import type { FactCategory } from "../memory/types.js";
import { EDYTOR_PAMIECI_HTML } from "./editor.js";

export function createPamiecRouter(
  memory: IMemoryStore,
  extractor: () => IFactExtractor
): Router {
  const router = Router();

  router.get("/pominiete", (_req: Request, res: Response) => {
    res.json({ pominiete: czytajPominiecia() });
  });

  router.delete("/pominiete/:id", (req: Request, res: Response) => {
    res.json({ usuniete: usunPominiecie(String(req.params.id)) });
  });

  /**
   * Przyjmij odrzucony wpis do pamięci.
   *
   * Wpisy są dwojakiego rodzaju i wymagają różnych dróg:
   * - `filtr` — treść JEST gotowym faktem, który filtr uznał za śmieć, więc
   *   wystarczy ją zapisać; kategorię musi wskazać człowiek, bo dziennik jej
   *   nie zapamiętuje.
   * - `bramka` — treść to surowa wypowiedź („Zgaś światło w kuchni"), a nie
   *   fakt. Zapisanie jej wprost byłoby dokładnie tym, przed czym broni
   *   bramka, więc zamiast tego przepuszczamy ją przez ekstraktor.
   */
  router.post("/pominiete/:id/przyjmij", async (req: Request, res: Response) => {
    const wpis = czytajPominiecia().find((w) => w.id === req.params.id);
    if (!wpis) return res.status(404).json({ error: "Nie ma takiego wpisu" });

    try {
      if (wpis.rodzaj === "filtr") {
        const kategoria = req.body?.kategoria;
        if (!(VALID_CATEGORIES as readonly string[]).includes(kategoria)) {
          return res.status(400).json({
            error: `Podaj kategorię: ${VALID_CATEGORIES.join(", ")}`,
          });
        }
        await memory.addFact(wpis.userId, wpis.tresc, kategoria as FactCategory);
        usunPominiecie(wpis.id);
        return res.json({ zapisane: 1, sposob: "wprost" });
      }

      // Bez `toolsUsed` bramka nie ma na czym zadziałać, więc ekstrakcja
      // przebiega tak, jakby tej tury nigdy nie pominięto.
      const ile = await extractAndStoreFacts(
        memory,
        extractor(),
        wpis.userId,
        wpis.tresc,
        "",
        true,
        SHARED_PROFILE_ID
      );
      usunPominiecie(wpis.id);
      res.json({ zapisane: ile, sposob: "ekstrakcja" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Nieznany błąd";
      console.error("[pamiec] nie udalo sie przyjac wpisu:", message);
      res.status(500).json({ error: message });
    }
  });

  return router;
}

/** Sama strona, poza `/api`, żeby pasek boczny mógł wskazać zwykły adres. */
export function createPamiecPage(): Router {
  const router = Router();
  router.get("/pamiec", (_req: Request, res: Response) => {
    res.type("html").send(EDYTOR_PAMIECI_HTML);
  });
  return router;
}
