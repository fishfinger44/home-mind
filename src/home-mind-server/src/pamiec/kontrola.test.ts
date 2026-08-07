import { describe, it, expect, vi } from "vitest";
import { zbudujWsad, parsujWynik, sprawdzFaktyZRegulami } from "./kontrola.js";
import type { FaktDoKontroli } from "./kontrola.js";
import type { HouseRule } from "../rules/store.js";
import type { IChatEngine } from "../llm/interface.js";

const regula = (title: string, text = "treść reguły"): HouseRule => ({
  id: title, title, text, enabled: true, protected: false, suggested: false,
});
const fakt = (id: string, content: string, userId = "lech"): FaktDoKontroli => ({ id, content, userId });

describe("wsad dla kontroli", () => {
  it("etykietuje fakty F1..Fn i odwzorowuje je z powrotem", () => {
    const { tekst, mapa } = zbudujWsad([regula("Odkurzacz")], [fakt("uuid-a", "aaa"), fakt("uuid-b", "bbb")]);
    expect(tekst).toContain("F1 (profil lech) aaa");
    expect(tekst).toContain("F2 (profil lech) bbb");
    expect(mapa.get("F2")!.id).toBe("uuid-b");
  });

  it("nie wysyla UUID-ow do modelu", () => {
    // Model, ktory ma przepisac UUID, myli w nim znaki — a pomylka znaczy tu
    // wskazanie NIE TEGO faktu do skasowania.
    const { tekst } = zbudujWsad([regula("R")], [fakt("3f2a1b9c-0000-4444-8888-abcdefabcdef", "aaa")]);
    expect(tekst).not.toContain("3f2a1b9c");
  });
});

describe("parsowanie wyniku kontroli", () => {
  const { mapa } = zbudujWsad([regula("R")], [fakt("id1", "pierwszy"), fakt("id2", "drugi", "default")]);

  it("czyta obie kategorie i przypisuje je wlasciwym faktom", () => {
    const z = parsujWynik(
      "SPRZECZNY: F1 ⟷ [Odkurzacz — mapa pomieszczeń] — fakt podaje inny numer segmentu\n" +
      "POKRYTY: F2 ⟷ [Dom — lokalizacja] — to samo, innymi słowami",
      mapa
    );
    expect(z).toHaveLength(2);
    expect(z[0]).toMatchObject({ rodzaj: "sprzeczny", factId: "id1", regula: "Odkurzacz — mapa pomieszczeń" });
    expect(z[0].dlaczego).toBe("fakt podaje inny numer segmentu");
    expect(z[1]).toMatchObject({ rodzaj: "pokryty", factId: "id2", userId: "default" });
  });

  it("odrzuca etykiete, ktorej nie bylo we wsadzie", () => {
    // Halucynacja nie moze wskazac faktu do skasowania — to cicha utrata danych.
    expect(parsujWynik("SPRZECZNY: F9 ⟷ [R] — wymyslone", mapa)).toEqual([]);
  });

  it("zwraca pusto na BRAK i na smieciach", () => {
    expect(parsujWynik("BRAK", mapa)).toEqual([]);
    expect(parsujWynik("Nie znalazłem nic ciekawego.", mapa)).toEqual([]);
  });

  it("wybacza inna strzalke i zwykly myslnik", () => {
    const z = parsujWynik("SPRZECZNY: F1 <-> [Reguła] - powód", mapa);
    expect(z).toHaveLength(1);
    expect(z[0].dlaczego).toBe("powód");
  });

  it("sprzecznosc wygrywa nad powtorzeniem dla tego samego faktu", () => {
    const z = parsujWynik("POKRYTY: F1 ⟷ [A] — powtarza\nSPRZECZNY: F1 ⟷ [B] — kloci sie", mapa);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ rodzaj: "sprzeczny", regula: "B" });
  });

  it("sortuje sprzeczne przed powtorzeniami", () => {
    const z = parsujWynik("POKRYTY: F2 ⟷ [A] — x\nSPRZECZNY: F1 ⟷ [B] — y", mapa);
    expect(z.map((x) => x.rodzaj)).toEqual(["sprzeczny", "pokryty"]);
  });
});

describe("uruchomienie kontroli", () => {
  const llmZ = (odp: string) => ({ chat: vi.fn(async () => ({ response: odp })) }) as unknown as IChatEngine & { chat: ReturnType<typeof vi.fn> };

  it("nie wola modelu, gdy nie ma faktow albo wlaczonych regul", async () => {
    const a = llmZ("BRAK");
    expect(await sprawdzFaktyZRegulami(a, [regula("R")], [])).toEqual({ znaleziska: [], sprawdzono: 0 });
    const b = llmZ("BRAK");
    await sprawdzFaktyZRegulami(b, [{ ...regula("R"), enabled: false }], [fakt("id1", "x")]);
    expect(a.chat).not.toHaveBeenCalled();
    expect(b.chat).not.toHaveBeenCalled();
  });

  it("pomija regule wylaczona — nie ma jej w promptcie, wiec nie moze byc sprzeczna", async () => {
    const llm = llmZ("BRAK");
    await sprawdzFaktyZRegulami(llm, [regula("Zywa"), { ...regula("Martwa"), enabled: false }], [fakt("id1", "x")]);
    const wsad = llm.chat.mock.calls[0][0].message as string;
    expect(wsad).toContain("Zywa");
    expect(wsad).not.toContain("Martwa");
  });

  it("kontrola pamieci nie wciaga pamieci ani sieci", async () => {
    const llm = llmZ("BRAK");
    await sprawdzFaktyZRegulami(llm, [regula("R")], [fakt("id1", "x")]);
    expect(llm.chat.mock.calls[0][0]).toMatchObject({ memoryTokenLimit: 0, webSearchLimit: 0 });
  });

  it("awaria modelu nie rzuca, tylko wraca jako blad do pokazania", async () => {
    const llm = { chat: vi.fn(async () => { throw new Error("model padl"); }) } as unknown as IChatEngine;
    const w = await sprawdzFaktyZRegulami(llm, [regula("R")], [fakt("id1", "x")]);
    expect(w).toEqual({ znaleziska: [], sprawdzono: 1, blad: "model padl" });
  });
});

describe("kontrola nie karmi pamieci soba", () => {
  it("prosi o pominiecie ekstrakcji", async () => {
    // Bez tego wsadem ekstraktora sa REGULY, wiec kontrola zapisuje je do
    // pamieci jako fakty i przy nastepnym przebiegu znajduje jako „pokryte".
    const llm = { chat: vi.fn(async () => ({ response: "BRAK" })) } as unknown as IChatEngine & { chat: ReturnType<typeof vi.fn> };
    await sprawdzFaktyZRegulami(llm, [regula("R")], [fakt("id1", "x")]);
    expect(llm.chat.mock.calls[0][0].skipExtraction).toBe(true);
  });
});
