import { describe, it, expect } from "vitest";
import { zbierzProfile } from "./routes.js";

const osoba = (id: string, nazwa?: string) => ({
  entity_id: `person.${id}`,
  attributes: nazwa ? { friendly_name: nazwa } : undefined,
});

describe("lista profilow pamieci", () => {
  it("zawsze zawiera profil wspolny, na pierwszym miejscu", () => {
    expect(zbierzProfile([], [])[0].id).toBe("default");
  });

  it("bierze osoby z Home Assistanta razem z ich nazwami", () => {
    const p = zbierzProfile([osoba("lech", "Lech"), osoba("wladek", "Władek")], []);
    expect(p.map((x) => x.id)).toEqual(["default", "lech", "wladek"]);
    expect(p.find((x) => x.id === "wladek")!.nazwa).toBe("Władek");
  });

  it("dokłada profile widziane w dzienniku, ktorych nie ma w HA", () => {
    // Dziennik jest trwaly, wiec pamieta profil nawet gdy osoba zniknela z HA
    // albo nigdy nie byla tam zdefiniowana.
    const p = zbierzProfile([osoba("lech", "Lech")], ["lech", "gosc"]);
    expect(p.map((x) => x.id)).toEqual(["default", "lech", "gosc"]);
  });

  it("nie duplikuje profilu widzianego w obu zrodlach", () => {
    const p = zbierzProfile([osoba("lech", "Lech")], ["lech", "lech"]);
    expect(p.filter((x) => x.id === "lech")).toHaveLength(1);
    // Nazwa z HA wygrywa nad golym identyfikatorem z dziennika.
    expect(p.find((x) => x.id === "lech")!.nazwa).toBe("Lech");
  });

  it("pomija puste identyfikatory", () => {
    expect(zbierzProfile([{ entity_id: "person." }], [""]).map((x) => x.id)).toEqual(["default"]);
  });
});
