import { describe, it, expect } from "vitest";
import { belongsTo } from "./routes.js";

/**
 * Kto może odczytać zapisaną rozmowę.
 *
 * Trasa `/conversations/:userId/:conversationId` przez cały czas nosiła
 * `:userId` i nigdy na niego nie patrzyła — historia szła po samym
 * `conversationId`, więc te same tury wracały pod dowolnym profilem. Zmierzone
 * na żywo 08.08 przed poprawką: rozmowa Lecha („Zamknij lewą roletę") oddana
 * pod profilem `default` w całości.
 *
 * Testujemy tu SEMANTYKĘ własności, nie sam `some()`: to ona jest miejscem, w
 * którym łatwo pomylić się w drugą stronę i zamknąć dostęp właścicielowi.
 */
describe("własność rozmowy", () => {
  const tura = (userId: string) => ({ userId });

  it("właściciel czyta swoją rozmowę", () => {
    expect(belongsTo([tura("lech"), tura("lech")], "lech")).toBe(true);
  });

  it("obcy profil nie czyta cudzej rozmowy", () => {
    expect(belongsTo([tura("lech"), tura("lech")], "default")).toBe(false);
  });

  // Sedno: sesja głosowa potrafi zacząć się przed rozpoznaniem mówcy. Pierwsza
  // tura ląduje na profilu wspólnym, a po rozpoznaniu reszta TEGO SAMEGO
  // `conversationId` na profilu osoby. Wymaganie jednego właściciela zamknęłoby
  // taką rozmowę przed wszystkimi, a branie właściciela z pierwszej wiadomości
  // oddałoby ją temu, kto przypadkiem odezwał się pierwszy.
  it("rozmowa zaczęta przed rozpoznaniem należy do obu profili", () => {
    const mieszana = [tura("default"), tura("lech"), tura("lech")];
    expect(belongsTo(mieszana, "lech")).toBe(true);
    expect(belongsTo(mieszana, "default")).toBe(true);
    expect(belongsTo(mieszana, "wladek")).toBe(false);
  });

  // Rozmowa nieistniejąca i cudza mają odpowiadać tak samo (404), żeby trasa
  // nie służyła do sprawdzania, które identyfikatory są prawdziwe.
  it("pusta historia nie należy do nikogo", () => {
    expect(belongsTo([], "lech")).toBe(false);
    expect(belongsTo([], "default")).toBe(false);
  });
});
