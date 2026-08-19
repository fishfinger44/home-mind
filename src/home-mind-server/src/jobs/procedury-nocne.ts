/**
 * Nocny przegląd poleceń pod kątem procedur domowych.
 *
 * Do 11.08.2026 działo się to przy każdej odrzuconej turze, na żywo. Decyzja
 * Lecha: raz na dobę wystarczy — i wychodzi na tym lepiej, nie tylko taniej.
 *
 * Lepiej, bo jedna tura to jeden przypadek, a z jednego przypadku nie widać
 * różnicy między procedurą a przypadkiem. Pierwsze trzy propozycje, jakie ten
 * mechanizm w życiu zgłosił, były tego dowodem: jedna uogólniła encję z tury,
 * w której rozpoznawanie mowy przekręciło „na Denonie" na „na Dunaju". Przegląd
 * całej doby widzi POWTÓRZENIA, a powtórzenie jest jedynym dostępnym tu
 * dowodem, że coś jest zasadą domu, a nie jednorazowym poleceniem.
 *
 * Taniej przy okazji: kilkanaście wywołań dziennie zamienia się w jedno,
 * a blok obowiązujących reguł (~1200 tokenów, potrzebny żeby odsiać duplikaty)
 * jest wysyłany raz zamiast kilkunastu razy.
 */

import type { IFactExtractor } from "../llm/interface.js";
import { czytajPominiecia, usunPrzejrzaneBramki } from "../memory/pominiete.js";
import { szukajProceduryWsadowo, type TuraDoPrzegladu } from "../memory/procedury.js";

/**
 * Co ile sprawdzać zegar.
 *
 * Nie `setTimeout` do najbliższej godziny H: przy zmianie czasu i przy
 * uśpieniu maszyny takie odliczanie wypada obok. Zaglądanie na zegar co
 * kwadrans jest odporne na jedno i drugie, a kosztuje odczyt daty.
 */
const KROK_MS = 15 * 60 * 1000;

export class ProceduryJob {
  private timer: NodeJS.Timeout | null = null;
  /** Dzień ostatniego przebiegu (lokalny `YYYY-MM-DD`), żeby nie powtórzyć go w tej samej dobie. */
  private ostatniDzien: string | null = null;

  constructor(
    private extractor: () => IFactExtractor,
    /** Godzina lokalna 0-23. Ujemna wyłącza przegląd. */
    private godzina: number
  ) {}

  start(): void {
    if (this.godzina < 0 || this.godzina > 23) {
      console.log("[procedury] nocny przeglad wylaczony");
      return;
    }
    console.log(`[procedury] nocny przeglad o godzinie ${this.godzina}`);
    this.timer = setInterval(() => {
      void this.sprawdzZegar();
    }, KROK_MS);
    // Nie blokuj wyjscia z procesu tylko dlatego, ze czekamy na noc.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sprawdzZegar(): Promise<void> {
    const teraz = new Date();
    const dzis = `${teraz.getFullYear()}-${teraz.getMonth() + 1}-${teraz.getDate()}`;
    if (teraz.getHours() !== this.godzina || this.ostatniDzien === dzis) return;
    this.ostatniDzien = dzis;
    await this.uruchom();
  }

  /**
   * Przejrzyj ostatnią dobę. Publiczne, żeby dało się wywołać ręcznie
   * (endpoint w panelu, test na żywo) bez czekania do nocy.
   */
  async uruchom(): Promise<string[]> {
    const granica = Date.now() - 24 * 60 * 60 * 1000;
    const teraz = new Date().toISOString();
    const tury: TuraDoPrzegladu[] = czytajPominiecia(500)
      .filter((w) => w.rodzaj === "bramka" && Date.parse(w.kiedy) >= granica)
      .map((w) => ({ tresc: w.tresc, odpowiedz: w.odpowiedz, wywolania: w.wywolania }));

    if (tury.length === 0) {
      console.log("[procedury] nocny przeglad: brak polecen z ostatniej doby");
      // Nawet gdy z ostatniej doby nic nie ma, starsze polecenia zdazyly juz byc
      // przejrzane w swojej nocy — nie ma po co ich trzymac.
      const p = usunPrzejrzaneBramki(teraz);
      if (p) console.log(`[procedury] posprzatane wpisy polecen: ${p}`);
      return [];
    }

    const zapisane = await szukajProceduryWsadowo(this.extractor(), tury);
    console.log(
      `[procedury] nocny przeglad: ${tury.length} polecen, propozycji: ${zapisane.length}` +
        (zapisane.length ? ` (${zapisane.join(", ")})` : "")
    );
    // Przejrzane polecenia nie niosa juz nic nowego: propozycje sa zapisane osobno,
    // a wpisy `filtr` (jedyny slad po odrzuconym fakcie) zostaja nietkniete.
    const posprzatane = usunPrzejrzaneBramki(teraz);
    if (posprzatane) console.log(`[procedury] posprzatane wpisy polecen: ${posprzatane}`);
    return zapisane;
  }
}
