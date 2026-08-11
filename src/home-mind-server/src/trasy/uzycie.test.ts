import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  limitDzienny,
  limitWyczerpany,
  policzWywolanie,
  zapomnijUzycie,
  zuzyteDzis,
} from "./uzycie.js";

describe("dzienny licznik tras", () => {
  let plik: string;

  beforeEach(() => {
    plik = join(mkdtempSync(join(tmpdir(), "trasy-")), "uzycie.json");
    process.env.TRASY_UZYCIE_PATH = plik;
    delete process.env.TRASY_LIMIT_DZIENNY;
    zapomnijUzycie();
  });

  afterEach(() => {
    delete process.env.TRASY_UZYCIE_PATH;
    delete process.env.TRASY_LIMIT_DZIENNY;
  });

  it("zaczyna od zera", () => {
    expect(zuzyteDzis()).toBe(0);
    expect(limitWyczerpany()).toBe(false);
  });

  it("liczy i zapisuje na dysk", () => {
    policzWywolanie();
    policzWywolanie();
    expect(zuzyteDzis()).toBe(2);

    zapomnijUzycie(); // jak po restarcie kontenera
    expect(zuzyteDzis()).toBe(2);
    expect(JSON.parse(readFileSync(plik, "utf8")).liczba).toBe(2);
  });

  it("blokuje po osiagnieciu limitu", () => {
    process.env.TRASY_LIMIT_DZIENNY = "2";
    policzWywolanie();
    expect(limitWyczerpany()).toBe(false);
    policzWywolanie();
    expect(limitWyczerpany()).toBe(true);
  });

  it("licznik z wczoraj nie obciaza dzisiaj", () => {
    writeFileSync(plik, JSON.stringify({ dzien: "2000-01-01", liczba: 999 }));
    zapomnijUzycie();
    expect(zuzyteDzis()).toBe(0);
  });

  it("uszkodzony plik nie wywraca liczenia", () => {
    writeFileSync(plik, "{{{");
    zapomnijUzycie();
    expect(zuzyteDzis()).toBe(0);
    policzWywolanie();
    expect(zuzyteDzis()).toBe(1);
  });

  it("limit 0 wylacza narzedzie", () => {
    process.env.TRASY_LIMIT_DZIENNY = "0";
    expect(limitDzienny()).toBe(0);
    expect(limitWyczerpany()).toBe(true);
  });
});
