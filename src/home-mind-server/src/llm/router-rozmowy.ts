// Wczesny router: czy ta tura na pewno nie potrzebuje domu.
//
// PO CO. Do 14.08 o skierowaniu na sciezke rozmowna decydowal model, wolajac
// narzedzie `odpowiedz_rozmowa`. Dziala, ale kosztuje PELNE wywolanie Gemini
// z calym promptem i osmioma narzedziami, zanim shim w ogole dostanie pytanie.
// Zmierzone w rozmowie na zywo: 3,8 s i 5,9 s samej decyzji, przy 5,6-5,7 s
// wlasciwej odpowiedzi. Czyli polowa czasu szla na ustalenie, gdzie zapytac.
//
// 🔑 ASYMETRIA RYZYKA WYZNACZA CALY PROJEKT. Pomylka w jedna strone jest
// niegrozna, w druga jest awaria:
//   * rozmowa wyslana stara droga  → wolniej o kilka sekund, wynik ten sam;
//   * KOMENDA wyslana na rozmowe   → sciezka rozmowna NIE MA narzedzi, wiec
//     polecenie po prostu SIE NIE WYKONA, a czlowiek uslyszy gladka odpowiedz.
// Dlatego: weto domowe wygrywa ZAWSZE, a przy jakiejkolwiek watpliwosci tura
// idzie stara droga. Ten router ma tylko SKRACAC pewne przypadki, nie
// zastepowac decyzji modelu.
//
// ⛔ Swiadomie NIE jest to model ani kolejne wywolanie sieciowe — to musi
// kosztowac zero, inaczej oszczedzamy 4 s i dokladamy 1 s.

/** Znormalizowana postac do dopasowan: bez ogonkow, malymi literami.
 *
 *  ⚠️ Ogonki znikaja CELOWO. Transkrypcja bywa ich pozbawiona albo je myli
 *  („zart", „zgas"), a lista wzorcow, ktora dziala tylko dla poprawnej
 *  polszczyzny, cicho przestaje lapac dokladnie te wypowiedzi, dla ktorych
 *  powstala. */
export function znormalizuj(tekst: string): string {
  return tekst
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l") // ł nie rozklada sie przez NFD — to osobna litera
    .replace(/\s+/g, " ")
    .trim();
}

// WETO. Cokolwiek stad pada w wypowiedzi — tura idzie stara droga, bez dyskusji.
//
// ⚠️ Ta lista ma byc PRZESADNIE SZEROKA. Nadmiar znaczy „czasem wolniejszy
// zart"; niedomiar znaczy „polecenie, ktore sie nie wykonalo". Dopisujac
// cokolwiek, kierowac sie ta sama zasada i nie „sprzatac" jej z pozycji,
// ktore wygladaja na zbedne.
const WETO_DOMOWE = [
  // czynnosci
  "wlacz", "wylacz", "zapal", "zgas", "ustaw", "otworz", "zamknij", "podnies",
  "opusc", "przyciemnij", "rozjasnij", "odkurz", "przelacz", "uruchom",
  "zatrzymaj", "zapauzuj", "wznow", "glosniej", "ciszej", "przewin", "wstrzymaj",
  "sprawdz", "pokaz", "nastaw", "przypomnij", "dodaj", "dopisz", "kup", "kupic",
  "zamow", "zaplanuj", "usun", "skasuj", "zmien", "zrob", "puscic", "pusc",
  "wlaczyc", "wylaczyc", "zagraj", "graj", "odtworz",
  // urzadzenia i wielkosci
  "swiatlo", "swiatla", "swiatel", "lampa", "lampe", "lampy", "lampka",
  "zyrandol", "roleta", "rolety", "rolet", "okno", "okna", "drzwi", "brama",
  "odkurzacz", "temperatura", "temperature", "termostat", "ogrzewanie",
  "klimatyzacja", "wilgotnosc", "czujnik", "telewizor", "projektor", "ekran",
  "muzyka", "muzyke", "radio", "glosnosc", "playlista", "playliste", "piosenka",
  "piosenke", "utwor", "film", "serial", "odtwarzacz", "wzmacniacz", "denon",
  "kalendarz", "wydarzenie", "spotkanie", "przypomnienie", "minutnik", "budzik",
  "timer", "alarm", "pogoda", "pogode", "prognoza", "prognoze", "zakupy",
  "trasa", "trase", "odjazd", "odjazdy", "autobus", "tramwaj", "przystanek",
  "linia", "linii", "dojade", "dojechac",
  // miejsca
  "salon", "salonie", "kuchnia", "kuchni", "jadalnia", "jadalni", "sypialnia",
  "sypialni", "lazienka", "lazience", "biuro", "biurze", "garaz", "garazu",
  "ogrod", "ogrodzie", "taras", "tarasie", "korytarz", "korytarzu", "pietro",
  "pietrze", "parter", "parterze", "pokoj", "pokoju", "dom", "domu",
  // pytania o stan
  "czy jest", "czy sa", "czy zamkniete", "czy otwarte", "czy wlaczone",
  "ile stopni", "jaka jest temperatura", "co gra", "kto jest w domu",
];

// Mocne sygnaly rozmowy. Musza wystapic, zeby cokolwiek skrocic.
//
// ⛔ Celowo WASKA lista: dokladnie te rzeczy, ktore w zmierzonej rozmowie
// przepalaly po 4-6 s na sama decyzje. Wiedzy ogolnej („kto to byl…",
// „dlaczego niebo…") tu NIE MA — te pytania bywaja splecione z domem
// i niech dalej rozstrzyga je model.
const WZORCE_ROZMOWY = [
  "zart", "zarcik", "zarty", "dowcip", "kawal", "zagadka", "zagadke", "zagadki",
  "ciekawostka", "ciekawostke", "ciekawostki", "rozsmiesz", "rozweselic",
  "rozsmieszyc", "cos smiesznego", "cos zabawnego", "limeryk", "anegdota",
  "anegdote", "rymowanka", "rymowanke", "wierszyk",
];

/** Ile slow moze miec odpowiedz uznana za kontynuacje rozmowy. */
const MAX_SLOW_KONTYNUACJI = 6;

export interface DecyzjaRouteru {
  /** Czy skrocic i wyslac wprost na sciezke rozmowna. */
  naRozmowe: boolean;
  /** Do logu — zeby dalo sie pozniej sprawdzic, czemu tak, bez zgadywania. */
  powod: string;
  /** Czy w wypowiedzi padlo slowo z domowego slownika.
   *
   *  🔴 Sluzy do czegos WIECEJ niz zablokowanie skrotu. Zmierzone 14.08 na
   *  zywo: przy „opowiedz zart i sprawdz czy okno w salonie jest zamkniete"
   *  model SAM wywolal `odpowiedz_rozmowa` — wbrew wlasnemu opisowi narzedzia,
   *  ktory tego zabrania dla wypowiedzi mieszanych — i okno nie zostalo
   *  sprawdzone. Sam opis narzedzia okazal sie wiec niewystarczajaca bariera.
   *  Gdy to jest `true`, silnik NIE POKAZUJE modelowi narzedzia rozmownego,
   *  wiec nie ma czym zlamac tej zasady. */
  wetoDomowe: boolean;
}

export interface KontekstRouteru {
  /** Czy POPRZEDNIA tura tej rozmowy poszla na sciezke rozmowna. */
  poprzedniaNaRozmowie: boolean;
  /** Czy ostatnia wypowiedz asystenta konczyla sie pytaniem. */
  asystentPytal: boolean;
}

export function zdecyduj(wypowiedz: string, kontekst: KontekstRouteru): DecyzjaRouteru {
  const t = znormalizuj(wypowiedz);
  if (!t) return { naRozmowe: false, powod: "pusta wypowiedz", wetoDomowe: false };

  const weto = WETO_DOMOWE.find((w) => t.includes(w));
  if (weto) {
    return { naRozmowe: false, powod: `weto domowe: "${weto}"`, wetoDomowe: true };
  }

  const wzorzec = WZORCE_ROZMOWY.find((w) => t.includes(w));
  if (wzorzec) {
    return { naRozmowe: true, powod: `wzorzec rozmowy: "${wzorzec}"`, wetoDomowe: false };
  }

  // KONTYNUACJA. Gdy poprzednia tura poszla na rozmowe, a asystent skonczyl
  // pytaniem, krotka odpowiedz jest niemal na pewno odpowiedzia NA NIE.
  //
  // 🔴 Warunek `poprzedniaNaRozmowie` jest tu NIEZBEDNY, nie ozdobny. Bez
  // niego „tak" po pytaniu asystenta „czy zgasic swiatlo w salonie?" zostaloby
  // skierowane na sciezke bez narzedzi i swiatlo nigdy by nie zgaslo.
  if (kontekst.poprzedniaNaRozmowie && kontekst.asystentPytal) {
    const slow = t.split(" ").length;
    if (slow <= MAX_SLOW_KONTYNUACJI) {
      return {
        naRozmowe: true,
        powod: `kontynuacja rozmowy (${slow} sl.)`,
        wetoDomowe: false,
      };
    }
  }

  return { naRozmowe: false, powod: "brak pewnego sygnalu", wetoDomowe: false };
}
