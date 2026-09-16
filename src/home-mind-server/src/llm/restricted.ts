/**
 * Devices only a recognised voice may operate.
 *
 * Everything in the house answers to anyone — lights, music, films — because a
 * guest or a child asking for the lights is not a problem worth solving. These
 * are the exceptions: things that move, run for half an hour, or change the
 * temperature of the house. A stranger's voice, the television, or a
 * transcription of silence should not be able to start them.
 *
 * The list exists because of a real incident. At ten to midnight a hand-clap
 * reached the assistant as "Jeden.", it offered to clean room one, and an
 * unrelated "tak" started the kitchen mop. Nothing in that chain came from a
 * recognised speaker.
 *
 * Which groups are restricted is a household decision, not a code decision, so
 * it is stored in `/data/ograniczenia.json` and edited from the voice panel —
 * the same place people are enrolled. Recognition and what recognition buys are
 * one subject, and splitting them across two screens would mean setting up a
 * voiceprint in one place and finding out what it is for in another.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { envOrUndefined } from "../env.js";

/** Read per call, not once at import: tests point it at a scratch directory. */
function sciezka(): string {
  return envOrUndefined("RESTRICTIONS_PATH") ?? "/data/ograniczenia.json";
}

/**
 * A group of devices as a household thinks of them, rather than as Home
 * Assistant does.
 *
 * Domains alone are not enough. The Roborock routine buttons matter most: they
 * start the vacuum without touching the `vacuum` domain at all, which is
 * exactly how it was started by accident. Restricting the domain alone would
 * leave the door open, and nobody choosing "the vacuum" in a list means "the
 * vacuum, except through its own shortcuts".
 */
export interface GrupaUrzadzen {
  id: string;
  nazwa: string;
  /** One line under the name in the panel, saying what is at stake. */
  opis: string;
  domeny: string[];
  /** Entities outside those domains that belong to the same group anyway. */
  wzory?: RegExp[];
  /** Restricted unless the household says otherwise. */
  domyslnie: boolean;
}

export const GRUPY_URZADZEN: GrupaUrzadzen[] = [
  {
    id: "odkurzacz",
    nazwa: "Odkurzacz",
    opis: "Także skróty i rutyny Roborocka — tą drogą ruszył przypadkiem.",
    domeny: ["vacuum"],
    wzory: [/^button\..*roborock/i],
    domyslnie: true,
  },
  {
    id: "rolety",
    nazwa: "Rolety",
    opis: "Otwieranie, zamykanie i zatrzymanie w połowie drogi.",
    domeny: ["cover"],
    domyslnie: true,
  },
  {
    id: "klimatyzacja",
    nazwa: "Klimatyzacja",
    opis: "Wyłączenie w upał boli tak samo jak włączenie. Odczyt temperatury zostaje dla wszystkich.",
    domeny: ["climate"],
    wzory: [/^switch\.580d0d2f9e31/i],
    domyslnie: true,
  },
  {
    id: "swiatlo",
    nazwa: "Światło",
    opis: "Zwykle dostępne dla wszystkich — gość proszący o światło to nie problem.",
    domeny: ["light"],
    domyslnie: false,
  },
  {
    id: "muzyka",
    nazwa: "Muzyka i filmy",
    opis: "Odtwarzacze, Apple TV, projektor. Domyślnie dla wszystkich.",
    domeny: ["media_player"],
    wzory: [/^script\.zagraj/i, /^media_assistant\./i],
    domyslnie: false,
  },
  {
    id: "zamki",
    nazwa: "Zamki i bramy",
    opis: "Nic takiego nie jest teraz wystawione — ustawienie czeka na przyszłość.",
    domeny: ["lock"],
    domyslnie: true,
  },
];

export interface Ograniczenia {
  /** Ids of the groups a stranger's voice may not operate. */
  grupy: string[];
  /**
   * Groups taken away from a specific household member, keyed by the id the
   * assistant receives as `userId`.
   *
   * A DENY list, not an allow list, and the household chose it that way
   * (2026-08-08): being recognised keeps meaning what it has always meant, so
   * enrolling somebody never quietly narrows what they could already do, and
   * existing people needed no migration. The cost is the other direction —
   * enrolling a child opens everything to them until somebody unticks a box —
   * so the panel says so on the tab of anyone with no entry here.
   *
   * The key is whatever `userId` the request carries. For voice that is the
   * Home Assistant person id (`lech`, `wladek`), because the integration maps
   * the voiceprint through `person.*`. A phone logged into Home Assistant
   * sends the account uuid instead and so has no entry — which is correct: an
   * account holder has already authenticated themselves, and this list is
   * about voices.
   */
  osoby?: Record<string, string[]>;
}

export function domyslneOgraniczenia(): Ograniczenia {
  return {
    grupy: GRUPY_URZADZEN.filter((g) => g.domyslnie).map((g) => g.id),
    osoby: {},
  };
}

/** Keep only real group ids, and drop people left with nothing taken away. */
function czysteOsoby(surowe: unknown): Record<string, string[]> {
  if (!surowe || typeof surowe !== "object" || Array.isArray(surowe)) return {};
  const wynik: Record<string, string[]> = {};
  for (const [osoba, grupy] of Object.entries(surowe as Record<string, unknown>)) {
    if (!osoba || !Array.isArray(grupy)) continue;
    const znane = GRUPY_URZADZEN.filter((g) => grupy.includes(g.id)).map((g) => g.id);
    if (znane.length > 0) wynik[osoba] = znane;
  }
  return wynik;
}

let cache: Ograniczenia | null = null;

export function wczytajOgraniczenia(): Ograniczenia {
  if (cache) return cache;
  if (!existsSync(sciezka())) {
    cache = domyslneOgraniczenia();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(sciezka(), "utf-8"));
    cache = {
      grupy: Array.isArray(parsed?.grupy)
        ? parsed.grupy.filter((id: unknown) => GRUPY_URZADZEN.some((g) => g.id === id))
        : domyslneOgraniczenia().grupy,
      osoby: czysteOsoby(parsed?.osoby),
    };
    return cache;
  } catch (err) {
    // A broken file must not lock the house down, nor throw it open: fall back
    // to the defaults, which are the settings the household chose out loud.
    console.error(`[ograniczenia] nie mogę odczytać ${sciezka()}:`, err);
    cache = domyslneOgraniczenia();
    return cache;
  }
}

export function zapiszOgraniczenia(nowe: Ograniczenia): Ograniczenia {
  const czyste: Ograniczenia = {
    grupy: GRUPY_URZADZEN.filter((g) => nowe.grupy?.includes(g.id)).map((g) => g.id),
    osoby: czysteOsoby(nowe.osoby),
  };
  mkdirSync(dirname(sciezka()), { recursive: true });
  writeFileSync(sciezka(), JSON.stringify(czyste, null, 2), "utf-8");
  cache = czyste;
  const odebrane = Object.entries(czyste.osoby ?? {})
    .map(([osoba, grupy]) => `${osoba}: -${grupy.join("/")}`)
    .join(", ");
  console.log(
    `[ograniczenia] zapisane: ${czyste.grupy.join(", ") || "brak"}` +
      (odebrane ? ` | odebrane osobom — ${odebrane}` : "")
  );
  return czyste;
}

/** Test seam: drop the cache so the next read hits the disk again. */
export function resetRestrictionsCache(): void {
  cache = null;
}

export interface RestrictionVerdict {
  allowed: boolean;
  /** What to tell the model, in the language it answers in. */
  reason?: string;
}

/** Which of `kandydaci` this call touches, by domain, entity domain or pattern. */
function trafionaGrupa(
  domain: string | undefined,
  entityId: string | undefined,
  kandydaci: GrupaUrzadzen[]
): GrupaUrzadzen | undefined {
  const encje = (entityId ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return kandydaci.find((g) => {
    if (domain && g.domeny.includes(domain.toLowerCase())) return true;
    return encje.some(
      (e) =>
        g.domeny.includes(e.split(".")[0]?.toLowerCase() ?? "") ||
        (g.wzory ?? []).some((w) => w.test(e))
    );
  });
}

export function checkRestriction(
  domain: string | undefined,
  /**
   * Nieużywane od 08.08, zostaje świadomie. Póki żyła ulga „wolno zatrzymywać",
   * to ono o niej decydowało; dziś zamknięta grupa jest zamknięta w obie
   * strony, więc nazwa usługi niczego nie zmienia. Parametr zostaje, bo jest
   * naturalną częścią tożsamości wywołania i usunięcie go przestawiłoby
   * pozycyjnie wszystkie wywołania oraz testy — za cenę zera.
   */
  service: string | undefined,
  entityId: string | undefined,
  speakerRecognised: boolean,
  /**
   * Who is asking, when we know. Only consulted for a recognised speaker —
   * an unrecognised voice is judged by `grupy` alone, whoever it claims to be.
   */
  mowca?: string
): RestrictionVerdict {
  const ustawienia = wczytajOgraniczenia();

  // Obie osie działają tak samo: zamknięta grupa jest zamknięta w OBIE STRONY.
  //
  // Do 08.08 obcy głos miał ulgę — wolno mu było zatrzymać i wyłączyć to,
  // czego nie wolno mu było uruchomić. Uzasadnieniem był kierunek ryzyka:
  // uruchomienie budzi dom, zatrzymanie nie, a odmowa wyłączenia to
  // utrudnianie, nie ostrożność. Dom to odrzucił i ma rację, bo założenie
  // trzymało się tylko dla części sprzętu: wyłączenie klimatyzacji w upał albo
  // zatrzymanie rolet w połowie drogi jest równie dotkliwe jak włączenie —
  // wyjątek `bezUlgi` istniał właśnie po to, żeby to łatać. Reguła z jednym
  // wyjątkiem na sześć grup nie jest regułą, tylko zgadywanką, a lista, którą
  // dom sam odklika, mówi wprost, czego ma nie ruszać nikt niepowołany.
  //
  // Odczyt stanu jest nietknięty w obu wypadkach — te reguły dotyczą wyłącznie
  // `call_service`, więc o temperaturę może zapytać każdy.
  const zamkniete = speakerRecognised
    ? (mowca ? (ustawienia.osoby?.[mowca] ?? []) : [])
    : ustawienia.grupy;

  if (zamkniete.length === 0) return { allowed: true };

  const trafiona = trafionaGrupa(
    domain,
    entityId,
    GRUPY_URZADZEN.filter((g) => zamkniete.includes(g.id))
  );
  if (!trafiona) return { allowed: true };

  // Powód odmowy MUSI się różnić. Powiedzenie komuś, kogo właśnie
  // rozpoznaliśmy, że go nie rozpoznajemy, jest nieprawdą i wysyła go w
  // powtarzanie polecenia bez końca.
  return {
    allowed: false,
    reason: speakerRecognised
      ? `Odmowa: „${trafiona.nazwa}” nie jest dostępna dla tego domownika. ` +
        "Dotyczy to zarówno włączania, jak i wyłączania; odczyt stanu jest dozwolony. " +
        "Powiedz to użytkownikowi wprost, nie tłumacz się nierozpoznaniem głosu " +
        "i nie szukaj innej drogi do tego samego urządzenia."
      : `Odmowa: „${trafiona.nazwa}” obsługuje tylko rozpoznany domownik, ` +
        "a tego głosu nie rozpoznałem. Dotyczy to zarówno włączania, jak i " +
        "wyłączania; odczyt stanu jest dozwolony dla każdego. " +
        "Powiedz to użytkownikowi wprost i nie szukaj innej drogi do tego samego urządzenia.",
  };
}

/**
 * W czyim imieniu wykonać polecenie, gdy w turze mówiło kilka osób.
 *
 * 🔴 TO JEST BRAMKA UPRAWNIEŃ, nie wygoda. Model widzi podpisane wypowiedzi
 * („Lech: wyłącz projektor / Władek: zapal światło") i sam wskazuje, czyją
 * prośbę realizuje. Gdyby serwer brał to wskazanie na wiarę, pomyłka modelu
 * wydałaby komuś cudze uprawnienia — a to jedyna rzecz stojąca między głosem z
 * telewizora a odkurzaczem.
 *
 * Dlatego wskazanie jest SPRAWDZANE wobec listy tych, którzy w tej turze
 * naprawdę mówili I zostali rozpoznani. Wskazanie kogokolwiek spoza tej listy
 * nie jest traktowane jak pomyłka do naprawienia, tylko jako brak podstawy —
 * i schodzi do praw głosu nierozpoznanego.
 *
 * @param mowca właściciel tury: kto ją otworzył (zachowanie sprzed 16.09)
 * @param naProsbe kogo wskazał model (`na_prosbe` w `call_service`)
 */
export function ustalSprawce(
  mowca: string | undefined,
  speakerRecognised: boolean,
  naProsbe: string | undefined,
  wypowiedzi?: { mowca?: string | null; userId?: string | null; userName?: string | null; rozpoznany?: boolean }[]
): { sprawca: string | undefined; rozpoznany: boolean; powod?: string } {
  // Bez wskazania albo bez podziału na mówców wszystko zostaje po staremu.
  if (!naProsbe || !wypowiedzi?.length) {
    return { sprawca: mowca, rozpoznany: speakerRecognised };
  }

  const szukane = naProsbe.trim().toLowerCase();
  const pasuje = wypowiedzi.find(
    (w) =>
      w.rozpoznany === true &&
      [w.userId, w.mowca, w.userName].some(
        (k) => typeof k === "string" && k.toLowerCase() === szukane
      )
  );

  if (!pasuje) {
    return {
      sprawca: undefined,
      rozpoznany: false,
      powod: `wskazano '${naProsbe}', ale nikt taki nie mówił w tej turze`,
    };
  }
  return { sprawca: pasuje.userId ?? pasuje.mowca ?? undefined, rozpoznany: true };
}
