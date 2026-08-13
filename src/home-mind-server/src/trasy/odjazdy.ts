/**
 * Tablica odjazdow jednej linii z jednego przystanku - czytana wprost ze strony
 * miasta.
 *
 * DLACZEGO OSOBNO OD `zaplanuj_trase`: Routes API odpowiada A -> B i wymaga
 * CELU. Na "o ktorej jedzie najblizszy 111" model wkladal numer linii w pole
 * `dokad`, Google geokodowalo smiec i wychodzilo falszywe "nie znalazlem
 * polaczenia" (zmierzone 13.08). To sa dwa rozne pytania: planowanie trasy i
 * tablica odjazdow. Teraz maja dwa rozne narzedzia.
 *
 * DLACZEGO NIE `web_search`: zmierzone na zywo tego samego dnia - Tavily oddaje
 * na to pytanie trzy linki i zdanie "sprawdz aktualny rozklad na stronie",
 * ZERO godzin. Model musialby je wtedy zmyslic. Godziny sa dopiero w tresci
 * strony, wiec ta strone trzeba przeczytac, a nie wyszukac.
 *
 * SKAD DANE: wroclaw.pl renderuje rozklad po stronie serwera, zwyklym tekstem
 * ("Odjazd 29 minut po godzinie 16"), w trzech wariantach dnia. Zweryfikowane
 * przeciwko Google: 111 z Waniliowej o 16:29 i 16:42 - co do minuty to samo.
 * To ten sam miejski GTFS, tylko bez posrednika i bez limitu zapytan.
 */

import { envNumber, envOrUndefined } from "../env.js";
import { uprosc } from "../memory/tekst.js";

const BAZA = "https://www.wroclaw.pl/komunikacja";

/** Strona sadzi po naglowku - bez niego potrafi oddac cos innego niz przegladarce. */
const UDAJE_PRZEGLADARKE =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ZRODLO =
  "rozklad planowy MPK ze strony wroclaw.pl (bez opoznien na zywo; w swieta kursy moga isc jak w niedziele)";

/** Ile godzin trzymamy pobrana strone. Rozklad zmienia sie rzadziej niz raz na dobe. */
function ttlMs(): number {
  return envNumber("ODJAZDY_CACHE_H", 6) * 3600_000;
}

/** Przystanek, o ktory chodzi, gdy nikt go nie nazwal - ten pod domem. */
export function przystanekDomyslny(): string {
  return envOrUndefined("TRASY_PRZYSTANEK_DOMYSLNY") ?? "Waniliowa";
}

export interface ZapytanieOdjazdy {
  linia: string;
  /** Pominiety = przystanek pod domem. */
  przystanek?: string;
  /** Kierunek, jesli uzytkownik go nazwal - inaczej oddajemy obie strony. */
  kierunek?: string;
  /** Ile najblizszych kursow oddac na kazda strone. */
  ile?: number;
}

export interface OdjazdyKierunku {
  kierunek: string;
  przystanek: string;
  najblizsze: string[];
  link: string;
  uwaga?: string;
}

export interface WynikOdjazdow {
  linia: string;
  przystanek: string;
  dzien: string;
  zrodlo: string;
  kierunki: OdjazdyKierunku[];
}

interface Slup {
  przystanek: string;
  kierunek: string;
  sciezka: string;
}

const cache = new Map<string, { czas: number; tresc: string }>();

async function pobierz(url: string): Promise<string> {
  const zapamietane = cache.get(url);
  if (zapamietane && Date.now() - zapamietane.czas < ttlMs()) return zapamietane.tresc;

  const odp = await fetch(url, {
    headers: { "User-Agent": UDAJE_PRZEGLADARKE, "Accept-Language": "pl-PL,pl" },
    signal: AbortSignal.timeout(envNumber("ODJAZDY_TIMEOUT_MS", 15000)),
  });
  if (!odp.ok) throw new Error(`${url} odpowiedzial ${odp.status}`);
  const tresc = await odp.text();
  cache.set(url, { czas: Date.now(), tresc });
  return tresc;
}

/** Test seam: zapomnij pobrane strony. */
export function zapomnijOdjazdy(): void {
  cache.clear();
}

/** HTML -> jedna linia tekstu. Skrypty wypadaja pierwsze, bo siedza w nich godziny z reklam. */
export function naTekst(html: string): string {
  const bezSkryptow = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return bezSkryptow
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Wylowi z listy przystankow linii adresy jej slupkow.
 *
 * Slug niesie komplet: przystanek, kierunek i numer slupka - czyli dokladnie to,
 * czego potrzeba, zeby nie zgadywac strony. Dlatego czytamy strone linii, a nie
 * wyszukiwarke: ranking moglby kiedys podac inny przystanek, a tu dopasowanie
 * jest dokladne.
 */
export function slupkiLinii(html: string, linia: string): Slup[] {
  const wzor = new RegExp(
    `przystanek-([a-z0-9-]+?)-linia-${uprosc(linia)}-kierunek-([a-z0-9-]+?)-slupek-(\\d+)`,
    "g"
  );
  const widziane = new Set<string>();
  const wynik: Slup[] = [];
  for (const [sciezka, przystanek, kierunek] of html.matchAll(wzor)) {
    if (widziane.has(sciezka)) continue;
    widziane.add(sciezka);
    wynik.push({ przystanek, kierunek, sciezka: `${BAZA}/${sciezka}` });
  }
  return wynik;
}

const DNI = ["Niedziela", "Sobota", "W dni robocze"] as const;

/** Ktory z trzech rozkladow obowiazuje dzisiaj. */
export function rodzajDnia(teraz: Date, strefa: string): (typeof DNI)[number] {
  const nazwa = teraz.toLocaleDateString("en-US", { weekday: "short", timeZone: strefa });
  if (nazwa === "Sun") return "Niedziela";
  if (nazwa === "Sat") return "Sobota";
  return "W dni robocze";
}

/**
 * Godziny z jednego rozkladu. Strona pisze je slowami dla czytnikow ekranu
 * ("Odjazd 29 minut po godzinie 16") i to jest najstabilniejsze, co ma - uklad
 * tabelki zmienia sie przy kazdym liftingu, a ten opis nie.
 *
 * Wazne, ktora sekcje czytamy: sobotnia i niedzielna chodza rzadziej, wiec
 * pomylka daje godzine nieistniejacego kursu - gorzej niz brak odpowiedzi.
 */
export function godzinyZeStrony(tekst: string, dzien: string): string[] {
  const sekcje = tekst.split("Rozkład jazdy - ").slice(1);
  const nasza = sekcje.find((s) => s.startsWith(dzien));
  if (!nasza) return [];
  return [...nasza.matchAll(/Odjazd (\d{2}) minut po godzinie (\d{1,2})/g)]
    .map(([, minuty, godzina]) => `${godzina.padStart(2, "0")}:${minuty}`)
    .sort();
}

/** "16:42" -> 1002 minuty od polnocy. */
function wMinutach(hhmm: string): number {
  const [g, m] = hhmm.split(":").map(Number);
  return g * 60 + m;
}

function terazWMinutach(teraz: Date, strefa: string): number {
  return wMinutach(
    teraz.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: strefa,
    })
  );
}

export function najblizsze(godziny: string[], teraz: Date, strefa: string, ile: number): string[] {
  const odKiedy = terazWMinutach(teraz, strefa);
  return godziny.filter((g) => wMinutach(g) >= odKiedy).slice(0, ile);
}

export async function sprawdzOdjazdy(
  zapytanie: ZapytanieOdjazdy,
  teraz = new Date()
): Promise<WynikOdjazdow | { error: string }> {
  const linia = zapytanie.linia.trim();
  if (!/^\d{1,3}[a-zA-Z]?$/.test(linia)) {
    return {
      error: `"${zapytanie.linia}" nie wyglada na numer linii. Podaj sam numer, np. "111".`,
    };
  }
  const przystanek = (zapytanie.przystanek ?? przystanekDomyslny()).trim();
  const strefa = envOrUndefined("TZ") ?? "Europe/Warsaw";
  const ile = zapytanie.ile ?? 3;

  let stronaLinii: string;
  try {
    stronaLinii = await pobierz(`${BAZA}/linia-${uprosc(linia)}-wroclaw`);
  } catch (err) {
    return {
      error:
        `Nie udalo sie odczytac rozkladu linii ${linia} ze strony miasta (${(err as Error).message}). ` +
        "Powiedz to wprost i NIE zgaduj godzin.",
    };
  }

  const szukany = uprosc(przystanek).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let slupki = slupkiLinii(stronaLinii, linia).filter((s) => s.przystanek === szukany);

  if (slupki.length === 0) {
    return {
      error:
        `Linia ${linia} nie zatrzymuje sie na przystanku "${przystanek}" (albo przystanek nazywa sie inaczej). ` +
        "Powiedz to uzytkownikowi i zapytaj o nazwe przystanku. NIE zgaduj godzin.",
    };
  }

  if (zapytanie.kierunek) {
    const chciany = uprosc(zapytanie.kierunek);
    const wybrane = slupki.filter((s) => s.kierunek.replace(/-/g, " ").includes(chciany.replace(/-/g, " ")));
    // Kierunek nietrafiony zostawiamy bez filtra: lepiej podac obie strony i dac
    // modelowi wybrac, niz odpowiedziec "nie ma takiego kursu".
    if (wybrane.length > 0) slupki = wybrane;
  }

  const dzien = rodzajDnia(teraz, strefa);
  const kierunki: OdjazdyKierunku[] = [];

  for (const slup of slupki) {
    let tekst: string;
    try {
      tekst = naTekst(await pobierz(slup.sciezka));
    } catch (err) {
      console.warn(`[odjazdy] ${slup.sciezka}: ${(err as Error).message}`);
      continue;
    }
    const godziny = godzinyZeStrony(tekst, dzien);
    const nastepne = najblizsze(godziny, teraz, strefa, ile);
    kierunki.push({
      kierunek: slup.kierunek.replace(/-/g, " "),
      przystanek,
      najblizsze: nastepne,
      link: slup.sciezka,
      ...(nastepne.length === 0
        ? {
            uwaga:
              godziny.length === 0
                ? "nie udalo sie odczytac godzin z tej strony"
                : "dzis w te strone juz nic nie odjezdza",
          }
        : {}),
    });
  }

  if (kierunki.length === 0) {
    return {
      error: `Nie udalo sie odczytac godzin linii ${linia} z przystanku ${przystanek}. NIE zgaduj ich.`,
    };
  }

  console.log(
    `[odjazdy] ${linia} @ ${przystanek} (${dzien}) - ` +
      kierunki.map((k) => `${k.kierunek}: ${k.najblizsze.join(", ") || "brak"}`).join(" | ")
  );

  return { linia, przystanek, dzien, zrodlo: ZRODLO, kierunki };
}
