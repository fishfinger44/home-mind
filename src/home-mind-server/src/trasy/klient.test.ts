import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  czasZapytania,
  godzina,
  godzinaSlownie,
  sformatujTrasy,
  zaplanujTrase,
  type KrokPrzejazdu,
  type OdpowiedzGoogle,
} from "./klient.js";
import { zapomnijUstawienia } from "./ustawienia.js";
import { zapomnijUzycie, zuzyteDzis } from "./uzycie.js";

/**
 * Skrocona odpowiedz Routes API dla maski, o ktora prosimy: dojscie pieszo,
 * autobus 111 i jeszcze kawalek pieszo. Kierunek ("Sepolno") jest tu tym, po co
 * cale narzedzie powstalo.
 */
const ODPOWIEDZ: OdpowiedzGoogle = {
  routes: [
    {
      duration: "2040s",
      legs: [
        {
          steps: [
            { travelMode: "WALK", staticDuration: "360s" },
            {
              travelMode: "TRANSIT",
              staticDuration: "1320s",
              transitDetails: {
                headsign: "Sepolno",
                stopCount: 9,
                stopDetails: {
                  departureStop: { name: "Waniliowa" },
                  departureTime: "2026-08-11T15:18:00Z",
                  arrivalStop: { name: "Rynek" },
                  arrivalTime: "2026-08-11T15:40:00Z",
                },
                transitLine: {
                  name: "111 Sepolno",
                  nameShort: "111",
                  vehicle: { type: "BUS" },
                },
              },
            },
            { travelMode: "WALK", staticDuration: "180s" },
          ],
        },
      ],
    },
  ],
};

describe("sformatujTrasy", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
  });

  it("wyciaga numer linii, KIERUNEK, przystanki i godziny", () => {
    const [trasa] = sformatujTrasy(ODPOWIEDZ);

    expect(trasa.czas_minut).toBe(34);
    expect(trasa.kroki).toHaveLength(3);

    const przejazd = trasa.kroki[1] as KrokPrzejazdu;
    expect(przejazd).toEqual({
      linia: "111",
      kierunek: "Sepolno",
      typ: "autobus",
      wsiadz: "Waniliowa",
      o: "17:18",
      o_mowa: "o siedemnastej osiemnaście",
      wysiadz: "Rynek",
      przyjazd: "17:40",
      przyjazd_mowa: "o siedemnastej czterdzieści",
      przystankow: 9,
    });
  });

  it("godziny calej trasy bierze z pierwszego i ostatniego przejazdu", () => {
    const [trasa] = sformatujTrasy(ODPOWIEDZ);
    expect(trasa.wyjazd).toBe("17:18");
    expect(trasa.przyjazd).toBe("17:40");
  });

  it("marsz krotszy niz minuta nie jest krokiem", () => {
    const [trasa] = sformatujTrasy({
      routes: [{ duration: "60s", legs: [{ steps: [{ travelMode: "WALK", staticDuration: "20s" }] }] }],
    });
    expect(trasa.kroki).toEqual([]);
  });

  it("pusta odpowiedz daje pusta liste", () => {
    expect(sformatujTrasy({})).toEqual([]);
  });

  it("uzywa pelnej nazwy linii, gdy nie ma numeru", () => {
    const [trasa] = sformatujTrasy({
      routes: [
        {
          duration: "600s",
          legs: [
            {
              steps: [
                {
                  travelMode: "TRANSIT",
                  transitDetails: {
                    transitLine: { name: "Kolej Dolnoslaska", vehicle: { type: "HEAVY_RAIL" } },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const przejazd = trasa.kroki[0] as KrokPrzejazdu;
    expect(przejazd.linia).toBe("Kolej Dolnoslaska");
    expect(przejazd.typ).toBe("pociag");
  });

  /**
   * Google tnie dojscie na kroki NAWIGACYJNE ("skrec w lewo"), wiec jedno
   * przejscie wraca jako kilka. Bez scalania asystent mowi "idz 2 minuty,
   * potem idz 2 minuty" - zmierzone na zywo 11.08 na trasie do Rynku.
   */
  it("sasiadujace kroki piesze scala w jeden", () => {
    const [trasa] = sformatujTrasy({
      routes: [
        {
          duration: "1200s",
          legs: [
            {
              steps: [
                { travelMode: "WALK", staticDuration: "120s" },
                { travelMode: "WALK", staticDuration: "120s" },
                { travelMode: "WALK", staticDuration: "360s" },
                {
                  travelMode: "TRANSIT",
                  transitDetails: {
                    transitLine: { nameShort: "111", vehicle: { type: "BUS" } },
                    stopDetails: { arrivalTime: "2026-08-11T15:40:00Z" },
                  },
                },
                { travelMode: "WALK", staticDuration: "60s" },
                { travelMode: "WALK", staticDuration: "180s" },
              ],
            },
          ],
        },
      ],
    });

    expect(trasa.kroki).toHaveLength(3);
    expect(trasa.kroki[0]).toEqual({ pieszo_minut: 10 });
    expect(trasa.kroki[2]).toEqual({ pieszo_minut: 4 });
  });

  it("scala takze marsze ponizej minuty, ktore razem daja minute", () => {
    const [trasa] = sformatujTrasy({
      routes: [
        {
          duration: "120s",
          legs: [
            {
              steps: [
                { travelMode: "WALK", staticDuration: "40s" },
                { travelMode: "WALK", staticDuration: "50s" },
              ],
            },
          ],
        },
      ],
    });
    // Kazdy z osobna zaokraglil sie do zera i znikal; razem to poltorej minuty.
    expect(trasa.kroki).toEqual([{ pieszo_minut: 2 }]);
  });

  /**
   * `czas_minut` liczy sie od TERAZ, wiec wariant z krotszym czekaniem na
   * przystanku wychodzi w nim "szybszy", chociaz dowozi pozniej. Pasazera
   * obchodzi godzina dojazdu.
   */
  it("ustawia warianty po godzinie dojazdu, nie po czasie przejazdu", () => {
    const trasy = sformatujTrasy({
      routes: [
        { duration: "2820s", legs: [{ steps: [przejazdO("2026-08-11T21:13:00Z")] }] },
        { duration: "3060s", legs: [{ steps: [przejazdO("2026-08-11T21:04:00Z")] }] },
      ],
    });

    expect(trasy.map((t) => t.przyjazd)).toEqual(["23:04", "23:13"]);
    expect(trasy[0].czas_minut).toBe(51);
  });

  it("kolejnosci nie odwraca polnoc", () => {
    const trasy = sformatujTrasy({
      routes: [
        { duration: "600s", legs: [{ steps: [przejazdO("2026-08-11T22:10:00Z")] }] },
        { duration: "600s", legs: [{ steps: [przejazdO("2026-08-11T21:55:00Z")] }] },
      ],
    });
    // Po napisie "00:10" wyprzedziloby "23:55"; po znaczniku czasu - nie.
    expect(trasy.map((t) => t.przyjazd)).toEqual(["23:55", "00:10"]);
  });

  it("marsz z ostatniego przystanku wlicza sie do dojazdu", () => {
    const trasy = sformatujTrasy({
      routes: [
        {
          duration: "600s",
          legs: [
            {
              steps: [
                przejazdO("2026-08-11T21:00:00Z"),
                { travelMode: "WALK", staticDuration: "900s" },
              ],
            },
          ],
        },
        { duration: "600s", legs: [{ steps: [przejazdO("2026-08-11T21:05:00Z")] }] },
      ],
    });
    // Autobus jest na miejscu wczesniej, ale kwadrans marszu oddaje mu pierwszenstwo.
    expect(trasy.map((t) => t.przyjazd)).toEqual(["23:05", "23:00"]);
  });

  it("trasa bez przejazdu zostaje na koncu, w kolejnosci Google", () => {
    const trasy = sformatujTrasy({
      routes: [
        { duration: "1800s", legs: [{ steps: [{ travelMode: "WALK", staticDuration: "1800s" }] }] },
        { duration: "600s", legs: [{ steps: [przejazdO("2026-08-11T21:00:00Z")] }] },
      ],
    });
    expect(trasy[0].przyjazd).toBe("23:00");
    expect(trasy[1].przyjazd).toBeUndefined();
  });
});

/** Najkrotszy przejazd, jaki da sie zbudowac - liczy sie tylko godzina dojazdu. */
function przejazdO(arrivalTime: string) {
  return {
    travelMode: "TRANSIT",
    transitDetails: {
      transitLine: { nameShort: "111", vehicle: { type: "BUS" } },
      stopDetails: { arrivalTime },
    },
  };
}

describe("godzina", () => {
  it("przelicza na czas domu", () => {
    process.env.TZ = "Europe/Warsaw";
    expect(godzina("2026-08-11T15:18:00Z")).toBe("17:18");
  });

  it("zly znacznik czasu nie wysadza formatowania", () => {
    expect(godzina("nie-data")).toBeUndefined();
    expect(godzina(undefined)).toBeUndefined();
  });
});

describe("godzinaSlownie", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
  });

  /** Blad, dla ktorego ta funkcja powstala: model mowil "czterdziestej piec". */
  it("minuty sa liczebnikiem GLOWNYM, nie porzadkowym", () => {
    expect(godzinaSlownie("2026-08-11T21:45:00Z")).toBe(
      "o dwudziestej trzeciej czterdzieści pięć"
    );
  });

  it("pelna godzina nie mowi 'zero zero'", () => {
    expect(godzinaSlownie("2026-08-11T16:00:00Z")).toBe("o osiemnastej");
  });

  /** Minuty sa zenskie ("dwie minuty"), wiec nie "czterdziesci dwa". */
  it("dwojka w minutach jest zenska", () => {
    expect(godzinaSlownie("2026-08-11T15:42:00Z")).toBe(
      "o siedemnastej czterdzieści dwie"
    );
    expect(godzinaSlownie("2026-08-11T20:22:00Z")).toBe(
      "o dwudziestej drugiej dwadzieścia dwie"
    );
  });

  it("nastki nie sklejaja sie z dziesiatkami", () => {
    expect(godzinaSlownie("2026-08-11T19:19:00Z")).toBe(
      "o dwudziestej pierwszej dziewiętnaście"
    );
  });

  it("minuty jednocyfrowe dostaja 'zero'", () => {
    expect(godzinaSlownie("2026-08-11T06:05:00Z")).toBe("o ósmej zero pięć");
  });

  it("polnoc to godzina zerowa", () => {
    expect(godzinaSlownie("2026-08-11T22:30:00Z")).toBe("o zerowej trzydzieści");
  });

  it("zly znacznik czasu nie wysadza formatowania", () => {
    expect(godzinaSlownie("nie-data")).toBeUndefined();
    expect(godzinaSlownie(undefined)).toBeUndefined();
  });
});

describe("czasZapytania", () => {
  const teraz = new Date("2026-08-11T15:00:00Z");

  it("brak, 'teraz' i bzdura znacza teraz (czyli nic nie wysylamy)", () => {
    expect(czasZapytania(undefined, teraz)).toBeUndefined();
    expect(czasZapytania("teraz", teraz)).toBeUndefined();
    expect(czasZapytania("kiedys", teraz)).toBeUndefined();
  });

  it("godzina z przeszlosci jest odrzucana, bo Google ja odrzuca", () => {
    expect(czasZapytania("2026-08-11T14:00:00Z", teraz)).toBeUndefined();
  });

  it("godzina z przyszlosci idzie jako ISO", () => {
    expect(czasZapytania("2026-08-11T18:30:00Z", teraz)).toBe("2026-08-11T18:30:00.000Z");
  });
});

describe("zaplanujTrase", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
    process.env.TRASY_UZYCIE_PATH = join(mkdtempSync(join(tmpdir(), "trasy-")), "uzycie.json");
    process.env.TRASY_MIEJSCA = JSON.stringify({
      dom: "Waniliowa 1, Wroclaw",
      centrum: "Rynek, Wroclaw",
    });
    process.env.GOOGLE_ROUTES_API_KEY = "klucz-testowy";
    process.env.TRASY_CONFIG_PATH = "/nie/ma/takiego/pliku.json";
    delete process.env.TRASY_LIMIT_DZIENNY;
    zapomnijUstawienia();
    zapomnijUzycie();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_ROUTES_API_KEY;
    delete process.env.TRASY_MIEJSCA;
    delete process.env.TRASY_UZYCIE_PATH;
    delete process.env.TRASY_LIMIT_DZIENNY;
  });

  function odpowiedzOk(dane: OdpowiedzGoogle = ODPOWIEDZ) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => dane,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("bez klucza nie dzwoni nigdzie i kaze powiedziec prawde", async () => {
    delete process.env.GOOGLE_ROUTES_API_KEY;
    const fetchMock = odpowiedzOk();

    const wynik = await zaplanujTrase({ dokad: "centrum" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wynik).toHaveProperty("error");
    expect((wynik as { error: string }).error).toContain("klucza do Routes API");
  });

  it("domyslnym poczatkiem jest dom, a skroty sa tlumaczone na adresy", async () => {
    const fetchMock = odpowiedzOk();

    const wynik = await zaplanujTrase({ dokad: "centrum" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.origin.address).toBe("Waniliowa 1, Wroclaw");
    expect(body.destination.address).toBe("Rynek, Wroclaw");
    expect(body.travelMode).toBe("TRANSIT");
    expect(body.departureTime).toBeUndefined();
    expect(wynik).toMatchObject({ skad: "Waniliowa 1, Wroclaw", dokad: "Rynek, Wroclaw" });
  });

  it("prosi o pola z kierunkiem — bez nich narzedzie nie ma sensu", async () => {
    const fetchMock = odpowiedzOk();
    await zaplanujTrase({ dokad: "centrum" });
    const naglowki = fetchMock.mock.calls[0][1].headers;
    expect(naglowki["X-Goog-FieldMask"]).toContain("routes.legs.steps.transitDetails");
    expect(naglowki["X-Goog-Api-Key"]).toBe("klucz-testowy");
  });

  it("'przyjazd' wysyla arrivalTime zamiast departureTime", async () => {
    const fetchMock = odpowiedzOk();
    const zaGodzine = new Date(Date.now() + 3600_000).toISOString();

    await zaplanujTrase({ dokad: "centrum", kiedy: zaGodzine, kiedyZnaczy: "przyjazd" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.arrivalTime).toBe(zaGodzine);
    expect(body.departureTime).toBeUndefined();
  });

  it("dolacza note o zrodle, zeby asystent nie obiecywal danych na zywo", async () => {
    odpowiedzOk();
    const wynik = await zaplanujTrase({ dokad: "centrum" });
    expect(wynik).toHaveProperty("zrodlo");
    expect((wynik as { zrodlo: string }).zrodlo).toContain("bez opoznien");
  });

  it("liczy wywolanie i zatrzymuje sie na dziennym limicie", async () => {
    process.env.TRASY_LIMIT_DZIENNY = "1";
    const fetchMock = odpowiedzOk();

    await zaplanujTrase({ dokad: "centrum" });
    expect(zuzyteDzis()).toBe(1);

    const drugie = await zaplanujTrase({ dokad: "centrum" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((drugie as { error: string }).error).toContain("limit");
  });

  it("blad Google liczy sie do limitu — inaczej petla modelu bije bez konca", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "PERMISSION_DENIED" })
    );

    const wynik = await zaplanujTrase({ dokad: "centrum" });

    expect(zuzyteDzis()).toBe(1);
    expect((wynik as { error: string }).error).toContain("403");
  });

  it("brak polaczenia mowi wprost zamiast zmyslac linie", async () => {
    odpowiedzOk({ routes: [] });
    const wynik = await zaplanujTrase({ dokad: "centrum" });
    expect((wynik as { error: string }).error).toContain("nie znalazl polaczenia");
  });

  it("bez adresu domu i bez 'skad' pyta uzytkownika", async () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ centrum: "Rynek, Wroclaw" });
    zapomnijUstawienia();
    const fetchMock = odpowiedzOk();

    const wynik = await zaplanujTrase({ dokad: "centrum" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((wynik as { error: string }).error).toContain("skad");
  });

  it("siec padla — blad wraca jako tekst, nie wyjatek", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
    const wynik = await zaplanujTrase({ dokad: "centrum" });
    expect((wynik as { error: string }).error).toContain("ETIMEDOUT");
  });
});
