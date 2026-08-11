import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  adresDozwolony,
  rozbierzListe,
  rozbierzWpis,
  znormalizujAdres,
  utworzBramkeAdresow,
} from "./dozwolone-adresy.js";

/**
 * Bramka adresowa API.
 *
 * Powstała, bo `API_TOKEN` jest pusty, a `identityConfidence` przy
 * `POST /api/chat` przychodzi od wołającego — czyli zwykły `curl` z LAN-u umiał
 * kazać asystentowi czytać cudzą pamięć. Testujemy tu dwie rzeczy, na których
 * najłatwiej się przejechać: postać adresu, w jakiej Node oddaje klienta
 * (`::ffff:` przy gnieździe IPv6), i to, że zły wpis w liście NIE jest po cichu
 * pomijany — lista, która dopuszcza mniej, niż widać w konfiguracji, zamyka
 * pulpity bez śladu.
 */

const LISTA = "127.0.0.1,::1,192.168.88.0/24,172.16.0.0/12,100.64.0.0/10";

describe("normalizacja adresu z gniazda", () => {
  it("zdejmuje przedrostek IPv4-w-IPv6, bo w takiej postaci Node oddaje klienta IPv4", () => {
    expect(znormalizujAdres("::ffff:192.168.88.10")).toBe("192.168.88.10");
  });

  it("zdejmuje strefę interfejsu", () => {
    expect(znormalizujAdres("fe80::1%eth0")).toBe("fe80::1");
  });

  it("zostawia zwykły adres w spokoju", () => {
    expect(znormalizujAdres("192.168.88.227")).toBe("192.168.88.227");
  });
});

describe("rozbieranie wpisu", () => {
  it("przyjmuje pojedynczy adres, sieć z maską i literał IPv6", () => {
    expect(rozbierzWpis("192.168.88.227")).not.toBeNull();
    expect(rozbierzWpis("10.0.0.0/8")).not.toBeNull();
    expect(rozbierzWpis("::1")).not.toBeNull();
  });

  it("zeruje bity poza maską, żeby 192.168.88.5/24 znaczyło całą podsieć", () => {
    expect(adresDozwolony("192.168.88.99", rozbierzListe("192.168.88.5/24"))).toBe(true);
  });

  it("odrzuca bzdury zamiast udawać, że rozumie", () => {
    expect(rozbierzWpis("192.168.88.300")).toBeNull();
    expect(rozbierzWpis("192.168.88.0/33")).toBeNull();
    expect(rozbierzWpis("komputer-lecha")).toBeNull();
    expect(rozbierzWpis("")).toBeNull();
  });

  it("cała lista wybucha na złym wpisie — cichy brak byłby gorszy niż awaria", () => {
    expect(() => rozbierzListe("127.0.0.1,192.168.88.999")).toThrow(/192\.168\.88\.999/);
  });

  it("puste kawałki listy (spacje, przecinek na końcu) nie są błędem", () => {
    expect(rozbierzListe("127.0.0.1, ::1, ")).toHaveLength(2);
  });
});

describe("dopasowanie adresu", () => {
  const wpisy = rozbierzListe(LISTA);

  it("przepuszcza dom, loopback, Dockera i tailnet", () => {
    expect(adresDozwolony("127.0.0.1", wpisy)).toBe(true);
    expect(adresDozwolony("::1", wpisy)).toBe(true);
    expect(adresDozwolony("192.168.88.227", wpisy)).toBe(true); // HA
    expect(adresDozwolony("::ffff:192.168.88.150", wpisy)).toBe(true); // przeglądarka
    expect(adresDozwolony("172.19.0.2", wpisy)).toBe(true); // kontener
    expect(adresDozwolony("100.103.108.121", wpisy)).toBe(true); // Tailscale
  });

  it("odrzuca sąsiednią podsieć i adres z internetu", () => {
    expect(adresDozwolony("192.168.89.10", wpisy)).toBe(false);
    expect(adresDozwolony("192.168.122.5", wpisy)).toBe(false); // virbr0, maszyny wirtualne
    expect(adresDozwolony("8.8.8.8", wpisy)).toBe(false);
    expect(adresDozwolony("fe80::1", wpisy)).toBe(false);
  });
});

describe("middleware", () => {
  const zapytanie = (adres: string | undefined, sciezka = "/memory/lech") =>
    ({
      path: sciezka,
      method: "GET",
      originalUrl: "/api" + sciezka,
      socket: { remoteAddress: adres },
    }) as unknown as Request;

  const odpowiedz = () => {
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };
    return res as unknown as Response & { status: ReturnType<typeof vi.fn> };
  };

  it("pusta lista przepuszcza wszystko — zamknięcie API jest decyzją konfiguracji", () => {
    const next = vi.fn();
    utworzBramkeAdresow(undefined)(zapytanie("8.8.8.8"), odpowiedz(), next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it("adres z listy przechodzi", () => {
    const next = vi.fn();
    utworzBramkeAdresow(LISTA)(
      zapytanie("::ffff:192.168.88.150"),
      odpowiedz(),
      next as NextFunction
    );
    expect(next).toHaveBeenCalled();
  });

  it("adres spoza listy dostaje 403 i nie idzie dalej", () => {
    const next = vi.fn();
    const res = odpowiedz();
    const cisza = vi.spyOn(console, "warn").mockImplementation(() => {});
    utworzBramkeAdresow(LISTA)(zapytanie("192.168.89.10"), res, next as NextFunction);
    cisza.mockRestore();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("/health zostaje publiczne, bo po nim poznaje się, czy usługa żyje", () => {
    const next = vi.fn();
    utworzBramkeAdresow(LISTA)(zapytanie("8.8.8.8", "/health"), odpowiedz(), next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it("gniazdo bez adresu jest odrzucane, a nie przepuszczane z dobrej wiary", () => {
    const next = vi.fn();
    const res = odpowiedz();
    const cisza = vi.spyOn(console, "warn").mockImplementation(() => {});
    utworzBramkeAdresow(LISTA)(zapytanie(undefined), res, next as NextFunction);
    cisza.mockRestore();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
