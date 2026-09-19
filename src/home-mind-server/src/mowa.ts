// Godziny i numery mowione: liczebniki po polsku.
//
// Model potrafi zamienic "23:45" na slowa, ale myli przypadek minut - mowi
// "o dwudziestej trzeciej CZTERDZIESTEJ piec" (porzadkowy) zamiast
// "czterdziesci piec" (glowny). Zmierzone na zywo dwa razy z rzedu, wiec to
// nie przypadek. Odmiana jest regularna, wiec robi ja kod, a nie model.
// 19.09.2026 to samo w rozkladzie ("o dziewietnastej czterdziestej osiem",
// "autobus sto jedenastu") i przy pytaniu o godzine ("czterdziestaczy piec").

// Miejscownik, bo forma trafia do zdania po przyimku "o" ("o dwudziestej trzeciej").
const GODZINY_MIEJSCOWNIK = [
  "zerowej", "pierwszej", "drugiej", "trzeciej", "czwartej", "piątej",
  "szóstej", "siódmej", "ósmej", "dziewiątej", "dziesiątej", "jedenastej",
  "dwunastej", "trzynastej", "czternastej", "piętnastej", "szesnastej",
  "siedemnastej", "osiemnastej", "dziewiętnastej", "dwudziestej",
  "dwudziestej pierwszej", "dwudziestej drugiej", "dwudziestej trzeciej",
];

// Mianownik, do odpowiedzi na "ktora godzina?" ("jest dziewietnasta czterdziesci piec").
const GODZINY_MIANOWNIK = [
  "zero", "pierwsza", "druga", "trzecia", "czwarta", "piąta",
  "szósta", "siódma", "ósma", "dziewiąta", "dziesiąta", "jedenasta",
  "dwunasta", "trzynasta", "czternasta", "piętnasta", "szesnasta",
  "siedemnasta", "osiemnasta", "dziewiętnasta", "dwudziesta",
  "dwudziesta pierwsza", "dwudziesta druga", "dwudziesta trzecia",
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
const DZIESIATKI = [
  "", "", "dwadzieścia", "trzydzieści", "czterdzieści", "pięćdziesiąt",
  "sześćdziesiąt", "siedemdziesiąt", "osiemdziesiąt", "dziewięćdziesiąt",
];
const SETKI = [
  "", "sto", "dwieście", "trzysta", "czterysta", "pięćset",
  "sześćset", "siedemset", "osiemset", "dziewięćset",
];

/** 0-99 jako liczebnik glowny; `dwa` wybiera rodzaj dwojki ("dwie" minuty, "dwa" w numerze). */
function doStu(n: number, dwa: "dwie" | "dwa"): string {
  const jednosci = (j: number) => (j === 2 ? dwa : JEDNOSCI[j]);
  if (n < 10) return jednosci(n);
  if (n < 20) return NASTKI[n - 10];
  const d = Math.floor(n / 10);
  const j = n % 10;
  return j === 0 ? DZIESIATKI[d] : `${DZIESIATKI[d]} ${jednosci(j)}`;
}

function minutySlownie(m: number): string {
  return m < 10 ? `zero ${JEDNOSCI[m]}` : doStu(m, "dwie");
}

function rozbierz(hhmm: string): [number, number] | undefined {
  const dopasowanie = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!dopasowanie) return undefined;
  const g = Number(dopasowanie[1]);
  const m = Number(dopasowanie[2]);
  return g > 23 || m > 59 ? undefined : [g, m];
}

/**
 * "23:45" -> "o dwudziestej trzeciej czterdzieści pięć" (gotowe do wypowiedzenia).
 *
 * Przyimek jest w srodku celowo: bez niego model musialby sam dobrac przypadek
 * i wrocilibysmy do bledu, ktory ta funkcja naprawia. Pelna godzina nie dostaje
 * minut, zeby nie brzmiala "osiemnasta zero zero".
 */
export function oGodzinieSlownie(hhmm: string): string | undefined {
  const czas = rozbierz(hhmm);
  if (!czas) return undefined;
  const [g, m] = czas;
  return m === 0
    ? `o ${GODZINY_MIEJSCOWNIK[g]}`
    : `o ${GODZINY_MIEJSCOWNIK[g]} ${minutySlownie(m)}`;
}

/** "19:45" -> "dziewiętnasta czterdzieści pięć"; odpowiedz na "ktora godzina?". */
export function godzinaMianownik(hhmm: string): string | undefined {
  const czas = rozbierz(hhmm);
  if (!czas) return undefined;
  const [g, m] = czas;
  if (m === 0) return g === 0 ? "północ" : GODZINY_MIANOWNIK[g];
  return `${GODZINY_MIANOWNIK[g]} ${minutySlownie(m)}`;
}

/**
 * Numer linii -> "sto jedenaście", "trzydzieści dwa", "siedem a".
 * Liczebnik glowny w mianowniku, bo tak sie mowi numer ("linia sto jedenascie").
 */
export function numerSlownie(numer: string): string | undefined {
  const dopasowanie = /^(\d{1,3})([a-zA-Z]?)$/.exec(numer.trim());
  if (!dopasowanie) return undefined;
  const n = Number(dopasowanie[1]);
  const litera = dopasowanie[2].toLowerCase();
  let slowa: string;
  if (n === 0) {
    slowa = "zero";
  } else {
    const setki = SETKI[Math.floor(n / 100)];
    const reszta = doStu(n % 100, "dwa");
    slowa = [setki, reszta].filter(Boolean).join(" ");
  }
  return litera ? `${slowa} ${litera}` : slowa;
}
