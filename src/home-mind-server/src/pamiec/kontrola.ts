/**
 * Kontrola faktów względem reguł domowych.
 *
 * Sprawdzacz w edytorze reguł porównuje reguły z regułami — a para, która go
 * uzasadniła („graj przez script.zagraj_muzyke" kontra „wywołaj
 * media_player.play_media"), miała jedną stronę w promptcie, a drugą w
 * PAMIĘCI. Ten przypadek został wtedy poza zasięgiem i to jest jego łatka.
 *
 * Dlaczego to musi być LLM, a nie porównanie tekstu: od 11.08.2026 obie strony
 * są po polsku, ale to niczego nie ułatwia — „w salonie świeci się ciepło"
 * i „Salon: temperatura barwowa 2700 K" nie mają wspólnego słowa, a mówią to
 * samo, i wciąż leżą w bazie angielskie zaszłości sprzed przejścia na polski.
 * Żadna heurystyka na wspólnych słowach tego nie złapie.
 *
 * Strony NIE są równorzędne — i to jest cała różnica wobec kontroli reguł.
 * Reguła jest pisana ręcznie, wersjonowana i objęta sprawdzaczem sprzeczności;
 * fakt powstał sam podczas rozmowy i jest zbywalny. Więc wynikiem nie jest
 * „rozstrzygnij, która strona ma rację", tylko wskazanie faktu do skasowania.
 * Inaczej powstałby panel zadający pytanie o zawsze tej samej odpowiedzi.
 */

import type { IChatEngine } from "../llm/interface.js";
import type { HouseRule } from "../rules/store.js";

export interface FaktDoKontroli {
  id: string;
  userId: string;
  content: string;
}

export interface Znalezisko {
  /** `sprzeczny` — fakt mówi co innego niż reguła; `pokryty` — powtarza ją. */
  rodzaj: "sprzeczny" | "pokryty";
  factId: string;
  userId: string;
  tresc: string;
  /** Tytuł reguły, o którą chodzi. */
  regula: string;
  dlaczego: string;
}

const KONTROLA_PROMPT = `Jesteś recenzentem pamięci asystenta domowego. Dostajesz REGUŁY DOMOWE i FAKTY z pamięci.

Reguły są autorytatywne — pisze je człowiek. Fakty zapisuje automat podczas rozmów i wolno je skasować.
Twoim zadaniem jest wskazać fakty, które nie powinny już leżeć w pamięci, w dwóch kategoriach:

SPRZECZNY — fakt mówi coś innego niż reguła (inny numer, inna nazwa encji, inna procedura, inna wartość).
POKRYTY — fakt powtarza to, co reguła już mówi, bez sprzeczności. Nic nie wnosi.

Porównuj ZNACZENIE, nie słowa — ta sama wiedza bywa zapisana zupełnie inaczej.
Część starszych faktów jest po angielsku: „carpet" to „Dywan", „kitchen" to „Kuchnia".

To NIE jest powód do zgłoszenia: fakt o czymś, o czym żadna reguła nie mówi; uszczegółowienie,
którego reguła nie zawiera; osobista informacja o człowieku (imię, rodzina, upodobania, zwyczaje).

Odpowiadaj wyłącznie liniami w formacie:
SPRZECZNY: F<numer> ⟷ [<tytuł reguły>] — <jedno zdanie, na czym polega>
POKRYTY: F<numer> ⟷ [<tytuł reguły>] — <jedno zdanie>
Jeśli nie ma nic do zgłoszenia, odpowiedz dokładnie: BRAK`;

/**
 * Złóż wsad dla modelu i mapę etykiet z powrotem na fakty.
 *
 * Fakty dostają krótkie etykiety `F1`, `F2`… zamiast swoich UUID-ów. Model,
 * który ma przepisać trzydziestoznakowy identyfikator, myli w nim znaki, a
 * pomyłka znaczy tu wskazanie NIE TEGO faktu do skasowania. Krótka etykieta
 * jest odporna, a odwzorowanie z powrotem robimy sami.
 */
export function zbudujWsad(
  reguly: HouseRule[],
  fakty: FaktDoKontroli[]
): { tekst: string; mapa: Map<string, FaktDoKontroli> } {
  const mapa = new Map<string, FaktDoKontroli>();
  const linieFaktow = fakty.map((f, i) => {
    const etykieta = `F${i + 1}`;
    mapa.set(etykieta, f);
    return `${etykieta} (profil ${f.userId}) ${f.content}`;
  });

  const tekst = [
    "## REGUŁY DOMOWE",
    reguly.map((r) => `[${r.title}]\n${r.text}`).join("\n\n"),
    "",
    "## FAKTY Z PAMIĘCI",
    linieFaktow.join("\n"),
  ].join("\n");

  return { tekst, mapa };
}

/**
 * Wyłuskaj znaleziska z odpowiedzi modelu.
 *
 * Parser jest celowo pobłażliwy dla myślników i strzałki, bo model potrafi
 * podmienić „⟷" na „<->" albo em-dash na zwykły. Nie jest natomiast pobłażliwy
 * dla etykiety: `F7`, którego nie było we wsadzie, jest wymyślony i wypada.
 * Skasowanie faktu wskazanego przez halucynację byłoby cichą utratą danych.
 */
export function parsujWynik(
  odpowiedz: string,
  mapa: Map<string, FaktDoKontroli>
): Znalezisko[] {
  const znalezione = new Map<string, Znalezisko>();

  for (const linia of odpowiedz.split("\n")) {
    const naglowek = /^\s*(SPRZECZNY|POKRYTY)\s*:\s*(.+)$/i.exec(linia.trim());
    if (!naglowek) continue;

    const rodzaj = naglowek[1].toUpperCase() === "SPRZECZNY" ? "sprzeczny" : "pokryty";
    const reszta = naglowek[2];

    const etykieta = /\bF(\d+)\b/.exec(reszta);
    const tytul = /\[(.+?)\]/.exec(reszta);
    if (!etykieta || !tytul) continue;

    const fakt = mapa.get(`F${etykieta[1]}`);
    if (!fakt) continue;

    // Wyjaśnienie to wszystko po ostatnim myślniku dowolnego rodzaju.
    const poMyslniku = /[—–-]\s*([^—–-]+)$/.exec(reszta);

    // Ten sam fakt wskazany dwa razy: sprzeczność jest pilniejsza niż powtórzenie.
    const juz = znalezione.get(fakt.id);
    if (juz && !(juz.rodzaj === "pokryty" && rodzaj === "sprzeczny")) continue;

    znalezione.set(fakt.id, {
      rodzaj,
      factId: fakt.id,
      userId: fakt.userId,
      tresc: fakt.content,
      regula: tytul[1].trim(),
      dlaczego: poMyslniku?.[1].trim() ?? "",
    });
  }

  // Sprzeczne najpierw — one zmieniają zachowanie domu, powtórzenia tylko zaśmiecają.
  return [...znalezione.values()].sort((a, b) =>
    a.rodzaj === b.rodzaj ? 0 : a.rodzaj === "sprzeczny" ? -1 : 1
  );
}

export interface WynikKontroli {
  znaleziska: Znalezisko[];
  sprawdzono: number;
  /** Ustawione, gdy kontrola się nie powiodła — panel ma to pokazać, nie zataić. */
  blad?: string;
}

/**
 * Uruchom kontrolę. Nigdy nie rzuca — jak w edytorze reguł, nieudana kontrola
 * ma o sobie powiedzieć, a nie zablokować pracę.
 */
export async function sprawdzFaktyZRegulami(
  llm: IChatEngine,
  reguly: HouseRule[],
  fakty: FaktDoKontroli[]
): Promise<WynikKontroli> {
  const wlaczone = reguly.filter((r) => r.enabled && r.text.trim());
  if (!wlaczone.length || !fakty.length) {
    return { znaleziska: [], sprawdzono: fakty.length };
  }

  const { tekst, mapa } = zbudujWsad(wlaczone, fakty);

  try {
    const odpowiedz = await llm.chat({
      message: tekst,
      userId: "kontrola-pamieci",
      // Świeży identyfikator: to jednorazowa recenzja, nie rozmowa. Nie wolno
      // jej dziedziczyć historii ani zostawiać po sobie śladu w rozmowach.
      conversationId: `kontrola-pamieci-${Date.now()}`,
      customPrompt: KONTROLA_PROMPT,
      // Bez pamięci i bez sieci — wsadem są wyłącznie reguły i fakty. Wciągnięcie
      // pamięci do kontroli pamięci mieszałoby badane z badającym.
      memoryTokenLimit: 0,
      webSearchLimit: 0,
      // Bez tego kontrola sama tworzy to, czego szuka: wsadem są reguły, więc
      // ekstraktor przepisałby je do pamięci jako fakty, a następne wywołanie
      // znalazłoby je jako „pokryte". Zweryfikowane na żywo — w jednym
      // przebiegu dopisało 6 faktów do `default` i 9 do profilu kontroli.
      skipExtraction: true,
    });
    return {
      znaleziska: parsujWynik(odpowiedz.response ?? "", mapa),
      sprawdzono: fakty.length,
    };
  } catch (err) {
    const blad = err instanceof Error ? err.message : "Nieznany błąd";
    console.error("[pamiec] kontrola z regulami nie powiodla sie:", blad);
    return { znaleziska: [], sprawdzono: fakty.length, blad };
  }
}
