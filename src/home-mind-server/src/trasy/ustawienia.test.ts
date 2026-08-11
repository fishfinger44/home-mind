import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ileWariantow,
  kluczApi,
  limitDzienny,
  miejsca,
  zapiszUstawienia,
  zapomnijUstawienia,
  zrodloKlucza,
  zrodloMiejsc,
} from "./ustawienia.js";

describe("ustawienia tras", () => {
  let plik: string;

  beforeEach(() => {
    plik = join(mkdtempSync(join(tmpdir(), "trasy-cfg-")), "trasy-config.json");
    process.env.TRASY_CONFIG_PATH = plik;
    delete process.env.GOOGLE_ROUTES_API_KEY;
    delete process.env.TRASY_MIEJSCA;
    delete process.env.TRASY_LIMIT_DZIENNY;
    delete process.env.TRASY_ILE_WARIANTOW;
    zapomnijUstawienia();
  });

  afterEach(() => {
    delete process.env.TRASY_CONFIG_PATH;
    delete process.env.GOOGLE_ROUTES_API_KEY;
    delete process.env.TRASY_MIEJSCA;
    delete process.env.TRASY_LIMIT_DZIENNY;
    delete process.env.TRASY_ILE_WARIANTOW;
  });

  it("bez niczego: brak klucza, domyslne limity", () => {
    expect(kluczApi()).toBeUndefined();
    expect(zrodloKlucza()).toBe("brak");
    expect(limitDzienny()).toBe(100);
    expect(ileWariantow()).toBe(3);
    expect(miejsca()).toEqual({});
  });

  it("env dziala, dopoki panel niczego nie zapisal", () => {
    process.env.GOOGLE_ROUTES_API_KEY = "z-env";
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Bakaliowa" });
    process.env.TRASY_LIMIT_DZIENNY = "40";

    expect(kluczApi()).toBe("z-env");
    expect(zrodloKlucza()).toBe("env");
    expect(miejsca()).toEqual({ dom: "Bakaliowa" });
    expect(zrodloMiejsc()).toBe("env");
    expect(limitDzienny()).toBe(40);
  });

  it("panel wygrywa z env i przezywa restart", () => {
    process.env.GOOGLE_ROUTES_API_KEY = "z-env";
    zapiszUstawienia({ klucz: "z-panelu", limitDzienny: 7 });

    zapomnijUstawienia(); // jak po restarcie kontenera
    expect(kluczApi()).toBe("z-panelu");
    expect(zrodloKlucza()).toBe("panel");
    expect(limitDzienny()).toBe(7);
    expect(JSON.parse(readFileSync(plik, "utf8")).klucz).toBe("z-panelu");
  });

  it("pusty klucz kasuje nadpisanie i oddaje pierwszenstwo env", () => {
    process.env.GOOGLE_ROUTES_API_KEY = "z-env";
    zapiszUstawienia({ klucz: "z-panelu" });
    zapiszUstawienia({ klucz: "" });

    expect(kluczApi()).toBe("z-env");
    expect(zrodloKlucza()).toBe("env");
    expect(JSON.parse(readFileSync(plik, "utf8")).klucz).toBeUndefined();
  });

  it("miejsca z panelu NADPISUJA env w calosci — inaczej nie da sie skasowac wpisu", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Bakaliowa", praca: "Legnicka" });
    zapiszUstawienia({ miejsca: { dom: "Bakaliowa" } });

    expect(miejsca()).toEqual({ dom: "Bakaliowa" });
    expect(zrodloMiejsc()).toBe("panel");
  });

  it("puste miejsca z panelu wracaja do env", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Bakaliowa" });
    zapiszUstawienia({ miejsca: {} });
    expect(miejsca()).toEqual({ dom: "Bakaliowa" });
    expect(zrodloMiejsc()).toBe("env");
  });

  it("smieci w miejscach sa odsiewane", () => {
    zapiszUstawienia({ miejsca: { dom: "Bakaliowa", "": "bez nazwy", pusty: "   " } });
    expect(miejsca()).toEqual({ dom: "Bakaliowa" });
  });

  it("pominiete pola zostaja bez zmian", () => {
    zapiszUstawienia({ klucz: "k", limitDzienny: 5 });
    zapiszUstawienia({ ileWariantow: 2 });
    expect(kluczApi()).toBe("k");
    expect(limitDzienny()).toBe(5);
    expect(ileWariantow()).toBe(2);
  });

  it("limit 0 przechodzi (wylacza narzedzie), warianty sa przycinane do 1-5", () => {
    zapiszUstawienia({ limitDzienny: 0, ileWariantow: 99 });
    expect(limitDzienny()).toBe(0);
    expect(ileWariantow()).toBe(5);
  });

  it("uszkodzony plik nie wywraca odczytu", () => {
    zapiszUstawienia({ klucz: "k" });
    zapomnijUstawienia();
    writeFileSync(plik, "{{{");
    zapomnijUstawienia();
    expect(kluczApi()).toBeUndefined();
  });
});
