import { describe, expect, it, vi } from "vitest";
import { scalCzesci } from "./gemini-client.js";

/** Skrót: przepuść listę porcji przez scalanie i oddaj wynik + wypowiedziany tekst. */
function scal(porcje: Record<string, unknown>[][]) {
  const zebrane: Record<string, unknown>[] = [];
  const mowione: string[] = [];
  for (const porcja of porcje) {
    scalCzesci(zebrane as never, porcja as never, (k) => mowione.push(k));
  }
  return { zebrane, mowione: mowione.join("") };
}

describe("scalCzesci", () => {
  it("skleja tekst rozbity na porcje w jedną część", () => {
    const { zebrane, mowione } = scal([
      [{ text: "Włącz" }],
      [{ text: "ono " }],
      [{ text: "światła." }],
    ]);
    expect(zebrane).toHaveLength(1);
    expect(zebrane[0].text).toBe("Włączono światła.");
    expect(mowione).toBe("Włączono światła.");
  });

  describe("🔴 wywołania narzędzi", () => {
    it("NIGDY nie są sklejane ze sobą", () => {
      // To jest ta awaria: dwie encje w jednej komendzie, dwa `call_service`.
      // Sklejenie ich w jedno to „puste odpowiedzi przy sterowaniu wieloma
      // encjami" — kosztowało nas osobną łatkę po stronie OpenAI-compat.
      const { zebrane } = scal([
        [{ functionCall: { name: "call_service", args: { entity_id: "light.a" } } }],
        [{ functionCall: { name: "call_service", args: { entity_id: "light.b" } } }],
      ]);
      expect(zebrane).toHaveLength(2);
      expect(zebrane.every((c) => c.functionCall)).toBe(true);
    });

    it("nie wchłaniają sąsiedniego tekstu", () => {
      const { zebrane } = scal([
        [{ text: "Już sprawdzam. " }],
        [{ functionCall: { name: "get_state" } }],
      ]);
      expect(zebrane).toHaveLength(2);
      expect(zebrane[0].text).toBe("Już sprawdzam. ");
      expect(zebrane[1].functionCall).toBeTruthy();
    });
  });

  describe("🔴 thoughtSignature — bez niego kontynuacja pada na 400", () => {
    it("zachowany przy wywołaniu narzędzia", () => {
      const { zebrane } = scal([
        [{ functionCall: { name: "get_state" }, thoughtSignature: "podpis-1" }],
      ]);
      expect(zebrane[0].thoughtSignature).toBe("podpis-1");
    });

    it("dopięty, gdy przyjdzie osobną porcją po tekście", () => {
      const { zebrane } = scal([[{ text: "Sprawdzam" }], [{ thoughtSignature: "podpis-2" }]]);
      expect(zebrane).toHaveLength(1);
      expect(zebrane[0].thoughtSignature).toBe("podpis-2");
    });

    it("późniejsza porcja tej samej części nadpisuje podpis", () => {
      const { zebrane } = scal([
        [{ text: "a", thoughtSignature: "stary" }],
        [{ text: "b", thoughtSignature: "nowy" }],
      ]);
      expect(zebrane).toHaveLength(1);
      expect(zebrane[0].thoughtSignature).toBe("nowy");
    });
  });

  describe("części oznaczone jako myśl", () => {
    it("są zbierane, ale NIE wypowiadane", () => {
      const { zebrane, mowione } = scal([
        [{ text: "użytkownik pyta o światło", thought: true }],
        [{ text: "Włączono." }],
      ]);
      expect(mowione).toBe("Włączono.");
      expect(zebrane).toHaveLength(2);
      expect(zebrane[0].thought).toBe(true);
    });

    it("nie sklejają się z tekstem dla człowieka", () => {
      const { zebrane } = scal([
        [{ text: "myślę ", thought: true }],
        [{ text: "dalej myślę", thought: true }],
        [{ text: "Gotowe." }],
      ]);
      expect(zebrane).toHaveLength(2);
      expect(zebrane[0].text).toBe("myślę dalej myślę");
      expect(zebrane[1].text).toBe("Gotowe.");
    });
  });

  it("pusta lub brakująca lista części nic nie psuje", () => {
    const zebrane: Record<string, unknown>[] = [];
    const onTekst = vi.fn();
    scalCzesci(zebrane as never, undefined, onTekst);
    scalCzesci(zebrane as never, [] as never, onTekst);
    expect(zebrane).toHaveLength(0);
    expect(onTekst).not.toHaveBeenCalled();
  });

  it("odtwarza kształt, którego oczekuje pętla narzędzi", () => {
    // Realny przebieg: krótki wstęp, wywołanie, podpis — dokładnie to jest
    // odsyłane do Gemini jako tura modelu.
    const { zebrane } = scal([
      [{ text: "Chwila" }],
      [{ text: ", sprawdzam." }],
      [{ functionCall: { name: "get_state", args: { entity_id: "light.h60c1" } } }],
      [{ thoughtSignature: "sig" }],
    ]);
    expect(zebrane).toHaveLength(2);
    expect(zebrane[0].text).toBe("Chwila, sprawdzam.");
    expect(zebrane[1].functionCall).toEqual({
      name: "get_state",
      args: { entity_id: "light.h60c1" },
    });
    expect(zebrane[1].thoughtSignature).toBe("sig");
  });
});
