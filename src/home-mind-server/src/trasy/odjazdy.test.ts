import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  godzinyZeStrony,
  najblizsze,
  naTekst,
  rodzajDnia,
  slupkiLinii,
  sprawdzOdjazdy,
  zapomnijOdjazdy,
} from "./odjazdy.js";

/**
 * Wycinek strony linii - w prawdziwej jest kilkaset takich odnosnikow, po dwa na
 * kazdy przystanek (jeden na strone). Slug niesie komplet: przystanek, kierunek
 * i numer slupka.
 */
const STRONA_LINII = `
<a href="/komunikacja/przystanek-baltycka-linia-111-kierunek-kminkowa-slupek-23143">Bałtycka</a>
<a href="/komunikacja/przystanek-waniliowa-linia-111-kierunek-osiedle-sobieskiego-slupek-23562">Waniliowa</a>
<a href="/komunikacja/przystanek-waniliowa-linia-111-kierunek-kminkowa-slupek-23561">Waniliowa</a>
<a href="/komunikacja/przystanek-waniliowa-linia-142-kierunek-jarnoltow-slupek-99999">Waniliowa</a>
`;

/**
 * Uklad prawdziwej strony przystanku: trzy rozklady po kolei, godziny opisane
 * slowami dla czytnikow ekranu. Sobota chodzi rzadziej niz dzien roboczy -
 * dlatego wlasnie sekcje trzeba rozroznic.
 */
const STRONA_PRZYSTANKU = `
<script>var reklama = "16:00";</script>
<div>W dni robocze Sobota Niedziela</div>
<h2>Rozkład jazdy - W dni robocze</h2>
<span>Godzina odjazdu 16</span>
<span>Odjazd 14 minut po godzinie 16</span>
<span>Odjazd 29 minut po godzinie 16</span>
<span>Odjazd 42 minut po godzinie 16</span>
<span>Godzina odjazdu 17</span>
<span>Odjazd 13 minut po godzinie 17</span>
<h2>Rozkład jazdy - Sobota</h2>
<span>Godzina odjazdu 16</span>
<span>Odjazd 08 minut po godzinie 16</span>
<span>Odjazd 38 minut po godzinie 16</span>
<h2>Rozkład jazdy - Niedziela</h2>
<span>Godzina odjazdu 16</span>
<span>Odjazd 08 minut po godzinie 16</span>
`;

describe("czytanie strony rozkladu", () => {
  it("skrypty wypadaja przed tagami, zeby godziny z reklam nie weszly do rozkladu", () => {
    const tekst = naTekst(STRONA_PRZYSTANKU);
    expect(tekst).not.toContain("reklama");
    expect(tekst).toContain("Rozkład jazdy - W dni robocze");
  });

  it("slupki linii wyluskane razem z kierunkiem, bez powtorzen i bez cudzych linii", () => {
    const slupki = slupkiLinii(STRONA_LINII, "111");
    expect(slupki).toHaveLength(3);
    expect(slupki.map((s) => s.kierunek)).toEqual([
      "kminkowa",
      "osiedle-sobieskiego",
      "kminkowa",
    ]);
    expect(slupki.every((s) => s.sciezka.startsWith("https://www.wroclaw.pl/komunikacja/"))).toBe(
      true
    );
    // Linia 142 stoi na tym samym przystanku i nie ma jej tu byc.
    expect(slupki.some((s) => s.sciezka.includes("linia-142"))).toBe(false);
  });

  it("rodzaj dnia wybiera sie po strefie domu, nie po strefie serwera", () => {
    // Niedziela 23:30 w Warszawie to jeszcze niedziela, choc w UTC juz 21:30.
    expect(rodzajDnia(new Date("2026-08-16T21:30:00Z"), "Europe/Warsaw")).toBe("Niedziela");
    // Poniedzialek 00:30 w Warszawie - w UTC nadal niedziela.
    expect(rodzajDnia(new Date("2026-08-16T22:30:00Z"), "Europe/Warsaw")).toBe("W dni robocze");
    expect(rodzajDnia(new Date("2026-08-15T10:00:00Z"), "Europe/Warsaw")).toBe("Sobota");
  });

  // Pomylka sekcji daje godzine kursu, ktory dzisiaj nie jedzie - gorzej niz
  // brak odpowiedzi, bo brzmi tak samo pewnie.
  it("kazdy rodzaj dnia czyta swoje godziny", () => {
    const tekst = naTekst(STRONA_PRZYSTANKU);
    expect(godzinyZeStrony(tekst, "W dni robocze")).toEqual([
      "16:14",
      "16:29",
      "16:42",
      "17:13",
    ]);
    expect(godzinyZeStrony(tekst, "Sobota")).toEqual(["16:08", "16:38"]);
    expect(godzinyZeStrony(tekst, "Niedziela")).toEqual(["16:08"]);
  });

  it("brak sekcji nie wywraca odczytu", () => {
    expect(godzinyZeStrony("cokolwiek", "Sobota")).toEqual([]);
  });

  it("najblizsze liczy sie od zegara w domu", () => {
    const godziny = ["16:14", "16:29", "16:42", "17:13"];
    // 14:30 UTC = 16:30 w Warszawie.
    const teraz = new Date("2026-08-13T14:30:00Z");
    expect(najblizsze(godziny, teraz, "Europe/Warsaw", 3)).toEqual(["16:42", "17:13"]);
    expect(najblizsze(godziny, teraz, "Europe/Warsaw", 1)).toEqual(["16:42"]);
  });
});

describe("sprawdzOdjazdy", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Warsaw";
    process.env.TRASY_PRZYSTANEK_DOMYSLNY = "Waniliowa";
    zapomnijOdjazdy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRASY_PRZYSTANEK_DOMYSLNY;
  });

  function strony() {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (url.includes("linia-111-wroclaw") ? STRONA_LINII : STRONA_PRZYSTANKU),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const teraz = new Date("2026-08-13T14:30:00Z"); // czwartek 16:30 w Warszawie

  it("bez przystanku bierze ten pod domem i oddaje obie strony z kierunkiem", async () => {
    strony();

    const wynik = await sprawdzOdjazdy({ linia: "111" }, teraz);

    expect(wynik).toMatchObject({ linia: "111", przystanek: "Waniliowa", dzien: "W dni robocze" });
    const kierunki = (wynik as { kierunki: { kierunek: string; najblizsze: string[] }[] }).kierunki;
    expect(kierunki).toHaveLength(2);
    expect(kierunki.map((k) => k.kierunek)).toEqual(["osiedle sobieskiego", "kminkowa"]);
    expect(kierunki[0].najblizsze).toEqual(["16:42", "17:13"]);
  });

  it("nazwany kierunek zaweza do jednej strony", async () => {
    strony();

    const wynik = await sprawdzOdjazdy({ linia: "111", kierunek: "Osiedle Sobieskiego" }, teraz);

    const kierunki = (wynik as { kierunki: { kierunek: string }[] }).kierunki;
    expect(kierunki).toHaveLength(1);
    expect(kierunki[0].kierunek).toBe("osiedle sobieskiego");
  });

  it("przystanek spoza trasy linii to odmowa, a nie zgadywanie", async () => {
    strony();

    const wynik = await sprawdzOdjazdy({ linia: "111", przystanek: "Rynek" }, teraz);

    expect(wynik).toHaveProperty("error");
    expect((wynik as { error: string }).error).toContain("nie zatrzymuje sie");
  });

  it("numer linii musi byc numerem - inaczej nie dzwonimy nigdzie", async () => {
    const fetchMock = strony();

    const wynik = await sprawdzOdjazdy({ linia: "jakis autobus" }, teraz);

    expect(wynik).toHaveProperty("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strona pobierana raz - rozklad zmienia sie rzadziej niz pada pytanie", async () => {
    const fetchMock = strony();

    await sprawdzOdjazdy({ linia: "111" }, teraz);
    const poPierwszym = fetchMock.mock.calls.length;
    await sprawdzOdjazdy({ linia: "111" }, teraz);

    expect(fetchMock.mock.calls.length).toBe(poPierwszym);
  });

  it("po ostatnim kursie mowi wprost, ze juz nic nie jedzie", async () => {
    strony();

    const wynik = await sprawdzOdjazdy({ linia: "111" }, new Date("2026-08-13T21:00:00Z"));

    const kierunki = (wynik as { kierunki: { najblizsze: string[]; uwaga?: string }[] }).kierunki;
    expect(kierunki[0].najblizsze).toEqual([]);
    expect(kierunki[0].uwaga).toContain("juz nic nie odjezdza");
  });
});
