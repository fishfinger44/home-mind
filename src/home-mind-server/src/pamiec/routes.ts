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
 *
 * Jedynym wyjątkiem jest przeniesienie faktu do innego profilu (`przeniesFakt`).
 * Tam też ginie historia wpisu, ale bez tego wiedza o domu zapisana omyłkowo
 * pod jedną osobą zostaje niewidoczna dla wszystkich pozostałych — a przepisanie
 * jej ręcznie kosztuje dokładnie tyle samo.
 */

import { Router, type Request, type Response } from "express";

import type { IChatEngine, IFactExtractor } from "../llm/interface.js";
import { extractAndStoreFacts } from "../llm/tool-handler.js";
import type { IMemoryStore } from "../memory/interface.js";
import { czytajPominiecia, usunPominiecie } from "../memory/pominiete.js";
import { VALID_CATEGORIES } from "../memory/extraction-prompt.js";
import { SHARED_PROFILE_ID, isImpersonal } from "../memory/types.js";
import type { FactCategory } from "../memory/types.js";
import { loadRules } from "../rules/store.js";
import { sprawdzFaktyZRegulami, type FaktDoKontroli } from "./kontrola.js";
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

export interface WynikPrzeniesienia {
  status: number;
  /** Ustawione tylko przy niepowodzeniu — treść trafia wprost do panelu. */
  error?: string;
  /** `przeniesiony` — kopia powstała i źródło zniknęło; `scalony` — cel już to
   *  wiedział, więc została tylko usunięta kopia ze źródła. */
  wynik?: "przeniesiony" | "scalony";
  id?: string;
}

/**
 * Przenieś fakt z profilu osoby do wskazanego profilu (domyślnie wspólnego).
 *
 * Shodh nie umie zmienić właściciela wpisu, więc „przeniesienie" to zapis pod
 * nowym profilem i usunięcie starego. Fakt traci identyfikator, licznik użyć i
 * wagę — dokładnie to, przed czym broni brak edycji w tym panelu. Różnica jest
 * taka, że tu nie ma innej drogi: fakt zapisany pod niewłaściwym profilem jest
 * dla reszty domu niewidoczny, a jedyną alternatywą byłoby przepisanie go
 * ręcznie, czyli ta sama utrata, tylko wykonana przez człowieka.
 *
 * Kolejność jest celowa: najpierw zapis w celu, dopiero potem usunięcie ze
 * źródła. Awaria w połowie zostawia duplikat, który widać i da się skasować, a
 * nie dziurę po fakcie, którego już nikt nie odtworzy.
 *
 * Kategorie osobiste (`preference`, `identity`, `pattern`) są odrzucane, bo
 * profil wspólny z założenia ich nie trzyma — patrz `IMPERSONAL_FACT_CATEGORIES`.
 * Ta sama reguła rządzi zapisem z rozmowy, więc panel nie może jej obchodzić.
 */
export async function przeniesFakt(
  memory: IMemoryStore,
  zProfilu: string,
  factId: string,
  doProfilu: string = SHARED_PROFILE_ID
): Promise<WynikPrzeniesienia> {
  if (zProfilu === doProfilu) {
    return { status: 400, error: "Fakt już jest w tym profilu." };
  }

  const fakt = (await memory.getFacts(zProfilu)).find((f) => f.id === factId);
  if (!fakt) return { status: 404, error: "Nie ma takiego faktu w tym profilu." };

  if (doProfilu === SHARED_PROFILE_ID && !isImpersonal(fakt.category)) {
    return {
      status: 400,
      error: `Kategoria „${fakt.category}” opisuje osobę, a profil wspólny trzyma tylko wiedzę o domu.`,
    };
  }

  const id = await memory.addFactIfNew(
    doProfilu,
    fakt.content,
    fakt.category,
    fakt.confidence
  );
  await memory.deleteFact(zProfilu, factId);

  return id
    ? { status: 200, wynik: "przeniesiony", id }
    : { status: 200, wynik: "scalony" };
}

export function createPamiecRouter(
  memory: IMemoryStore,
  extractor: () => IFactExtractor,
  ha: { getEntities(domain?: string): Promise<{ entity_id: string; attributes?: Record<string, unknown> }[]> },
  llm: IChatEngine
): Router {
  const router = Router();

  /** Wspólne dla listy profilów i kontroli — obie potrzebują tej samej listy. */
  async function profileDomu(): Promise<{ id: string; nazwa: string }[]> {
    let osoby: { entity_id: string; attributes?: { friendly_name?: string } }[] = [];
    try {
      osoby = (await ha.getEntities("person")) as typeof osoby;
    } catch (err) {
      // Brak łączności z HA ma zubożyć listę, a nie wywrócić stronę.
      console.warn("[pamiec] nie udalo sie pobrac osob z HA:", err);
    }
    return zbierzProfile(osoby, czytajPominiecia().map((w) => w.userId));
  }

  router.get("/pamiec/profile", async (_req: Request, res: Response) => {
    const profile = await profileDomu();
    const zLicznikiem = await Promise.all(
      profile.map(async (p) => ({
        ...p,
        faktow: await memory.getFactCount(p.id).catch(() => 0),
      }))
    );
    res.json({ profile: zLicznikiem });
  });

  /**
   * Skonfrontuj pamięć z regułami domowymi.
   *
   * Sprawdzane są WSZYSTKIE profile naraz, nie tylko ten otwarty w panelu:
   * rozjazd z regułą nie wie, w czyim profilu leży, a najdroższy jest ten, o
   * którym się nie wie. Jedno wywołanie modelu na komplet — przy dzisiejszej
   * skali (kilkadziesiąt faktów, kilkanaście reguł) to około 2400 tokenów,
   * czyli taniej niż pętla po profilach.
   */
  router.post("/pamiec/kontrola", async (_req: Request, res: Response) => {
    try {
      const profile = await profileDomu();
      const fakty: FaktDoKontroli[] = [];
      for (const p of profile) {
        const ich = await memory.getFacts(p.id).catch(() => []);
        for (const f of ich) fakty.push({ id: f.id, userId: p.id, content: f.content });
      }
      res.json(await sprawdzFaktyZRegulami(llm, loadRules(), fakty));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Nieznany błąd";
      console.error("[pamiec] kontrola nie powiodla sie:", message);
      res.status(500).json({ error: message });
    }
  });

  /**
   * Przenieś fakt do innego profilu — w praktyce do wspólnego, gdy ekstrakcja
   * przypisała wiedzę o domu konkretnej osobie.
   */
  router.post(
    "/pamiec/:userId/fakty/:factId/przenies",
    async (req: Request, res: Response) => {
      try {
        const wynik = await przeniesFakt(
          memory,
          String(req.params.userId),
          String(req.params.factId),
          typeof req.body?.docelowy === "string" && req.body.docelowy
            ? req.body.docelowy
            : SHARED_PROFILE_ID
        );
        const { status, ...reszta } = wynik;
        res.status(status).json(reszta);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Nieznany błąd";
        console.error("[pamiec] nie udalo sie przeniesc faktu:", message);
        res.status(500).json({ error: message });
      }
    }
  );

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
