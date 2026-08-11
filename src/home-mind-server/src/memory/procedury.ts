/**
 * Wyławianie procedur domowych z tur, które bramka odrzuciła.
 *
 * Bramka ekstrakcji zatrzymuje polecenia, bo polecenie nie niesie faktu — i to
 * jest słuszne. Ale to właśnie w poleceniach widać JAK obsługuje się ten dom:
 * że „zamknij do końca" znaczy `position: 0`, że muzyka idzie przez
 * `script.zagraj_muzyke`, że salon to segmenty 1 i 6. Ta wiedza przelatywała
 * przez bramkę do dziennika odrzuceń i czekała, aż ktoś kliknie ją ręcznie przy
 * każdym z osiemdziesięciu wpisów. Nikt nie kliknął.
 *
 * Mechanizm awansowania procedury na regułę ISTNIEJE od dawna (`suggestRule`,
 * wołany z ekstrakcji, gdy fakt wygląda na wywołanie usługi) i **nigdy nie
 * zadziałał**: zmierzone 0 wpisów w logach, 0 reguł oznaczonych jako sugestia.
 * Powód był strukturalny — jedyne tury bogate w procedury to polecenia, a te
 * bramka zatrzymuje ZANIM ekstraktor je zobaczy. To jest łatka na tę dziurę:
 * ten sam cel, ale po stronie odrzuconej.
 *
 * Wynik zawsze ląduje jako reguła WYŁĄCZONA. Nic tu nie zmienia zachowania
 * asystenta samo z siebie — propozycja czeka, aż człowiek ją przeczyta.
 */

import type { IFactExtractor, UzyteNarzedzie } from "../llm/interface.js";
import { loadRules, suggestRule } from "../rules/store.js";

/**
 * Narzędzia, które coś ZMIENIAJĄ.
 *
 * Tura złożona z samych odczytów („jaka jest temperatura", `get_state`) nie ma
 * procedury do opisania — nikt niczego nie obsłużył. Odsiewanie ich tutaj jest
 * jedynym progiem kosztowym, jaki ten przebieg ma, i zdejmuje mniej więcej
 * jedną piątą tur z rachunku, nie tracąc niczego, co dałoby się nauczyć.
 */
const NARZEDZIA_ZMIENIAJACE = new Set(["call_service"]);

/** Model ma odpowiedzieć tym słowem, gdy nie ma czego zapisać. */
const BRAK = "BRAK";

/**
 * Sufit na wsad z argumentów.
 *
 * Argumenty bywają duże (lista encji, treść wiadomości), a to jest przebieg,
 * który ma być tani. Obcięcie kosztuje szczegół w rzadkim przypadku; jego brak
 * kosztowałby nieprzewidywalny rachunek przy każdej hurtowej komendzie.
 */
const LIMIT_ZNAKOW_ARGUMENTOW = 400;

/**
 * Sufit na CAŁY blok reguł, nie na pojedynczą regułę.
 *
 * Pierwsza wersja przycinała każdą regułę do 140 znaków, żeby przebieg został
 * tani — i przez to nie zadziałała. Zmierzone na żywo: automat zaproponował
 * „position: 0 dla «zamknij do końca»", choć r03 mówi to wprost — ale słowo
 * „zamknij" stoi w niej na **356. znaku**, czyli daleko za obcięciem. Model
 * dostał sam nagłówek („WARTOŚĆ, NIE STAN. Home Assistant raportuje…") i nie
 * miał jak stwierdzić, że temat jest pokryty.
 *
 * Więc reguły idą w całości. To około 1200 tokenów doklejonych do
 * 350-tokenowego przebiegu, ale przebieg odpala się tylko na turach zmieniających
 * stan (kilkanaście dziennie), a jego jedynym zadaniem jest ODRZUCIĆ to, co już
 * jest napisane. Oszczędzanie akurat na materiale do tej decyzji jest
 * oszczędzaniem na jedynej rzeczy, którą ten przebieg robi.
 */
const LIMIT_BLOKU_REGUL = 6000;

/** Włączone reguły w całości — po to, żeby model nie proponował ich na nowo. */
function istniejaceReguly(): string {
  const linie = loadRules()
    .filter((r) => r.enabled && r.text.trim())
    .map((r) => `- [${r.title}] ${r.text.trim().replace(/\s+/g, " ")}`);

  if (linie.length === 0) return "(brak reguł)";

  const blok = linie.join("\n");
  return blok.length > LIMIT_BLOKU_REGUL
    ? blok.slice(0, LIMIT_BLOKU_REGUL) + "\n…(dalsze reguły pominięte)"
    : blok;
}

const PROMPT = `Jesteś obserwatorem asystenta domowego. Dostajesz JEDNĄ turę: co powiedział domownik,
co asystent odpowiedział i jakie usługi naprawdę wywołał (z argumentami).

Twoim jedynym zadaniem jest wyłowić PROCEDURĘ DOMOWĄ — trwałą zasadę „jak się w tym domu robi X",
która przyda się przy następnym takim poleceniu i której nie da się odgadnąć z nazw encji.

To JEST procedura:
- odwzorowanie słów domownika na konkretne wartości ("do końca" = pozycja 0, "przyciemnij" = jasność 30%)
- wybór usługi lub skryptu spośród kilku możliwych ("muzyka idzie przez script.zagraj_muzyke")
- stałe parametry, których nie widać w nazwie encji (numery segmentów, źródła, tryby)

To NIE jest procedura — odpowiedz wtedy ${BRAK}:
- zwykłe wykonanie polecenia bez żadnego wyboru ("zapal światło" -> light.turn_on)
- jednorazowa wartość, którą domownik podał wprost ("ustaw na 40%")
- cokolwiek o stanie urządzenia teraz
- upodobanie domownika (to jest fakt, nie procedura)
- 🔁 TEMAT JUŻ POKRYTY przez którąś z reguł poniżej. Nie liczy się, czy powiedziałbyś
  to lepiej albo krócej — jeśli reguła już o tym mówi, odpowiedz ${BRAK}.

Nie wymyślaj encji ani usług. Wolno ci wymienić WYŁĄCZNIE takie, które widnieją
w wywołaniach z tej tury. Jeśli reguła wymagałaby innej, odpowiedz ${BRAK}.

Uogólniaj ostrożnie: jedna tura to jeden przypadek. Nie pisz reguły "zawsze rób X",
jeśli z tej jednej tury nie wynika, że X jest właściwe także w pozostałych.

Jeśli masz wątpliwość, odpowiedz ${BRAK}. Fałszywa reguła kosztuje więcej niż przeoczona.

Odpowiedz DOKŁADNIE jedną linią, po polsku, w formacie:
${BRAK}
albo
<krótki tytuł> | <reguła w trybie rozkazującym, jedno zdanie>`;

/** Wsad dla modelu — zwarty, bo to ma być tanie. */
export function zbudujWsad(
  userMessage: string,
  assistantResponse: string,
  wywolania: UzyteNarzedzie[]
): string {
  const opis = wywolania
    .map((w) => {
      const args = JSON.stringify(w.argumenty ?? {});
      return `- ${w.nazwa} ${args.length > LIMIT_ZNAKOW_ARGUMENTOW ? args.slice(0, LIMIT_ZNAKOW_ARGUMENTOW) + "…(ucięte)" : args}`;
    })
    .join("\n");

  return `${PROMPT}

REGUŁY, KTÓRE JUŻ OBOWIĄZUJĄ (nie proponuj niczego, co już tu jest):
${istniejaceReguly()}

Domownik: ${userMessage}
Asystent: ${assistantResponse || "(bez odpowiedzi)"}
Wywołane usługi:
${opis}`;
}

/**
 * Rozbierz odpowiedź na tytuł i treść reguły.
 *
 * Zwraca null dla `BRAK`, dla pustej odpowiedzi i dla wszystkiego, co nie
 * trzyma się formatu. Model, który zaczyna gadać zamiast odpowiadać jedną
 * linią, jest w tym momencie nieprzewidywalny — a to, co stąd wyjdzie, ląduje
 * na liście reguł domowych, więc odrzucenie jest tańsze niż zgadywanie.
 */
export function rozbierzOdpowiedz(surowa: string): { tytul: string; tresc: string } | null {
  const linia = surowa.trim().split("\n")[0]?.trim() ?? "";
  if (!linia || linia.toUpperCase().startsWith(BRAK)) return null;

  const podzial = linia.indexOf("|");
  if (podzial === -1) return null;

  const tytul = linia.slice(0, podzial).trim();
  const tresc = linia.slice(podzial + 1).trim();
  if (!tytul || tresc.length < 10) return null;

  return { tytul, tresc };
}

/**
 * Obejrzyj odrzuconą turę i, jeśli niesie procedurę, zaproponuj z niej regułę.
 *
 * Nigdy nie rzuca. Chodzi za bramką, w ścieżce, która i tak jest „odpal
 * i zapomnij" — awaria ma kosztować jedną przeoczoną propozycję, nigdy turę
 * domownika. Zwraca tytuł zapisanej reguły albo null, żeby dało się to
 * przetestować bez zaglądania do logów.
 */
export async function szukajProcedury(
  extractor: IFactExtractor,
  userMessage: string,
  assistantResponse: string,
  wywolania: UzyteNarzedzie[]
): Promise<string | null> {
  if (typeof extractor.zapytaj !== "function") return null;

  const zmieniajace = wywolania.filter((w) => NARZEDZIA_ZMIENIAJACE.has(w.nazwa));
  if (zmieniajace.length === 0) return null;

  try {
    const odpowiedz = await extractor.zapytaj(
      zbudujWsad(userMessage, assistantResponse, zmieniajace),
      120
    );
    const propozycja = rozbierzOdpowiedz(odpowiedz);
    if (!propozycja) return null;

    // suggestRule sam odrzuca powtórzenia i pilnuje sufitu oczekujących, więc
    // ta sama procedura powtarzana co wieczór nie zrobi z listy reguł śmietnika.
    const regula = suggestRule(propozycja.tytul, propozycja.tresc);
    if (!regula) return null;

    console.log(`[procedury] z odrzuconej tury: „${regula.title}" — czeka wyłączona`);
    return regula.title;
  } catch (err) {
    console.error("[procedury] nie udalo sie sprawdzic tury:", err);
    return null;
  }
}
