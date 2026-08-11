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
/**
 * Zawór bezpieczeństwa, nie oszczędność — i dlatego jest wysoko.
 *
 * Pierwsza wartość, 6000 znaków, była o 332 znaki za niska: blok ważył 6332 i
 * ucięcie wypadało dokładnie na regule 13, czyli **ostatnio dopisanej**. Model
 * zaproponował ją więc ponownie tej samej nocy. To najgorszy możliwy sposób
 * przycinania: nowe reguły są na końcu listy, a jednocześnie to właśnie one
 * najłatwiej wracają jako „nowa" propozycja.
 *
 * Sufit zostaje, bo lista reguł rośnie i kiedyś ktoś wklei do niej powieść —
 * ale na poziomie, którego dzisiejszy dom nie dotknie, i z KRZYKIEM w logu,
 * żeby następne ucięcie nie było znowu ciche.
 */
const LIMIT_BLOKU_REGUL = 24000;

/** Włączone reguły w całości — po to, żeby model nie proponował ich na nowo. */
function istniejaceReguly(): string {
  const linie = loadRules()
    .filter((r) => r.enabled && r.text.trim())
    .map((r) => `- [${r.title}] ${r.text.trim().replace(/\s+/g, " ")}`);

  if (linie.length === 0) return "(brak reguł)";

  const blok = linie.join("\n");
  if (blok.length <= LIMIT_BLOKU_REGUL) return blok;

  console.warn(
    `[procedury] blok regul ma ${blok.length} znakow i zostal uciety do ${LIMIT_BLOKU_REGUL} — ` +
      `NAJNOWSZE reguly sa teraz niewidoczne dla wykrywania duplikatow`
  );
  return blok.slice(0, LIMIT_BLOKU_REGUL) + "\n…(dalsze reguły pominięte)";
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

const PROMPT_NOCNY = `Jesteś obserwatorem asystenta domowego. Dostajesz WSZYSTKIE polecenia z ostatniej doby:
co powiedział domownik, co asystent odpowiedział i jakie usługi naprawdę wywołał (z argumentami).

Twoim zadaniem jest wyłowić PROCEDURY DOMOWE — trwałe zasady „jak się w tym domu robi X",
które przydadzą się przy następnym takim poleceniu i których nie da się odgadnąć z nazw encji.

To JEST procedura:
- odwzorowanie słów domownika na konkretne wartości ("do końca" = pozycja 0, "przyciemnij" = jasność 30%)
- wybór usługi lub skryptu spośród kilku możliwych ("muzyka idzie przez script.zagraj_muzyke")
- stałe parametry, których nie widać w nazwie encji (numery segmentów, źródła, tryby)

To NIE jest procedura — pomiń:
- zwykłe wykonanie polecenia bez żadnego wyboru ("zapal światło" -> light.turn_on)
- jednorazowa wartość, którą domownik podał wprost ("ustaw na 40%")
- cokolwiek o stanie urządzenia w danej chwili
- upodobanie domownika (to jest fakt, nie procedura)

🔁 SPRAWDZIAN NA POWTÓRZENIE — WYKONAJ GO DLA KAŻDEJ LINII, ZANIM JĄ NAPISZESZ:
przejrzyj listę obowiązujących reguł i znajdź tę, która mówi o TYM SAMYM urządzeniu
i TEJ SAMEJ czynności. Jeśli taka istnieje — NIE PISZ tej linii, choćbyś umiał
powiedzieć to krócej, jaśniej albo z lepszym tytułem. Reguła już tam jest.
Przykłady powtórzeń, które trzeba pominąć:
- reguła mówi „«zamknij» = pozycja 0" → NIE proponuj „ustawiaj position 0 dla «zamknij do końca»"
- reguła mówi „muzyka wyłącznie przez script.zagraj_muzyke" → NIE proponuj „wywołuj zagraj_muzyke zamiast play_media"
- reguła mówi „zatrzymuj przez media_stop na media_player.denon" → NIE proponuj tego samego innymi słowami
Lepiej nie zaproponować nic, niż zaproponować to, co już obowiązuje.

⭐ MASZ CAŁĄ DOBĘ NARAZ — KORZYSTAJ Z TEGO. Zachowanie, które POWTARZA SIĘ w wielu turach,
jest procedurą. Zachowanie widziane RAZ to najczęściej jednorazowe polecenie i lepiej je pominąć.
Przy równym wyborze proponuj to, co widziałeś częściej.

Nie wymyślaj encji ani usług. Wolno ci wymienić WYŁĄCZNIE takie, które widnieją w wywołaniach poniżej.

Odpowiedz samymi liniami, po polsku, w formacie:
<krótki tytuł> | <reguła w trybie rozkazującym, jedno zdanie>
Najwyżej ${"${MAKS_PROPOZYCJI}"} linii. Jeśli nie ma nic wartego zapisania, odpowiedz dokładnie: ${BRAK}`;

/**
 * Ile reguł wolno zaproponować za jednym razem.
 *
 * Przebieg ogląda całą dobę, więc bez sufitu jedna noc mogłaby zasypać listę.
 * `suggestRule` ma własny sufit oczekujących (20), ale ten działa dopiero po
 * fakcie — lepiej nie prosić modelu o więcej, niż człowiek przejrzy rano.
 */
const MAKS_PROPOZYCJI = 5;

/** Ile tur pokazać. Doba poleceń mieści się w tym z zapasem. */
const MAKS_TUR = 60;

export interface TuraDoPrzegladu {
  tresc: string;
  odpowiedz?: string;
  wywolania?: UzyteNarzedzie[];
}

/** Wsad nocny: obowiązujące reguły + wszystkie polecenia z doby. */
export function zbudujWsadNocny(tury: TuraDoPrzegladu[]): string {
  const opis = tury
    // Tura bez wywołania zmieniającego stan nie ma procedury do opisania, a
    // pokazana z „Wywołania: (brak)" jest samym szumem w oknie kontekstu.
    .filter((t) => (t.wywolania ?? []).some((w) => NARZEDZIA_ZMIENIAJACE.has(w.nazwa)))
    .slice(-MAKS_TUR)
    .map((t, i) => {
      const wyw = (t.wywolania ?? [])
        .filter((w) => NARZEDZIA_ZMIENIAJACE.has(w.nazwa))
        .map((w) => {
          const a = JSON.stringify(w.argumenty ?? {});
          return `${w.nazwa} ${a.length > LIMIT_ZNAKOW_ARGUMENTOW ? a.slice(0, LIMIT_ZNAKOW_ARGUMENTOW) + "…" : a}`;
        })
        .join("; ");
      return `${i + 1}. Domownik: ${t.tresc}\n   Asystent: ${t.odpowiedz || "(bez odpowiedzi)"}\n   Wywołania: ${wyw || "(brak)"}`;
    })
    .join("\n");

  return `${PROMPT_NOCNY.replace("${MAKS_PROPOZYCJI}", String(MAKS_PROPOZYCJI))}

REGUŁY, KTÓRE JUŻ OBOWIĄZUJĄ (nie proponuj niczego, co już tu jest):
${istniejaceReguly()}

POLECENIA Z OSTATNIEJ DOBY:
${opis}`;
}

/** Rozbierz wielolinijkową odpowiedź nocnego przebiegu. */
export function rozbierzWieleOdpowiedzi(surowa: string): { tytul: string; tresc: string }[] {
  const wynik: { tytul: string; tresc: string }[] = [];
  for (const linia of surowa.split("\n")) {
    const jedna = rozbierzOdpowiedz(linia);
    if (jedna) wynik.push(jedna);
    if (wynik.length >= MAKS_PROPOZYCJI) break;
  }
  return wynik;
}

/**
 * Czy ta jedna propozycja jest już pokryta przez którąś z reguł?
 *
 * Osobne pytanie, bo instrukcja „proponuj procedury, ale pomijaj te, które już
 * są" okazała się nieskuteczna — trzy razy z rzędu, mimo wprost podanych
 * przykładów powtórzeń i pełnej listy reguł w promptcie. Model proszony o
 * WYPRODUKOWANIE listy produkuje ją; pominięcie jest dla niego pobocznym
 * warunkiem, który przegrywa z głównym poleceniem.
 *
 * Pytanie zamknięte o jedną rzecz naraz nie ma tej wady: nie ma nic do
 * wytworzenia, jest tylko rozstrzygnięcie. Kosztuje jedno małe wywołanie na
 * kandydata, a kandydaci pojawiają się raz na dobę i jest ich najwyżej pięciu.
 *
 * Mętna odpowiedź liczy się jako „pokryta": przeoczona procedura wróci jutro,
 * bo dom robi swoje rzeczy w kółko. Duplikat na liście trzeba skasować ręcznie.
 *
 * ⚠️ PUSTA odpowiedź to co innego niż mętna i musi iść w DRUGĄ stronę.
 * Zmierzone: przy `max_tokens` 8 i 16 ten model oddaje pusty łańcuch — budżet
 * zjada rozumowanie, zanim padnie słowo; dopiero przy 64 odpowiada „NIE".
 * Dopóki pustka liczyła się jako „pokryta", bramka odrzucała WSZYSTKO, łącznie
 * z propozycją o zmywarce, o której żadna reguła nie wspomina — i robiła to po
 * cichu. Awaria bramki ma być widoczna na liście propozycji, a nie objawiać się
 * tym, że lista jest podejrzanie pusta przez miesiąc.
 */
export async function czyPokryta(
  extractor: IFactExtractor,
  propozycja: { tytul: string; tresc: string }
): Promise<boolean> {
  if (typeof extractor.zapytaj !== "function") return false;

  const pytanie = `Masz listę reguł domowych i JEDNĄ nową propozycję reguły.

Odpowiedz jednym słowem: czy któraś z istniejących reguł mówi już o TYM SAMYM
urządzeniu i TEJ SAMEJ czynności co propozycja? Inne słowa, inny tytuł czy
krótsze ujęcie NIE czynią z niej nowej reguły.

TAK — temat jest już pokryty, propozycja jest powtórzeniem.
NIE — żadna reguła o tym nie mówi.

REGUŁY:
${istniejaceReguly()}

PROPOZYCJA:
[${propozycja.tytul}] ${propozycja.tresc}

Odpowiedz wyłącznie: TAK albo NIE`;

  try {
    // 200, nie 8: model najpierw myśli, a dopiero potem pisze — przy ciasnym
    // budżecie oddaje pustkę zamiast odpowiedzi.
    const odp = (await extractor.zapytaj(pytanie, 200)).trim().toUpperCase();
    if (!odp) {
      console.warn(
        "[procedury] sprawdzenie powtorzenia oddalo PUSTA odpowiedz — przepuszczam propozycje, " +
          "zeby awaria bramki byla widoczna"
      );
      return false;
    }
    // Wszystko, co nie jest wyraźnym „NIE", traktujemy jak powtórzenie.
    return !odp.startsWith("NIE");
  } catch (err) {
    console.error("[procedury] sprawdzenie powtorzenia sie nie powiodlo:", err);
    return true;
  }
}

/**
 * Obejrzyj dobę poleceń naraz i zgłoś procedury, których jeszcze nie ma.
 *
 * Nigdy nie rzuca — chodzi z zegara, w tle, i awaria ma kosztować jeden
 * pominięty przegląd, nie przewrócone zadanie. Zwraca tytuły zapisanych reguł.
 */
export async function szukajProceduryWsadowo(
  extractor: IFactExtractor,
  tury: TuraDoPrzegladu[]
): Promise<string[]> {
  if (typeof extractor.zapytaj !== "function") return [];

  const zeZmianami = tury.filter((t) =>
    (t.wywolania ?? []).some((w) => NARZEDZIA_ZMIENIAJACE.has(w.nazwa))
  );
  if (zeZmianami.length === 0) return [];

  try {
    const odpowiedz = await extractor.zapytaj(zbudujWsadNocny(zeZmianami), 400);
    const zapisane: string[] = [];
    for (const p of rozbierzWieleOdpowiedzi(odpowiedz)) {
      // Druga bramka, świadomie oddzielona od pierwszej — patrz `czyPokryta`.
      if (await czyPokryta(extractor, p)) {
        console.log(`[procedury] odrzucone jako powtorzenie: „${p.tytul}"`);
        continue;
      }
      const regula = suggestRule(p.tytul, p.tresc);
      if (regula) zapisane.push(regula.title);
    }
    return zapisane;
  } catch (err) {
    console.error("[procedury] nocny przeglad sie nie powiodl:", err);
    return [];
  }
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
