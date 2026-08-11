import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { faktNaRegule, przeniesFakt, zbierzProfile } from "./routes.js";
import { loadRules, resetRulesCache, saveRules } from "../rules/store.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { Fact, FactCategory } from "../memory/types.js";

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

function pamiecZ(fakty: Partial<Fact>[]) {
  return {
    getFacts: vi.fn(async () =>
      fakty.map((f) => ({ confidence: 0.9, category: "device" as FactCategory, ...f }) as Fact)
    ),
    addFactIfNew: vi.fn(async () => "nowy-id"),
    deleteFact: vi.fn(async () => true),
  } as unknown as IMemoryStore & {
    getFacts: ReturnType<typeof vi.fn>;
    addFactIfNew: ReturnType<typeof vi.fn>;
    deleteFact: ReturnType<typeof vi.fn>;
  };
}

describe("przenoszenie faktu do profilu wspolnego", () => {
  it("zapisuje w celu i kasuje ze zrodla, zachowujac tresc, kategorie i pewnosc", async () => {
    const m = pamiecZ([{ id: "f1", content: "główne światło = light.salon", category: "device", confidence: 0.8 }]);

    expect(await przeniesFakt(m, "lech", "f1")).toEqual({
      status: 200,
      wynik: "przeniesiony",
      id: "nowy-id",
    });
    expect(m.addFactIfNew).toHaveBeenCalledWith("default", "główne światło = light.salon", "device", 0.8);
    expect(m.deleteFact).toHaveBeenCalledWith("lech", "f1");
  });

  it("nie kasuje zrodla, gdy zapis w celu sie nie powiodl", async () => {
    // Kolejnosc jest calym zabezpieczeniem: awaria ma zostawic duplikat albo
    // nietkniete zrodlo, nigdy dziury po fakcie.
    const m = pamiecZ([{ id: "f1", content: "cokolwiek" }]);
    m.addFactIfNew.mockRejectedValue(new Error("Shodh padl"));

    await expect(przeniesFakt(m, "lech", "f1")).rejects.toThrow("Shodh padl");
    expect(m.deleteFact).not.toHaveBeenCalled();
  });

  it("gdy cel juz to wie, zostaje samo usuniecie kopii ze zrodla", async () => {
    const m = pamiecZ([{ id: "f1", content: "cokolwiek" }]);
    m.addFactIfNew.mockResolvedValue(null);

    expect(await przeniesFakt(m, "lech", "f1")).toEqual({ status: 200, wynik: "scalony" });
    expect(m.deleteFact).toHaveBeenCalledWith("lech", "f1");
  });

  it("odmawia faktom osobistym — profil wspolny ich nie trzyma", async () => {
    for (const category of ["preference", "identity", "pattern"] as FactCategory[]) {
      const m = pamiecZ([{ id: "f1", content: "lubi 22 stopnie", category }]);
      const w = await przeniesFakt(m, "lech", "f1");
      expect(w.status).toBe(400);
      expect(w.error).toContain(category);
      expect(m.addFactIfNew).not.toHaveBeenCalled();
      expect(m.deleteFact).not.toHaveBeenCalled();
    }
  });

  it("przepuszcza fakt osobisty do wspolnego, gdy czlowiek go przekwalifikuje", async () => {
    // Bez zmiany kategorii fakt wjechalby do wspolnego i zostal odfiltrowany
    // przy odczycie, czyli znikalby wszystkim.
    const m = pamiecZ([{ id: "f1", content: "woli ciepłe światło w salonie", category: "preference", confidence: 0.7 }]);

    expect((await przeniesFakt(m, "lech", "f1", "default", "baseline")).wynik).toBe("przeniesiony");
    expect(m.addFactIfNew).toHaveBeenCalledWith("default", "woli ciepłe światło w salonie", "baseline", 0.7);
    expect(m.deleteFact).toHaveBeenCalledWith("lech", "f1");
  });

  it("nie pozwala przekwalifikowac na inna kategorie osobowa", async () => {
    const m = pamiecZ([{ id: "f1", content: "lubi 22 stopnie", category: "preference" }]);
    const w = await przeniesFakt(m, "lech", "f1", "default", "identity");
    expect(w.status).toBe(400);
    expect(m.addFactIfNew).not.toHaveBeenCalled();
    expect(m.deleteFact).not.toHaveBeenCalled();
  });

  it("odrzuca kategorie, ktorej nie ma", async () => {
    const m = pamiecZ([{ id: "f1", content: "cokolwiek" }]);
    const w = await przeniesFakt(m, "lech", "f1", "default", "wymyslona" as FactCategory);
    expect(w.status).toBe(400);
    expect(m.addFactIfNew).not.toHaveBeenCalled();
  });

  it("przepuszcza fakt osobisty do profilu innej OSOBY — regula dotyczy tylko wspolnego", async () => {
    const m = pamiecZ([{ id: "f1", content: "lubi 22 stopnie", category: "preference" }]);
    expect((await przeniesFakt(m, "lech", "f1", "wladek")).wynik).toBe("przeniesiony");
  });

  it("odmawia, gdy zrodlo i cel to ten sam profil", async () => {
    const m = pamiecZ([{ id: "f1", content: "cokolwiek" }]);
    expect((await przeniesFakt(m, "default", "f1")).status).toBe(400);
    expect(m.getFacts).not.toHaveBeenCalled();
  });

  it("zwraca 404, gdy faktu nie ma w tym profilu", async () => {
    const m = pamiecZ([{ id: "inny" }]);
    expect((await przeniesFakt(m, "lech", "f1")).status).toBe(404);
    expect(m.deleteFact).not.toHaveBeenCalled();
  });
});

describe("awans faktu na regule domowa", () => {
  let katalog: string;

  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), "reguly-"));
    process.env.RULES_PATH = join(katalog, "rules.json");
    resetRulesCache();
  });

  afterEach(() => {
    delete process.env.RULES_PATH;
    resetRulesCache();
    rmSync(katalog, { recursive: true, force: true });
  });

  it("dopisuje regule na koncu listy i kasuje fakt", async () => {
    saveRules([{ id: "r1", title: "Pierwsza", text: "Nie zgaduj.", enabled: true, protected: true, suggested: false }]);
    const m = pamiecZ([{ id: "f1", content: "W salonie świeci się ciepło." }]);

    const w = await faktNaRegule(m, "lech", "f1", "Światło w salonie");

    expect(w.status).toBe(200);
    expect(w.wynik).toBe("awansowany");
    const reguly = loadRules();
    expect(reguly).toHaveLength(2);
    // Kolejnosc decyduje o tym, kto wygrywa sprzecznosc — nowa idzie na koniec.
    expect(reguly[1]).toMatchObject({ title: "Światło w salonie", text: "W salonie świeci się ciepło." });
    expect(m.deleteFact).toHaveBeenCalledWith("lech", "f1");
  });

  it("tworzy regule WYLACZONA i nieoznaczona jako sugestia asystenta", async () => {
    const m = pamiecZ([{ id: "f1", content: "Cokolwiek." }]);
    await faktNaRegule(m, "lech", "f1");

    expect(loadRules()[0]).toMatchObject({ enabled: false, suggested: false, protected: false });
  });

  it("nie kasuje faktu, gdy taka regula juz istnieje", async () => {
    // Nic nie powstalo, wiec skasowanie faktu byloby cicha strata przy
    // operacji, ktora sie nie odbyla.
    saveRules([{ id: "r1", title: "Jest", text: "Cokolwiek.", enabled: true, protected: false, suggested: false }]);
    const m = pamiecZ([{ id: "f1", content: "  cokolwiek.  " }]);

    const w = await faktNaRegule(m, "lech", "f1");

    expect(w.status).toBe(409);
    expect(loadRules()).toHaveLength(1);
    expect(m.deleteFact).not.toHaveBeenCalled();
  });

  it("bierze tytul zastepczy, gdy nie podano zadnego", async () => {
    const m = pamiecZ([{ id: "f1", content: "Cokolwiek." }]);
    await faktNaRegule(m, "lech", "f1", "   ");
    expect(loadRules()[0].title).toBe("Z pamięci");
  });

  it("dziala tak samo w profilu wspolnym", async () => {
    const m = pamiecZ([{ id: "f1", content: "Kuchnia to segment 1." }]);
    expect((await faktNaRegule(m, "default", "f1")).wynik).toBe("awansowany");
    expect(m.deleteFact).toHaveBeenCalledWith("default", "f1");
  });

  it("zwraca 404, gdy faktu nie ma — i nie zostawia reguly", async () => {
    const m = pamiecZ([{ id: "inny" }]);
    expect((await faktNaRegule(m, "lech", "f1")).status).toBe(404);
    expect(loadRules()).toHaveLength(0);
  });
});
