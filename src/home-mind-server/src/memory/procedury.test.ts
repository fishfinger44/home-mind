import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rozbierzOdpowiedz, szukajProcedury, zbudujWsad } from "./procedury.js";
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
  it("zawiera wypowiedz, odpowiedz i argumenty wywolan", () => {
    const wsad = zbudujWsad("Zamknij do końca lewą roletę", "Zamknąłem.", ZAMKNIJ);
    expect(wsad).toContain("Zamknij do końca lewą roletę");
    expect(wsad).toContain("Zamknąłem.");
    expect(wsad).toContain("cover.set_cover_position");
    expect(wsad).toContain('"position":0');
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
