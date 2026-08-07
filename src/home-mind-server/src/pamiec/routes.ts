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

/**
 * Zbierz listę profilów z tego, co wiemy — bo pamięć sama tego nie powie.
 *
 * Shodh przyjmuje `userId` w każdej metodzie i nie ma niczego w rodzaju
 * „wymień wszystkich"; magazyn rozmów zna tylko tych, którzy odezwali się od
 * ostatniego restartu, bo domyślnie żyje w pamięci. Zostają dwa źródła, które
 * naprawdę coś wiedzą: osoby w Home Assistancie (stamtąd bierze się profil,
 * gdy biometria kogoś rozpozna) i dziennik odrzuceń, który jest trwały i
 * zapamiętuje `userId` każdej odrzuconej tury. Suma tych dwóch plus profil
 * wspólny daje listę, która sama urośnie, gdy pojawi się drugi domownik.
 */
export function zbierzProfile(
  osobyHA: { entity_id: string; attributes?: { friendly_name?: string } }[],
  zDziennika: string[]
): { id: string; nazwa: string }[] {
  const profile = new Map<string, string>();
  profile.set(SHARED_PROFILE_ID, "wspólny — wiedza o domu");

  for (const osoba of osobyHA) {
    const id = osoba.entity_id.split(".")[1];
    if (id) profile.set(id, osoba.attributes?.friendly_name ?? id);
  }
  // Profil widziany w dzienniku na pewno jest w użyciu, nawet jeśli osoba
  // zniknęła z HA albo nigdy nie była tam zdefiniowana.
  for (const id of zDziennika) if (id && !profile.has(id)) profile.set(id, id);

  return [...profile].map(([id, nazwa]) => ({ id, nazwa }));
}

export function createPamiecRouter(
  memory: IMemoryStore,
  extractor: () => IFactExtractor,
  ha: { getEntities(domain?: string): Promise<{ entity_id: string; attributes?: Record<string, unknown> }[]> }
): Router {
  const router = Router();

  router.get("/pamiec/profile", async (_req: Request, res: Response) => {
    let osoby: { entity_id: string; attributes?: { friendly_name?: string } }[] = [];
    try {
      osoby = (await ha.getEntities("person")) as typeof osoby;
    } catch (err) {
      // Brak łączności z HA ma zubożyć listę, a nie wywrócić stronę.
      console.warn("[pamiec] nie udalo sie pobrac osob z HA:", err);
    }

    const profile = zbierzProfile(osoby, czytajPominiecia().map((w) => w.userId));
    const zLicznikiem = await Promise.all(
      profile.map(async (p) => ({
        ...p,
        faktow: await memory.getFactCount(p.id).catch(() => 0),
      }))
    );
    res.json({ profile: zLicznikiem });
  });

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
