/**
 * Planowanie trasy komunikacja miejska przez Google Routes API.
 *
 * DLACZEGO WPROST, A NIE PRZEZ INTEGRACJE HA: akcja
 * `google_travel_time.get_transit_times` odpowiada wylacznie "ile potrwa" -
 * jej maska pol to `routes.duration,routes.distanceMeters,routes.localized_values`,
 * wiec o odcinki trasy nawet nie pyta. Pierwotna awaria brzmiala inaczej:
 * asystent podawal 111 w strone petli zamiast w strone miasta. Kierunku nie da
 * sie zgadnac z polozenia domu - potrzebny jest drugi punkt. Stad to narzedzie:
 * pytanie zmienia sie z "kiedy jedzie 111 w strone miasta" na "jak dojade do
 * centrum", a `headsign` z odpowiedzi Google MOWI kierunek zamiast go zgadywac.
 *
 * CZEGO TO NIE DA:
 * - to nie jest tablica odjazdow. Routes API odpowiada A -> B na konkretna
 *   godzine, a nie "trzy najblizsze kursy 111".
 * - opoznien na zywo tu nie ma i nie bedzie: Wroclaw publikuje surowe pozycje
 *   GPS, ale nie ma GTFS-RT, wiec Google nie ma czym zasilic opoznien. Zmiany
 *   PLANOWE (remonty, objazdy, przeniesione przystanki) sa w miejskim GTFS,
 *   ktory Google odswieza raz na dobe - te widac.
 */

import { envNumber, envOrUndefined } from "../env.js";
import { adresDomu, adresMiejsca } from "./miejsca.js";
import { ileWariantow, kluczApi, limitDzienny } from "./ustawienia.js";
import { limitWyczerpany, policzWywolanie, zuzyteDzis } from "./uzycie.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * O co prosimy Google. Maska pol jest obowiazkowa i to ONA decyduje o cenie -
 * `legs.steps.transitDetails` przenosi zapytanie na wyzszy prog cenowy, ale to
 * jedyne miejsce, w ktorym siedzi numer linii, kierunek i godziny. Bez tego
 * narzedzie nie ma sensu.
 */
const MASKA_POL = [
  "routes.duration",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.transitDetails",
].join(",");

/** Standardowa nota do kazdej odpowiedzi - patrz naglowek pliku. */
const ZRODLO = "rozklad planowy Google (odswiezany raz na dobe, bez opoznien na zywo)";

export interface ZapytanieTrasy {
  dokad: string;
  /** Domyslnie dom (`TRASY_MIEJSCA.dom`). */
  skad?: string;
  /** ISO 8601. Brak = teraz. */
  kiedy?: string;
  /** Czy `kiedy` to godzina wyjazdu, czy godzina, na ktora trzeba dotrzec. */
  kiedyZnaczy?: "wyjazd" | "przyjazd";
}

export interface KrokPieszy {
  pieszo_minut: number;
}

export interface KrokPrzejazdu {
  linia: string;
  kierunek?: string;
  typ?: string;
  wsiadz?: string;
  o?: string;
  /** Ta sama godzina gotowa do wypowiedzenia, z przyimkiem: "o siódmej piętnaście". */
  o_mowa?: string;
  wysiadz?: string;
  przyjazd?: string;
  przyjazd_mowa?: string;
  przystankow?: number;
}

export type Krok = KrokPieszy | KrokPrzejazdu;

export interface Trasa {
  czas_minut: number;
  wyjazd?: string;
  przyjazd?: string;
  kroki: Krok[];
}

export interface WynikTrasy {
  skad: string;
  dokad: string;
  zrodlo: string;
  trasy: Trasa[];
  uwaga?: string;
}

// --- ksztalt odpowiedzi Google (tylko pola z maski) ---

interface StopG {
  name?: string;
}

interface TransitDetailsG {
  stopDetails?: {
    arrivalStop?: StopG;
    arrivalTime?: string;
    departureStop?: StopG;
    departureTime?: string;
  };
  headsign?: string;
  stopCount?: number;
  transitLine?: {
    name?: string;
    nameShort?: string;
    vehicle?: { type?: string; name?: { text?: string } };
  };
}

interface StepG {
  travelMode?: string;
  staticDuration?: string;
  transitDetails?: TransitDetailsG;
}

interface RouteG {
  duration?: string;
  legs?: { steps?: StepG[] }[];
}

export interface OdpowiedzGoogle {
  routes?: RouteG[];
}

/** "1234s" -> 1234. Google podaje czasy trwania jako napis z sekundami. */
function sekundy(czas: string | undefined): number {
  if (!czas) return 0;
  const parsed = Number.parseFloat(czas.replace(/s$/, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function minuty(czas: string | undefined): number {
  return Math.round(sekundy(czas) / 60);
}

/** ISO -> "17:42" w strefie domu. */
export function godzina(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return undefined;
  return data.toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: envOrUndefined("TZ") ?? "Europe/Warsaw",
  });
}

// Godziny mowione: liczebniki po polsku.
//
// Model potrafi zamienic "23:45" na slowa, ale myli przypadek minut - mowi
// "o dwudziestej trzeciej CZTERDZIESTEJ piec" (porzadkowy) zamiast
// "czterdziesci piec" (glowny). Zmierzone na zywo dwa razy z rzedu, wiec to
// nie przypadek. Odmiana jest regularna, wiec robi ja kod, a nie model.
//
// Godzina stoi w miejscowniku, bo forma trafia do zdania po przyimku "o"
// ("o dwudziestej trzeciej"); minuty zostaja w mianowniku liczebnika glownego.
const GODZINY_MIEJSCOWNIK = [
  "zerowej", "pierwszej", "drugiej", "trzeciej", "czwartej", "piątej",
  "szóstej", "siódmej", "ósmej", "dziewiątej", "dziesiątej", "jedenastej",
  "dwunastej", "trzynastej", "czternastej", "piętnastej", "szesnastej",
  "siedemnastej", "osiemnastej", "dziewiętnastej", "dwudziestej",
  "dwudziestej pierwszej", "dwudziestej drugiej", "dwudziestej trzeciej",
];

// Rodzaj zenski, bo minuty sa zenskie: "dwie", nie "dwa". "jeden" sie tu nie
// odmienia ("dwadziescia jeden minut"), wiec zostaje jak jest.
const JEDNOSCI = [
  "", "jeden", "dwie", "trzy", "cztery", "pięć", "sześć", "siedem", "osiem", "dziewięć",
];
const NASTKI = [
  "dziesięć", "jedenaście", "dwanaście", "trzynaście", "czternaście",
  "piętnaście", "szesnaście", "siedemnaście", "osiemnaście", "dziewiętnaście",
];
const DZIESIATKI = ["", "", "dwadzieścia", "trzydzieści", "czterdzieści", "pięćdziesiąt"];

function minutySlownie(m: number): string {
  if (m < 10) return `zero ${JEDNOSCI[m]}`;
  if (m < 20) return NASTKI[m - 10];
  const d = Math.floor(m / 10);
  const j = m % 10;
  return j === 0 ? DZIESIATKI[d] : `${DZIESIATKI[d]} ${JEDNOSCI[j]}`;
}

/**
 * ISO -> "o dwudziestej trzeciej czterdzieści pięć" (gotowe do wypowiedzenia).
 *
 * Przyimek jest w srodku celowo: bez niego model musialby sam dobrac przypadek
 * i wrocilibysmy do bledu, ktory ta funkcja naprawia. Pelna godzina nie dostaje
 * minut, zeby nie brzmiala "osiemnasta zero zero".
 */
export function godzinaSlownie(iso: string | undefined): string | undefined {
  const cyfry = godzina(iso);
  if (!cyfry) return undefined;
  const [g, m] = cyfry.split(":").map(Number);
  if (!Number.isInteger(g) || !Number.isInteger(m) || g > 23 || m > 59) return undefined;
  return m === 0
    ? `o ${GODZINY_MIEJSCOWNIK[g]}`
    : `o ${GODZINY_MIEJSCOWNIK[g]} ${minutySlownie(m)}`;
}

/** ISO -> milisekundy, do porownywania tras. `undefined`, gdy Google nie podal. */
export function znacznik(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

const POJAZDY: Record<string, string> = {
  BUS: "autobus",
  INTERCITY_BUS: "autobus",
  TROLLEYBUS: "trolejbus",
  TRAM: "tramwaj",
  LIGHT_RAIL: "tramwaj",
  SUBWAY: "metro",
  METRO_RAIL: "metro",
  MONORAIL: "metro",
  HEAVY_RAIL: "pociag",
  RAIL: "pociag",
  COMMUTER_TRAIN: "pociag",
  HIGH_SPEED_TRAIN: "pociag",
  LONG_DISTANCE_TRAIN: "pociag",
  FERRY: "prom",
};

function typPojazdu(td: TransitDetailsG): string | undefined {
  const typ = td.transitLine?.vehicle?.type;
  if (typ && POJAZDY[typ]) return POJAZDY[typ];
  return td.transitLine?.vehicle?.name?.text ?? typ?.toLowerCase();
}

function jestPrzejazdem(krok: Krok): krok is KrokPrzejazdu {
  return "linia" in krok;
}

/**
 * Przepisz odpowiedz Google na kilka linijek, ktore model ma wypowiedziec.
 * Czyste - bez sieci - zeby dalo sie to sprawdzic testem na zapisanej odpowiedzi.
 */
export function sformatujTrasy(odp: OdpowiedzGoogle): Trasa[] {
  const zSortem: { trasa: Trasa; dojazd?: number }[] = [];

  for (const route of odp.routes ?? []) {
    const kroki: Krok[] = [];
    // Google oddaje kroki NAWIGACYJNE ("skrec w lewo", "idz prosto"), wiec
    // jedno dojscie do przystanku potrafi przyjsc jako szesc osobnych krokow.
    // Zbieramy je w SEKUNDACH i wypuszczamy dopiero przed przejazdem: inaczej
    // asystent mowi "idz 2 minuty, potem idz 2 minuty", a marsze ponizej
    // minuty gina po zaokragleniu kazdy z osobna.
    let marsz = 0;
    let ostatniPrzyjazd: string | undefined;
    const wypuscMarsz = () => {
      const pieszo = Math.round(marsz / 60);
      marsz = 0;
      if (pieszo > 0) kroki.push({ pieszo_minut: pieszo });
    };

    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        if (step.travelMode === "TRANSIT" && step.transitDetails) {
          const td = step.transitDetails;
          const linia = td.transitLine?.nameShort ?? td.transitLine?.name;
          if (!linia) continue;
          wypuscMarsz();
          ostatniPrzyjazd = td.stopDetails?.arrivalTime;
          kroki.push({
            linia,
            kierunek: td.headsign,
            typ: typPojazdu(td),
            wsiadz: td.stopDetails?.departureStop?.name,
            o: godzina(td.stopDetails?.departureTime),
            // Forma mowiona obok cyfrowej: cyfry zostaja dla odpowiedzi
            // pisanej, slowa sa gotowe do wypowiedzenia bez odmieniania.
            o_mowa: godzinaSlownie(td.stopDetails?.departureTime),
            wysiadz: td.stopDetails?.arrivalStop?.name,
            przyjazd: godzina(td.stopDetails?.arrivalTime),
            przyjazd_mowa: godzinaSlownie(td.stopDetails?.arrivalTime),
            przystankow: td.stopCount,
          });
          continue;
        }
        marsz += sekundy(step.staticDuration);
      }
    }
    // Marsz z ostatniego przystanku pod same drzwi - liczy sie do dojazdu.
    const ogon = marsz;
    wypuscMarsz();

    const przejazdy = kroki.filter(jestPrzejazdem);
    const koniec = znacznik(ostatniPrzyjazd);

    zSortem.push({
      trasa: {
        czas_minut: minuty(route.duration),
        wyjazd: przejazdy[0]?.o,
        przyjazd: przejazdy[przejazdy.length - 1]?.przyjazd,
        kroki,
      },
      dojazd: koniec == null ? undefined : koniec + ogon * 1000,
    });
  }

  // Pasazera obchodzi GODZINA DOJAZDU, nie `czas_minut` - ten ostatni liczy sie
  // od teraz i wariant z krotszym czekaniem na przystanku wychodzi w nim
  // "szybszy", chociaz dowozi pozniej. Sortujemy po znaczniku czasu, nie po
  // napisie "23:04", zeby polnoc nie odwracala kolejnosci. Trasy bez przejazdu
  // (sam marsz) nie maja godziny dojazdu - zostaja na koncu, w kolejnosci Google.
  return zSortem
    .map((w, i) => ({ ...w, i }))
    .sort((a, b) => {
      if (a.dojazd == null || b.dojazd == null) {
        if (a.dojazd == null && b.dojazd == null) return a.i - b.i;
        return a.dojazd == null ? 1 : -1;
      }
      return a.dojazd - b.dojazd || a.i - b.i;
    })
    .map((w) => w.trasa);
}

/**
 * Odetnij strefe z napisu ISO: "2026-08-13T15:08:21Z" i "…+02:00" -> "…15:08:21".
 * Sama data bez godziny dostaje polnoc, bo `new Date("2026-08-13")` to polnoc
 * UTC, czyli u nas druga w nocy - a "na jutro" znaczy jutro tutaj.
 */
function zegarScienny(kiedy: string): string {
  const bezStrefy = kiedy.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, "");
  return bezStrefy.includes("T") ? bezStrefy : `${bezStrefy}T00:00:00`;
}

/**
 * Godzina wyjazdu/przyjazdu w formacie, ktory Google przyjmie.
 *
 * `kiedy` czytamy jako ZEGAR SCIENNY w strefie domu, a deklarowana strefe
 * ODRZUCAMY. Zmierzone na zywo dwa razy: model bierze `ISO Timestamp (now, UTC)`
 * z promptu, przepisuje godzine na lokalna i zostawia koncowke `Z` - o 15:08
 * naszego czasu wyslal `2026-08-13T15:08:21Z`, czyli 17:08 u nas. Google planowal
 * wtedy przejazd o dwie godziny za pozno (najblizszy 111 z Waniliowej: 18:28
 * zamiast 16:29) i to wygladalo jak zly rozklad, a nie jak zla godzina.
 * Sprawdzenie ponizej tego nie lapalo: godzina przesunieta w przyszlosc zawsze
 * przechodzila jako "poprawna".
 *
 * Cena tej decyzji: gdyby model kiedys przyslal prawdziwy UTC, potraktujemy go
 * jako czas lokalny. To wybor swiadomy - pytania padaja tu o zegar na scianie
 * ("na dziewiata"), wiec zegar scienny jest tym, co model NAPRAWDE pisze.
 */
export function czasZapytania(kiedy: string | undefined, teraz = new Date()): string | undefined {
  if (!kiedy) return undefined;
  const proba = kiedy.trim().toLowerCase();
  if (proba === "" || proba === "teraz" || proba === "now") return undefined;
  const data = new Date(zegarScienny(kiedy.trim()));
  if (Number.isNaN(data.getTime())) return undefined;
  // Google odrzuca godzine wyjazdu z przeszlosci. Model liczy godziny sam i
  // bywa, ze spoznia sie o minute - wtedy lepiej odpowiedziec "teraz" niz
  // bledem.
  if (data.getTime() < teraz.getTime()) return undefined;
  return data.toISOString();
}

/**
 * Czy `dokad` to numer linii, a nie cel podrozy?
 *
 * Zmierzone: na "kiedy jedzie najblizszy 111" model wolal `dokad: "111"` i
 * `dokad: "przystanek 111"`. Google geokoduje to na cokolwiek, oddaje zero tras,
 * a asystent mowi "nie znalazlem polaczenia" - czyli wyglada na awarie rozkladu,
 * choc to zle pytanie. Lepiej odbic je od razu, bez palenia wywolania.
 *
 * Wzorzec jest ciasny celowo: sam numer, ewentualnie po slowie "linia" czy
 * "przystanek". Prawdziwy adres ma nazwe ulicy ("Waniliowa 111") i tu nie wpada.
 */
export function wygladaNaNumerLinii(dokad: string): boolean {
  return /^(?:linia|lini[ia]|autobus(?:em)?|tramwaj(?:em)?|przystanek|przystanku)?\s*\d{1,3}[a-z]?$/i.test(
    dokad.trim()
  );
}

export async function zaplanujTrase(
  zapytanie: ZapytanieTrasy
): Promise<WynikTrasy | { error: string }> {
  const klucz = kluczApi();
  if (!klucz) {
    return {
      error:
        "Planowanie tras nie jest skonfigurowane (brak klucza do Routes API). " +
        "Powiedz uzytkownikowi wprost, ze nie umiesz teraz sprawdzic polaczenia, " +
        "i NIE zgaduj numerow linii ani godzin.",
    };
  }

  const skad = zapytanie.skad ? adresMiejsca(zapytanie.skad) : adresDomu();
  if (!skad) {
    return {
      error:
        "Nie wiem, skad liczyc trase - nie podano punktu poczatkowego, a adres domu " +
        "nie jest ustawiony (TRASY_MIEJSCA.dom). Zapytaj uzytkownika, skad wyrusza.",
    };
  }
  const dokad = adresMiejsca(zapytanie.dokad);
  // Rozpoznana nazwa (skrot z `TRASY_MIEJSCA`) wraca zmieniona - wtedy to cel,
  // nawet gdyby ktos nazwal wpis "111". Numer odbijamy tylko wtedy, gdy przeszedl
  // przez slownik bez zmian, czyli poleci do Google jako adres.
  if (dokad === zapytanie.dokad.trim() && wygladaNaNumerLinii(dokad)) {
    return {
      error:
        `"${zapytanie.dokad}" to numer linii, a nie cel podrozy - to narzedzie planuje trase ` +
        "A do B i nie umie wypisac kolejnych kursow jednej linii ani odjazdow z przystanku. " +
        "Zapytaj uzytkownika, DOKAD chce dojechac, a potem zawolaj mnie jeszcze raz z tym celem; " +
        "numer linii znajdziesz w odpowiedzi. NIE zgaduj godzin ani kierunku.",
    };
  }

  if (limitDzienny() <= 0) {
    return { error: "Planowanie tras jest wylaczone (TRASY_LIMIT_DZIENNY=0)." };
  }
  if (limitWyczerpany()) {
    console.warn(`[trasy] dzienny limit wyczerpany (${zuzyteDzis()}/${limitDzienny()})`);
    return {
      error:
        `Dzienny limit zapytan o trase zostal wyczerpany (${zuzyteDzis()}/${limitDzienny()}). ` +
        "Powiedz to uzytkownikowi wprost i nie zgaduj polaczenia.",
    };
  }

  const czas = czasZapytania(zapytanie.kiedy);
  const naPrzyjazd = zapytanie.kiedyZnaczy === "przyjazd";

  const body: Record<string, unknown> = {
    origin: { address: skad },
    destination: { address: dokad },
    travelMode: "TRANSIT",
    computeAlternativeRoutes: true,
    languageCode: envOrUndefined("TRASY_JEZYK") ?? "pl-PL",
    regionCode: envOrUndefined("TRASY_REGION") ?? "PL",
  };
  if (czas) body[naPrzyjazd ? "arrivalTime" : "departureTime"] = czas;

  // Liczymy PRZED zapytaniem: zapetlony model ma zostac zatrzymany takze
  // wtedy, gdy kazde kolejne zapytanie konczy sie bledem.
  policzWywolanie();

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": klucz,
        "X-Goog-FieldMask": MASKA_POL,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(envNumber("TRASY_TIMEOUT_MS", 15000)),
    });
  } catch (err) {
    return { error: `Nie udalo sie polaczyc z Google Routes: ${(err as Error).message}` };
  }

  if (!response.ok) {
    const tekst = await response.text();
    console.warn(`[trasy] Routes API ${response.status}: ${tekst.slice(0, 300)}`);
    if (response.status === 403) {
      return {
        error:
          "Google odrzucil zapytanie o trase (403) - Routes API jest wylaczone w projekcie " +
          "albo klucz ma ograniczenia. Powiedz uzytkownikowi, ze trzeba to poprawic w konsoli Google.",
      };
    }
    if (response.status === 429) {
      return {
        error:
          "Google odrzucil zapytanie o trase (429) - dzienny limit po stronie Google " +
          "zostal wyczerpany. Powiedz to wprost i nie zgaduj polaczenia.",
      };
    }
    return { error: `Google Routes odpowiedzial bledem ${response.status}.` };
  }

  const odp = (await response.json()) as OdpowiedzGoogle;
  const trasy = sformatujTrasy(odp).slice(0, ileWariantow());

  console.log(
    `[trasy] ${skad} -> ${dokad}${czas ? ` (${naPrzyjazd ? "na" : "od"} ${czas})` : ""}` +
      ` - ${trasy.length} wariant(ow), ${zuzyteDzis()}/${limitDzienny()} dzis`
  );

  if (trasy.length === 0) {
    return {
      error:
        "Google nie znalazl polaczenia komunikacja miejska dla tej trasy o tej porze. " +
        "Powiedz to uzytkownikowi zamiast proponowac wymyslona linie.",
    };
  }

  const bezPrzejazdu = trasy.every((t) => !t.kroki.some(jestPrzejazdem));

  return {
    skad,
    dokad,
    zrodlo: ZRODLO,
    trasy,
    ...(bezPrzejazdu ? { uwaga: "Google proponuje dojscie pieszo - zadnej linii na tej trasie." } : {}),
  };
}
