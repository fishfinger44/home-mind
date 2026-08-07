import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zapiszPominiecie } from "./pominiete.js";

let katalog: string;
let plik: string;

beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), "pominiete-"));
  plik = join(katalog, "wpisy.jsonl");
  process.env.SKIPPED_LOG_PATH = plik;
});

afterEach(() => {
  rmSync(katalog, { recursive: true, force: true });
  delete process.env.SKIPPED_LOG_PATH;
});

const czytaj = () =>
  readFileSync(plik, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("trwaly slad po pominietych faktach", () => {
  it("dopisuje wpisy, zachowujac kolejnosc", () => {
    zapiszPominiecie({ rodzaj: "bramka", powod: "wykonanie", tresc: "zgas swiatlo", userId: "lech" });
    zapiszPominiecie({ rodzaj: "filtr", powod: "stan chwilowy", tresc: "swiatlo jest teraz czerwone", userId: "lech" });

    const wpisy = czytaj();
    expect(wpisy).toHaveLength(2);
    expect(wpisy[0].rodzaj).toBe("bramka");
    expect(wpisy[1].tresc).toBe("swiatlo jest teraz czerwone");
    // Bez czasu wpis jest bezuzyteczny przy przegladzie po tygodniu.
    expect(Date.parse(wpisy[0].kiedy)).not.toBeNaN();
  });

  it("zapisuje uzyte narzedzia, bo one uzasadniaja decyzje bramki", () => {
    zapiszPominiecie({
      rodzaj: "bramka",
      powod: "wykonanie polecenia",
      tresc: "otworz rolety",
      userId: "lech",
      narzedzia: ["call_service"],
    });
    expect(czytaj()[0].narzedzia).toEqual(["call_service"]);
  });

  it("nie rzuca, gdy zapis jest niemozliwy", () => {
    // Sciezka przez plik zamiast katalogu = ENOTDIR. Zapis dzieje sie w srodku
    // ekstrakcji, PRZED zapisem faktow — awaria nie moze ich zabrac ze soba.
    writeFileSync(join(katalog, "blokada"), "x", "utf-8");
    process.env.SKIPPED_LOG_PATH = join(katalog, "blokada", "wpisy.jsonl");

    expect(() =>
      zapiszPominiecie({ rodzaj: "bramka", powod: "x", tresc: "y", userId: "lech" })
    ).not.toThrow();
  });

  it("przycina plik, gdy urosnie ponad sufit", () => {
    // Urzadzenie ma chodzic latami — plik bez ograniczenia to usterka
    // czekajaca na swoj dzien.
    const linia = JSON.stringify({ kiedy: "2026-01-01T00:00:00.000Z", rodzaj: "bramka", tresc: "x".repeat(200) });
    writeFileSync(plik, (linia + "\n").repeat(12000), "utf-8");
    const przed = czytaj().length;

    zapiszPominiecie({ rodzaj: "bramka", powod: "nowy", tresc: "najnowszy", userId: "lech" });

    const po = czytaj();
    expect(po.length).toBeLessThan(przed);
    // Przyciecie zostawia mlodsza polowe, wiec najnowszy wpis przezywa.
    expect(po[po.length - 1].tresc).toBe("najnowszy");
  });
});
