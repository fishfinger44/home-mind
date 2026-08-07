import { describe, it, expect } from "vitest";
import { skipExtraction } from "./extraction-gate.js";

describe("bramka ekstrakcji faktow", () => {
  it("pomija czyste wykonanie polecenia", () => {
    expect(skipExtraction("zapal swiatlo w kuchni", ["call_service"])).toContain("wykonanie");
    expect(skipExtraction("otworz rolety w salonie", ["call_service", "call_service"])).not.toBeNull();
  });

  it("pomija pytania o stan — tez nie ma z nich czego zapamietac", () => {
    expect(skipExtraction("jaka jest temperatura w sypialni", ["get_state"])).not.toBeNull();
    expect(skipExtraction("ktore swiatla sa wlaczone", ["get_entities", "get_state"])).not.toBeNull();
  });

  it("NIE pomija zwyklej rozmowy, bo tam mieszkaja fakty", () => {
    expect(skipExtraction("mamy nowego psa, wabi sie Rex", [])).toBeNull();
  });

  it("NIE pomija tury z wyszukiwaniem w sieci", () => {
    // Wyszukiwanie pada przy pytaniach otwartych, a te bywaja rozmowa.
    expect(skipExtraction("o ktorej jest pociag do Warszawy", ["web_search"])).toBeNull();
    expect(skipExtraction("sprawdz i ustaw", ["web_search", "call_service"])).toBeNull();
  });

  it("NIE pomija polecenia, ktore niesie fakt", () => {
    // To jest wlasnie tura, na ktorej zalezy nam najbardziej: poprawka faktu
    // powiedziana jako rozkaz.
    expect(skipExtraction("ustaw sypialnie na 21 i tak ma byc zawsze", ["call_service"])).toBeNull();
    expect(skipExtraction("zapal swiatlo, zapamietaj ze wolimy cieple", ["call_service"])).toBeNull();
  });

  it("rozpoznaje znaczniki mimo braku polskich znakow", () => {
    // Transkrypcja mowy gubi ogonki, wiec lista musi dzialac i bez nich.
    expect(skipExtraction("ustaw 21, zawsze tak wolę", ["call_service"])).toBeNull();
    expect(skipExtraction("wlacz lampe, lubię ciemniej", ["call_service"])).toBeNull();
    expect(skipExtraction("zgas swiatlo, mój pokój ma byc ciemny", ["call_service"])).toBeNull();
  });

  it("nie daje sie zwiesc slowu wewnatrz innego wyrazu", () => {
    // "mam" w "zamaskuj" nie jest deklaracja.
    expect(skipExtraction("zamaskuj powiadomienia", ["call_service"])).not.toBeNull();
  });
});
