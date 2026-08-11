import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  rozbierzOdpowiedz,
  rozbierzWieleOdpowiedzi,
  szukajProcedury,
  szukajProceduryWsadowo,
  czyPokryta,
  zbudujWsad,
  zbudujWsadNocny,
} from "./procedury.js";
import { loadRules, resetRulesCache, saveRules } from "../rules/store.js";
import type { IFactExtractor } from "../llm/interface.js";

function ekstraktor(odpowiedz: string | Error) {
  return {
    extract: vi.fn(async () => []),
    zapytaj: vi.fn(async () => {
      if (odpowiedz instanceof Error) throw odpowiedz;
      return odpowiedz;
    }),
  } as unknown as IFactExtractor & { zapytaj: ReturnType<typeof vi.fn> };
}

/** Ekstraktor oddajacy kolejne odpowiedzi po kolei — wsad, potem sprawdzenia. */
function kolejneOdpowiedzi(odpowiedzi: string[]) {
  let i = 0;
  return {
    extract: vi.fn(async () => []),
    zapytaj: vi.fn(async () => odpowiedzi[Math.min(i++, odpowiedzi.length - 1)]),
  } as unknown as IFactExtractor & { zapytaj: ReturnType<typeof vi.fn> };
}

const ZAMKNIJ = [{ nazwa: "call_service", argumenty: { service: "cover.set_cover_position", position: 0 } }];

describe("rozbior odpowiedzi modelu", () => {
  it("czyta tytul i tresc rozdzielone kreska", () => {
    expect(rozbierzOdpowiedz("Rolety — do końca | „Do końca\" znaczy pozycja 0, nie 10.")).toEqual({
      tytul: "Rolety — do końca",
      tresc: "„Do końca\" znaczy pozycja 0, nie 10.",
    });
  });

  it("zwraca null dla BRAK", () => {
    expect(rozbierzOdpowiedz("BRAK")).toBeNull();
    expect(rozbierzOdpowiedz("  brak  ")).toBeNull();
  });

  // Cokolwiek stad wyjdzie, ladauje na liscie regul domowych — wiec model,
  // ktory przestal trzymac sie formatu, ma byc odrzucony, a nie zgadywany.
  it("odrzuca odpowiedz bez separatora i zbyt krotka", () => {
    expect(rozbierzOdpowiedz("Nie jestem pewien, ale chyba chodzi o rolety")).toBeNull();
    expect(rozbierzOdpowiedz("Tytuł | krótkie")).toBeNull();
    expect(rozbierzOdpowiedz("")).toBeNull();
    expect(rozbierzOdpowiedz(" | Reguła bez tytułu, dość długa")).toBeNull();
  });

  it("bierze tylko pierwsza linie", () => {
    expect(rozbierzOdpowiedz("Tytuł | Reguła wystarczająco długa\nA potem gadanie")?.tresc).toBe(
      "Reguła wystarczająco długa"
    );
  });
});

describe("wsad dla modelu", () => {
  let katalog: string;

  // Wsad czyta obowiazujace reguly, wiec musi je czytac z katalogu tymczasowego,
  // a nie z /data prawdziwego domu.
  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), "wsad-"));
    process.env.RULES_PATH = join(katalog, "rules.json");
    resetRulesCache();
  });

  afterEach(() => {
    delete process.env.RULES_PATH;
    resetRulesCache();
    rmSync(katalog, { recursive: true, force: true });
  });

  it("zawiera wypowiedz, odpowiedz i argumenty wywolan", () => {
    const wsad = zbudujWsad("Zamknij do końca lewą roletę", "Zamknąłem.", ZAMKNIJ);
    expect(wsad).toContain("Zamknij do końca lewą roletę");
    expect(wsad).toContain("Zamknąłem.");
    expect(wsad).toContain("cover.set_cover_position");
    expect(wsad).toContain('"position":0');
  });

  it("pokazuje modelowi obowiazujace reguly, zeby ich nie powtarzal", () => {
    // Trzy pierwsze propozycje automatu byly powtorzeniami juz napisanych regul,
    // bo przebieg ich nie widzial i nie mial jak tego stwierdzic.
    saveRules([
      { id: "r04", title: "Muzyka", text: "MUZYKA — wyłącznie przez script.zagraj_muzyke. " + "x".repeat(400), enabled: true, protected: false, suggested: false },
      { id: "rX", title: "Wyłączona", text: "Tej nie ma w promptcie.", enabled: false, protected: false, suggested: false },
    ]);

    const wsad = zbudujWsad("Zagraj muzykę", "Gra.", ZAMKNIJ);

    expect(wsad).toContain("[Muzyka]");
    expect(wsad).toContain("script.zagraj_muzyke");
    // Wyłączona regula nie obowiazuje, wiec nie ma powodu jej pokazywac.
    expect(wsad).not.toContain("Tej nie ma w promptcie");
  });

  it("pokazuje regule W CALOSCI, takze to co stoi daleko w tresci", () => {
    // Regresja z zywego przebiegu: przycinanie do 140 znakow ukrylo fragment
    // „zamknij = 0" stojacy na 356. znaku r03, wiec automat zaproponowal go
    // ponownie jako nowa regule.
    const dlugaRegula =
      "WARTOŚĆ, NIE STAN. " + "wypełniacz ".repeat(30) + "Rolety: „zamknij” = pozycja 0.";
    saveRules([
      { id: "r03", title: "Wartość, nie stan", text: dlugaRegula, enabled: true, protected: false, suggested: false },
    ]);

    const wsad = zbudujWsad("Zamknij do końca roletę", "Zamknąłem.", ZAMKNIJ);

    expect(dlugaRegula.indexOf("zamknij")).toBeGreaterThan(300);
    expect(wsad).toContain("„zamknij” = pozycja 0.");
  });

  it("nie ucina bloku regul przy realnej wielkosci domu", () => {
    // Sufit 6000 znakow byl o 332 za niski: blok wazyl 6332, a ucinalo od
    // reguly 13 — czyli od OSTATNIO DOPISANEJ, ktora model zaproponowal
    // ponownie tej samej nocy.
    saveRules(
      Array.from({ length: 13 }, (_, i) => ({
        id: `r${i}`,
        title: `Reguła ${i}`,
        text: "x".repeat(480) + (i === 12 ? " NAJNOWSZA-REGUŁA" : ""),
        enabled: true,
        protected: false,
        suggested: false,
      }))
    );

    const wsad = zbudujWsad("Zamknij roletę", "Zamknąłem.", ZAMKNIJ);

    expect(wsad).toContain("NAJNOWSZA-REGUŁA");
    expect(wsad).not.toContain("dalsze reguły pominięte");
  });

  it("radzi sobie, gdy nie ma jeszcze zadnej reguly", () => {
    saveRules([]);
    expect(zbudujWsad("x", "y", ZAMKNIJ)).toContain("(brak reguł)");
  });

  it("przycina wielkie argumenty — to ma byc tani przebieg", () => {
    const wsad = zbudujWsad("x", "y", [
      { nazwa: "call_service", argumenty: { lista: "e".repeat(5000) } },
    ]);
    expect(wsad).toContain("…(ucięte)");
    expect(wsad.length).toBeLessThan(3000);
  });
});

describe("szukanie procedury w odrzuconej turze", () => {
  let katalog: string;

  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), "procedury-"));
    process.env.RULES_PATH = join(katalog, "rules.json");
    resetRulesCache();
  });

  afterEach(() => {
    delete process.env.RULES_PATH;
    resetRulesCache();
    rmSync(katalog, { recursive: true, force: true });
  });

  it("zapisuje regule WYLACZONA i oznaczona jako sugestia", async () => {
    const e = ekstraktor('Rolety — do końca | „Do końca" znaczy pozycja 0.');

    expect(await szukajProcedury(e, "Zamknij do końca lewą roletę", "Zamknąłem.", ZAMKNIJ)).toBe(
      "Rolety — do końca"
    );
    expect(loadRules()[0]).toMatchObject({
      title: "Rolety — do końca",
      enabled: false,
      suggested: true,
    });
  });

  it("nie wola modelu, gdy tura niczego nie zmienila", async () => {
    // Sam odczyt nie ma procedury do opisania — i to jest caly prog kosztowy.
    const e = ekstraktor("cokolwiek | cokolwiek długiego");
    const czysteOdczyty = [{ nazwa: "get_state", argumenty: { entity_id: "sensor.x" } }];

    expect(await szukajProcedury(e, "Jaka jest temperatura?", "19 stopni.", czysteOdczyty)).toBeNull();
    expect(e.zapytaj).not.toHaveBeenCalled();
    expect(loadRules()).toHaveLength(0);
  });

  it("nie wola modelu, gdy nie bylo zadnych wywolan", async () => {
    const e = ekstraktor("cokolwiek | cokolwiek długiego");
    expect(await szukajProcedury(e, "Cześć", "Cześć.", [])).toBeNull();
    expect(e.zapytaj).not.toHaveBeenCalled();
  });

  it("na BRAK nie zapisuje niczego", async () => {
    const e = ekstraktor("BRAK");
    expect(await szukajProcedury(e, "Zapal światło", "Zapaliłem.", ZAMKNIJ)).toBeNull();
    expect(loadRules()).toHaveLength(0);
  });

  it("nie dubluje reguly o tej samej tresci", async () => {
    saveRules([
      { id: "r1", title: "Jest", text: "Do końca znaczy pozycja 0.", enabled: true, protected: false, suggested: false },
    ]);
    const e = ekstraktor("Rolety | Do końca znaczy pozycja 0.");

    expect(await szukajProcedury(e, "Zamknij", "Zamknąłem.", ZAMKNIJ)).toBeNull();
    expect(loadRules()).toHaveLength(1);
  });

  // Ten przebieg chodzi za bramka, w sciezce „odpal i zapomnij". Awaria ma
  // kosztowac jedna przeoczona propozycje, nigdy ture domownika.
  it("nie rzuca, gdy model padnie", async () => {
    const e = ekstraktor(new Error("model padl"));
    await expect(szukajProcedury(e, "Zamknij", "Zamknąłem.", ZAMKNIJ)).resolves.toBeNull();
  });

  it("milczy, gdy ekstraktor nie umie odpowiadac na pytania", async () => {
    const bezZapytaj = { extract: vi.fn(async () => []) } as unknown as IFactExtractor;
    await expect(szukajProcedury(bezZapytaj, "Zamknij", "Zamknąłem.", ZAMKNIJ)).resolves.toBeNull();
  });
});

describe("nocny przeglad calej doby", () => {
  let katalog: string;

  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), "nocny-"));
    process.env.RULES_PATH = join(katalog, "rules.json");
    resetRulesCache();
  });

  afterEach(() => {
    delete process.env.RULES_PATH;
    resetRulesCache();
    rmSync(katalog, { recursive: true, force: true });
  });

  const TURY = [
    { tresc: "Zamknij roletę", odpowiedz: "Zamknąłem.", wywolania: ZAMKNIJ },
    { tresc: "Zatrzymaj muzykę", odpowiedz: "Stop.", wywolania: [{ nazwa: "call_service", argumenty: { service: "media_stop" } }] },
  ];

  it("sklada wszystkie tury w jeden wsad i zacheca do szukania powtorzen", () => {
    const wsad = zbudujWsadNocny(TURY);
    expect(wsad).toContain("Zamknij roletę");
    expect(wsad).toContain("Zatrzymaj muzykę");
    expect(wsad).toContain("POWTARZA SIĘ");
  });

  it("pomija tury bez wywolan zmieniajacych stan", () => {
    const wsad = zbudujWsadNocny([
      ...TURY,
      { tresc: "Jaka temperatura?", odpowiedz: "19.", wywolania: [{ nazwa: "get_state", argumenty: {} }] },
    ]);
    expect(wsad).not.toContain("Jaka temperatura?");
  });

  it("czyta wiele regul z odpowiedzi, ale nie wiecej niz sufit", () => {
    const wiele = Array.from({ length: 9 }, (_, i) => `Tytuł ${i} | Reguła numer ${i} wystarczająco długa`).join("\n");
    expect(rozbierzWieleOdpowiedzi(wiele).length).toBe(5);
  });

  it("na BRAK nie zapisuje niczego", async () => {
    const e = ekstraktor("BRAK");
    expect(await szukajProceduryWsadowo(e, TURY)).toEqual([]);
    expect(loadRules()).toHaveLength(0);
  });

  it("zapisuje kilka regul naraz, wszystkie wylaczone", async () => {
    // Pierwsza odpowiedz to lista propozycji, kolejne to sprawdzenia powtorzen.
    const e = kolejneOdpowiedzi([
      "Rolety | Zamykaj do pozycji 0.\nMuzyka | Zatrzymuj przez media_stop na Denonie.",
      "NIE",
      "NIE",
    ]);

    expect(await szukajProceduryWsadowo(e, TURY)).toEqual(["Rolety", "Muzyka"]);
    expect(loadRules().every((r) => !r.enabled && r.suggested)).toBe(true);
  });

  it("odrzuca propozycje, ktora sprawdzenie uzna za powtorzenie", async () => {
    const e = kolejneOdpowiedzi(["Rolety | Zamykaj do pozycji 0.", "TAK"]);

    expect(await szukajProceduryWsadowo(e, TURY)).toEqual([]);
    expect(loadRules()).toHaveLength(0);
  });

  it("metna odpowiedz liczy sie jako powtorzenie, ale PUSTA nie", async () => {
    const p = { tytul: "X", tresc: "Treść reguły." };
    expect(await czyPokryta(ekstraktor("TAK"), p)).toBe(true);
    expect(await czyPokryta(ekstraktor("Trudno powiedzieć"), p)).toBe(true);
    expect(await czyPokryta(ekstraktor(new Error("padl")), p)).toBe(true);
    expect(await czyPokryta(ekstraktor("NIE"), p)).toBe(false);
    // Pustka to awaria bramki, nie werdykt. Zmierzone: przy ciasnym budzecie
    // tokenow model oddaje "" i bramka odrzucala wszystko, takze rzeczy
    // niepokryte zadna regula — po cichu.
    expect(await czyPokryta(ekstraktor(""), p)).toBe(false);
    expect(await czyPokryta(ekstraktor("   "), p)).toBe(false);
  });

  it("pyta o powtorzenie z budzetem, ktory starczy modelowi na odpowiedz", async () => {
    const e = ekstraktor("NIE");
    await czyPokryta(e, { tytul: "X", tresc: "Treść reguły." });
    expect(e.zapytaj.mock.calls[0][1]).toBeGreaterThanOrEqual(64);
  });

  it("nie wola modelu, gdy doba nie miala zadnej zmiany stanu", async () => {
    const e = ekstraktor("Cokolwiek | cokolwiek długiego");
    const same_odczyty = [{ tresc: "x", wywolania: [{ nazwa: "get_state", argumenty: {} }] }];
    expect(await szukajProceduryWsadowo(e, same_odczyty)).toEqual([]);
    expect(e.zapytaj).not.toHaveBeenCalled();
  });

  it("nie rzuca, gdy model padnie", async () => {
    await expect(szukajProceduryWsadowo(ekstraktor(new Error("padl")), TURY)).resolves.toEqual([]);
  });
});
