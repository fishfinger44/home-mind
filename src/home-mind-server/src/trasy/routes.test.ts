import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

import { createTrasyRouter } from "./routes.js";
import { zapiszUstawienia, zapomnijUstawienia } from "./ustawienia.js";
import { zapomnijUzycie, zuzyteDzis } from "./uzycie.js";

let serwer: Server;
let adres: string;

interface StanPanelu {
  maKlucz: boolean;
  zrodloKlucza: string;
  miejsca: Record<string, string>;
  limitDzienny: number;
  ileWariantow: number;
  zuzyteDzis: number;
  zostaloDzis: number;
  maDom: boolean;
}

interface OdpowiedzProby {
  wynik: { error?: string };
  stan: StanPanelu;
}

async function wyslij<T>(sciezka: string, opcje?: RequestInit): Promise<{ status: number; dane: T }> {
  const odp = await fetch(adres + sciezka, opcje);
  return { status: odp.status, dane: (await odp.json()) as T };
}

describe("API panelu tras", () => {
  beforeEach(async () => {
    const katalog = mkdtempSync(join(tmpdir(), "trasy-api-"));
    process.env.TRASY_CONFIG_PATH = join(katalog, "config.json");
    process.env.TRASY_UZYCIE_PATH = join(katalog, "uzycie.json");
    delete process.env.GOOGLE_ROUTES_API_KEY;
    delete process.env.TRASY_MIEJSCA;
    delete process.env.TRASY_LIMIT_DZIENNY;
    zapomnijUstawienia();
    zapomnijUzycie();

    const app = express();
    app.use(express.json());
    app.use("/api", createTrasyRouter());
    await new Promise<void>((gotowe) => {
      serwer = app.listen(0, () => gotowe());
    });
    adres = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
    delete process.env.TRASY_CONFIG_PATH;
    delete process.env.TRASY_UZYCIE_PATH;
    delete process.env.GOOGLE_ROUTES_API_KEY;
  });

  it("odczyt NIGDY nie oddaje klucza — tylko to, czy jakis jest", async () => {
    zapiszUstawienia({ klucz: "sekretny-klucz" });

    const { dane } = await wyslij<StanPanelu>("/api/trasy");

    expect(JSON.stringify(dane)).not.toContain("sekretny-klucz");
    expect(dane.maKlucz).toBe(true);
    expect(dane.zrodloKlucza).toBe("panel");
  });

  it("zapis miejsc i limitow wraca w odczycie", async () => {
    const { status, dane } = await wyslij<StanPanelu>("/api/trasy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        miejsca: { dom: "Bakaliowa, Wroclaw", praca: "Legnicka 51" },
        limitDzienny: 25,
        ileWariantow: 2,
      }),
    });

    expect(status).toBe(200);
    expect(dane.miejsca).toEqual({ dom: "Bakaliowa, Wroclaw", praca: "Legnicka 51" });
    expect(dane.limitDzienny).toBe(25);
    expect(dane.ileWariantow).toBe(2);
    expect(dane.maDom).toBe(true);
    expect(dane.zostaloDzis).toBe(25);
  });

  it("brak wpisu 'dom' jest widoczny w stanie — bez niego asystent musi dopytywac", async () => {
    const { dane } = await wyslij<StanPanelu>("/api/trasy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ miejsca: { praca: "Legnicka 51" } }),
    });
    expect(dane.maDom).toBe(false);
  });

  it("odrzuca bzdurne wartosci zamiast je zapisac", async () => {
    const { status } = await wyslij<StanPanelu>("/api/trasy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitDzienny: -5 }),
    });
    expect(status).toBe(400);
  });

  it("proba bez 'dokad' to blad zapytania, nie wywolanie Google", async () => {
    const { status } = await wyslij<OdpowiedzProby>("/api/trasy/sprawdz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(zuzyteDzis()).toBe(0);
  });

  it("proba bez klucza nie zjada limitu", async () => {
    const { dane } = await wyslij<OdpowiedzProby>("/api/trasy/sprawdz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dokad: "centrum" }),
    });

    expect(dane.wynik.error).toContain("klucza do Routes API");
    expect(dane.stan.zuzyteDzis).toBe(0);
  });
});
