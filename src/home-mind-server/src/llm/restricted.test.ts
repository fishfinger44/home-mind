import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let katalog: string;

// Kazdy test dostaje wlasny plik ustawien: domyslne wartosci maja obowiazywac
// takze wtedy, gdy pliku nie ma, a wspolny plik przenosilby stan miedzy testami.
beforeEach(async () => {
  katalog = mkdtempSync(join(tmpdir(), "ogr-"));
  process.env.RESTRICTIONS_PATH = join(katalog, "ograniczenia.json");
  const { resetRestrictionsCache } = await import("./restricted.js");
  resetRestrictionsCache();
});

afterEach(() => {
  rmSync(katalog, { recursive: true, force: true });
  delete process.env.RESTRICTIONS_PATH;
});

import { checkRestriction, zapiszOgraniczenia } from "./restricted.js";

const nierozpoznany = false;
const rozpoznany = true;

describe("urzadzenia tylko dla rozpoznanych domownikow", () => {
  it("blokuje uruchomienie odkurzacza nierozpoznanemu glosowi", () => {
    const w = checkRestriction("vacuum", "send_command", "vacuum.roborock", nierozpoznany);
    expect(w.allowed).toBe(false);
    expect(w.reason).toContain("rozpoznany domownik");
  });

  it("blokuje przycisk rutyny Roborocka — tak wlasnie ruszyl przypadkiem", () => {
    // Rutyna startuje odkurzacz nie dotykajac domeny vacuum. Ograniczenie samej
    // domeny zostawiloby te droge otwarta.
    const w = checkRestriction("button", "press",
      "button.living_room_roborock_qrevo_edge_series_kuchnia_mopowanie", nierozpoznany);
    expect(w.allowed).toBe(false);
  });

  it("blokuje otwieranie rolet i wlaczanie klimatyzacji", () => {
    expect(checkRestriction("cover", "open_cover", "cover.salon_lewa", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("climate", "set_hvac_mode", "climate.580d0d2f9e31", nierozpoznany).allowed).toBe(false);
  });

  it("NIE POZWALA zatrzymac ani wylaczyc — grupa zamknieta w obie strony", () => {
    // Do 08.08 obcy mogl zatrzymac to, czego nie mogl uruchomic. Dom te ulge
    // odrzucil: zatrzymanie rolet w polowie drogi albo wylaczenie klimy w upal
    // jest tak samo dotkliwe jak wlaczenie, wiec regula jest jedna dla obu osi.
    expect(checkRestriction("vacuum", "stop", "vacuum.roborock", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("cover", "stop_cover", "cover.salon_lewa", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("vacuum", "return_to_base", "vacuum.roborock", nierozpoznany).allowed).toBe(false);
  });

  it("blokuje klimatyzacje w OBIE strony", () => {
    // Przy klimatyzacji zalozenie o kierunku ryzyka nie dziala: wylaczenie jej
    // w upalna noc jest tak samo dotkliwe jak wlaczenie, wiec grupa jest
    // zamknieta w obie strony zamiast rozdzielana.
    for (const usluga of ["turn_off", "turn_on", "set_hvac_mode", "set_temperature"]) {
      expect(
        checkRestriction("climate", usluga, "climate.580d0d2f9e31", nierozpoznany).allowed
      ).toBe(false);
    }
    // Take switch podszywajacy sie pod klimatyzacje.
    expect(
      checkRestriction("switch", "turn_off", "switch.580d0d2f9e31_ac", nierozpoznany).allowed
    ).toBe(false);
  });

  it("odmowa przy klimatyzacji nie obiecuje, ze wylaczyc wolno", () => {
    const powod = checkRestriction("climate", "turn_off", "climate.580d0d2f9e31", nierozpoznany).reason ?? "";
    expect(powod).toContain("włączania, jak i wyłączania");
    expect(powod).not.toContain("Zatrzymanie i wyłączenie są dozwolone");
  });

  it("nie rusza swiatel, muzyki, filmow ani projektora", () => {
    for (const [d, s, e] of [
      ["light", "turn_on", "light.kitchen"],
      ["media_player", "play_media", "media_player.pokoj_dzienny"],
      ["script", "turn_on", "script.zagraj_muzyke"],
      ["switch", "turn_on", "switch.projektor"],
      ["media_assistant", "find_and_play", undefined],
    ] as const) {
      expect(checkRestriction(d, s, e, nierozpoznany).allowed).toBe(true);
    }
  });

  it("rozpoznany domownik moze wszystko", () => {
    expect(checkRestriction("vacuum", "send_command", "vacuum.roborock", rozpoznany).allowed).toBe(true);
    expect(checkRestriction("cover", "open_cover", "cover.salon_lewa", rozpoznany).allowed).toBe(true);
  });

  it("lapie encje z ograniczonej domeny podana bez pola domain", () => {
    expect(checkRestriction(undefined, "press", "cover.sypialnia", nierozpoznany).allowed).toBe(false);
  });

  it("gospodarstwo moze otworzyc odkurzacz dla wszystkich", () => {
    zapiszOgraniczenia({ grupy: ["rolety", "klimatyzacja"] });
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("button", "press", "button.roborock_kuchnia", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("cover", "open_cover", "cover.salon", nierozpoznany).allowed).toBe(false);
  });

  it("gospodarstwo moze domknac swiatlo — takze gaszenie", () => {
    zapiszOgraniczenia({ grupy: ["swiatlo"] });
    expect(checkRestriction("light", "turn_on", "light.kitchen", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("light", "turn_off", "light.kitchen", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", nierozpoznany).allowed).toBe(true);
  });

  it("nazywa grupe w odmowie, zeby dalo sie ja odnalezc w panelu", () => {
    expect(checkRestriction("cover", "open_cover", "cover.salon", nierozpoznany).reason)
      .toContain("Rolety");
  });
});

describe("uprawnienia per domownik", () => {
  // Powod istnienia tej osi: dzieci maja byc zarejestrowane (wlasna pamiec,
  // wlasna osobowosc), a rejestracja nie ma im wrecza odkurzacza i klimy.
  const zOdebranymi = () =>
    zapiszOgraniczenia({
      grupy: ["odkurzacz", "rolety", "klimatyzacja", "zamki"],
      osoby: { wladek: ["odkurzacz", "klimatyzacja"] },
    });

  it("odbiera odkurzacz i klimatyzacje Wladkowi, choc jest rozpoznany", () => {
    zOdebranymi();
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", rozpoznany, "wladek").allowed).toBe(false);
    expect(checkRestriction("climate", "set_hvac_mode", "climate.580d0d2f9e31", rozpoznany, "wladek").allowed).toBe(false);
  });

  it("zamyka odebrana grupe w OBIE strony — takze zatrzymanie", () => {
    zOdebranymi();
    expect(checkRestriction("vacuum", "stop", "vacuum.roborock", rozpoznany, "wladek").allowed).toBe(false);
    expect(checkRestriction("vacuum", "return_to_base", "vacuum.roborock", rozpoznany, "wladek").allowed).toBe(false);
  });

  it("lapie skrot rutyny Roborocka takze na tej osi", () => {
    // Ta sama dziura co przy nierozpoznanych: rutyna startuje odkurzacz nie
    // dotykajac domeny vacuum.
    zOdebranymi();
    expect(checkRestriction("button", "press", "button.roborock_kuchnia", rozpoznany, "wladek").allowed).toBe(false);
  });

  it("zostawia Wladkowi wszystko, czego mu nie odebrano", () => {
    zOdebranymi();
    expect(checkRestriction("light", "turn_on", "light.kuchnia", rozpoznany, "wladek").allowed).toBe(true);
    expect(checkRestriction("cover", "open_cover", "cover.salon", rozpoznany, "wladek").allowed).toBe(true);
    expect(checkRestriction("media_player", "media_play", "media_player.denon", rozpoznany, "wladek").allowed).toBe(true);
  });

  it("nie rusza domownikow bez wpisu — rozpoznanie znaczy to, co znaczylo", () => {
    // Wsteczna zgodnosc jest cala umowa: nikomu nic nie ubylo przy wdrozeniu.
    zOdebranymi();
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", rozpoznany, "lech").allowed).toBe(true);
    expect(checkRestriction("climate", "set_hvac_mode", "climate.580d0d2f9e31", rozpoznany, "zuza").allowed).toBe(true);
  });

  it("bez podanego mowcy zachowuje sie jak dotad", () => {
    // Sesje pisane i starsi wolajacy nie przekazuja tozsamosci, a sa juz
    // uwierzytelnieni — nie wolno ich zablokowac przy okazji.
    zOdebranymi();
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", rozpoznany).allowed).toBe(true);
  });

  it("odmowa NIE tlumaczy sie nierozpoznaniem glosu", () => {
    // Wladek zostal rozpoznany. Powiedzenie mu „nie poznaje Twojego glosu"
    // byloby nieprawda i wyslaloby go w powtarzanie polecenia bez konca.
    zOdebranymi();
    const w = checkRestriction("vacuum", "start", "vacuum.roborock", rozpoznany, "wladek");
    expect(w.reason).toContain("Odkurzacz");
    expect(w.reason).not.toContain("nie rozpoznałem");
  });

  it("ignoruje wymyslone id grupy w zapisie", () => {
    zapiszOgraniczenia({
      grupy: ["odkurzacz"],
      osoby: { wladek: ["odkurzacz", "czajnik-ktorego-nie-ma"] },
    });
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", rozpoznany, "wladek").allowed).toBe(false);
    expect(checkRestriction("light", "turn_on", "light.kuchnia", rozpoznany, "wladek").allowed).toBe(true);
  });
});

describe("ustalSprawce — w czyim imieniu działa polecenie", () => {
  const LECH = { mowca: "lech", userId: "u-lech", userName: "Lech", rozpoznany: true };
  const WLADEK = { mowca: "wladek", userId: "u-wladek", userName: "Władek", rozpoznany: true };
  const OBCY = { mowca: null, userId: null, userName: null, rozpoznany: false };

  it("bez wskazania zostawia właściciela tury — zachowanie sprzed diaryzacji", async () => {
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce("u-lech", true, undefined, [LECH, WLADEK])).toEqual({
      sprawca: "u-lech",
      rozpoznany: true,
    });
  });

  it("bez podziału na mówców wskazanie jest ignorowane", async () => {
    // Pojedynczy mówca to 96% tur: nie ma listy, wobec której dałoby się
    // cokolwiek sprawdzić, więc wskazanie nie może niczego zmienić.
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce("u-lech", true, "wladek", undefined)).toEqual({
      sprawca: "u-lech",
      rozpoznany: true,
    });
  });

  it("wskazanie innego mówcy z tej tury przenosi sprawstwo na niego", async () => {
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce("u-lech", true, "wladek", [LECH, WLADEK])).toEqual({
      sprawca: "u-wladek",
      rozpoznany: true,
    });
  });

  it("wskazać można po imieniu wyświetlanym, nie tylko po nazwie odcisku", async () => {
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce("u-lech", true, "Władek", [LECH, WLADEK]).sprawca).toBe("u-wladek");
  });

  it("🔴 wskazanie kogoś, kto w tej turze NIE mówił, odbiera uprawnienia", async () => {
    // Sedno bramki. Gdyby model wskazał domownika, którego w nagraniu nie było,
    // polecenie z telewizora dostałoby jego prawa do odkurzacza i rolet.
    const { ustalSprawce } = await import("./restricted.js");
    const wynik = ustalSprawce("u-lech", true, "zuza", [LECH, WLADEK]);
    expect(wynik.rozpoznany).toBe(false);
    expect(wynik.sprawca).toBeUndefined();
    expect(wynik.powod).toContain("zuza");
  });

  it("🔴 wskazanie mówcy NIEROZPOZNANEGO też odbiera uprawnienia", async () => {
    const { ustalSprawce } = await import("./restricted.js");
    const wynik = ustalSprawce("u-lech", true, "?", [LECH, OBCY]);
    expect(wynik.rozpoznany).toBe(false);
    expect(wynik.sprawca).toBeUndefined();
  });

  it("wielkość liter i spacje we wskazaniu nie mają znaczenia", async () => {
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce("u-lech", true, "  WŁADEK  ".trim(), [LECH, WLADEK]).sprawca).toBe(
      "u-wladek"
    );
  });

  it("sprawstwo wskazuje na profil osoby, a nie na nazwę odcisku", async () => {
    // `restricted.ts` szuka ograniczeń po kluczu osoby (`ustawienia.osoby[...]`),
    // więc pomyłka na tym poziomie po cichu otwierałaby zamknięte grupy.
    const { ustalSprawce } = await import("./restricted.js");
    expect(ustalSprawce(undefined, false, "lech", [LECH]).sprawca).toBe("u-lech");
  });
});
