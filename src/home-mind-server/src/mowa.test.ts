import { describe, expect, it } from "vitest";
import { godzinaMianownik, numerSlownie, oGodzinieSlownie } from "./mowa.js";

describe("oGodzinieSlownie", () => {
  /** Blad z 19.09: model czytal rozklad "o dziewietnastej czterdziestej osiem". */
  it("minuty z rozkladu sa liczebnikiem GLOWNYM", () => {
    expect(oGodzinieSlownie("19:48")).toBe("o dziewiętnastej czterdzieści osiem");
    expect(oGodzinieSlownie("20:12")).toBe("o dwudziestej dwanaście");
  });

  it("pelna godzina i minuty jednocyfrowe", () => {
    expect(oGodzinieSlownie("18:00")).toBe("o osiemnastej");
    expect(oGodzinieSlownie("08:05")).toBe("o ósmej zero pięć");
  });

  it("dwojka w minutach jest zenska", () => {
    expect(oGodzinieSlownie("22:22")).toBe("o dwudziestej drugiej dwadzieścia dwie");
  });

  it("smieci nie udaja godziny", () => {
    expect(oGodzinieSlownie("24:00")).toBeUndefined();
    expect(oGodzinieSlownie("19:60")).toBeUndefined();
    expect(oGodzinieSlownie("jutro")).toBeUndefined();
  });
});

describe("godzinaMianownik", () => {
  /** Blad z 19.09: "dziewietnasta czterdziestaczy piec". */
  it("odpowiedz na 'ktora godzina'", () => {
    expect(godzinaMianownik("19:45")).toBe("dziewiętnasta czterdzieści pięć");
    expect(godzinaMianownik("21:02")).toBe("dwudziesta pierwsza zero dwie");
    expect(godzinaMianownik("07:00")).toBe("siódma");
  });

  it("polnoc zamiast 'zero'", () => {
    expect(godzinaMianownik("00:00")).toBe("północ");
    expect(godzinaMianownik("00:15")).toBe("zero piętnaście");
  });
});

describe("numerSlownie", () => {
  /** Blad z 19.09: "autobus sto jedenastu". */
  it("numery linii", () => {
    expect(numerSlownie("111")).toBe("sto jedenaście");
    expect(numerSlownie("32")).toBe("trzydzieści dwa");
    expect(numerSlownie("7")).toBe("siedem");
    expect(numerSlownie("240")).toBe("dwieście czterdzieści");
    expect(numerSlownie("100")).toBe("sto");
  });

  it("linia z litera", () => {
    expect(numerSlownie("0L")).toBe("zero l");
    expect(numerSlownie("15a")).toBe("piętnaście a");
  });

  it("nie-numer zostaje bez formy mowionej", () => {
    expect(numerSlownie("D")).toBeUndefined();
    expect(numerSlownie("1234")).toBeUndefined();
  });
});
