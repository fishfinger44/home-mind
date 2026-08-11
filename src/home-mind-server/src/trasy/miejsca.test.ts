import { describe, it, expect, beforeEach } from "vitest";
import { adresDomu, adresMiejsca, znaneMiejsca } from "./miejsca.js";
import { zapomnijUstawienia } from "./ustawienia.js";

describe("miejsca", () => {
  beforeEach(() => {
    zapomnijUstawienia();
    delete process.env.TRASY_MIEJSCA;
    process.env.TRASY_CONFIG_PATH = "/nie/ma/takiego/pliku.json";
  });

  it("bez konfiguracji nie zna domu", () => {
    expect(adresDomu()).toBeUndefined();
    expect(znaneMiejsca()).toEqual([]);
  });

  it("podaje adres domu", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Waniliowa 1, Wroclaw" });
    expect(adresDomu()).toBe("Waniliowa 1, Wroclaw");
  });

  it("dopasowuje skrot mimo ogonkow i wielkich liter", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ "Praca Lecha": "Legnicka 51, Wroclaw" });
    expect(adresMiejsca("praca lecha")).toBe("Legnicka 51, Wroclaw");
    expect(adresMiejsca("PRACA LECHA")).toBe("Legnicka 51, Wroclaw");
  });

  it("nieznana nazwa idzie dalej do Google jako adres", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Waniliowa 1" });
    expect(adresMiejsca("Rynek 4, Wroclaw")).toBe("Rynek 4, Wroclaw");
  });

  it("zly JSON nie wywraca niczego", () => {
    process.env.TRASY_MIEJSCA = "{to nie jest json";
    expect(adresDomu()).toBeUndefined();
    expect(adresMiejsca("centrum")).toBe("centrum");
  });

  it("pusty adres jest pomijany", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "   ", praca: "Legnicka 51" });
    expect(adresDomu()).toBeUndefined();
    expect(adresMiejsca("praca")).toBe("Legnicka 51");
  });

  it("zmiana konfiguracji jest widziana bez restartu", () => {
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Stary adres" });
    expect(adresDomu()).toBe("Stary adres");
    process.env.TRASY_MIEJSCA = JSON.stringify({ dom: "Nowy adres" });
    expect(adresDomu()).toBe("Nowy adres");
  });
});
