import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let katalog: string;

async function swiezyModul() {
  // RULES_PATH jest czytany przy imporcie, wiec kazdy test potrzebuje modulu
  // zaladowanego od nowa — wzorzec z reszty repozytorium (patrz CLAUDE.md).
  vi.resetModules();
  return await import("./store.js");
}

beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), "rules-"));
  process.env.RULES_PATH = join(katalog, "rules.json");
});

afterEach(() => {
  rmSync(katalog, { recursive: true, force: true });
  delete process.env.RULES_PATH;
});

const regula = (nadpisz: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  title: "Muzyka",
  text: "Muzykę graj wyłącznie przez script.zagraj_muzyke.",
  enabled: true,
  protected: false,
  suggested: false,
  ...nadpisz,
});

describe("magazyn regul domowych", () => {
  it("zwraca pusta liste, gdy pliku jeszcze nie ma", async () => {
    const { loadRules, rulesForPrompt } = await swiezyModul();
    expect(loadRules()).toEqual([]);
    // Brak regul to brak sekcji w promptcie, a nie pusty naglowek.
    expect(rulesForPrompt()).toBeUndefined();
  });

  it("zapisuje i odczytuje reguly zachowujac kolejnosc", async () => {
    const { saveRules, loadRules } = await swiezyModul();
    saveRules([regula({ id: "a", title: "A" }), regula({ id: "b", title: "B" })]);
    expect(loadRules().map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
  });

  it("sklada do promptu tylko wlaczone reguly, w kolejnosci listy", async () => {
    const { saveRules, rulesForPrompt } = await swiezyModul();
    saveRules([
      regula({ id: "a", text: "Pierwsza." }),
      regula({ id: "b", text: "Wylaczona.", enabled: false }),
      regula({ id: "c", text: "Druga." }),
    ]);
    expect(rulesForPrompt()).toBe("Pierwsza.\n\nDruga.");
  });

  it("pomija reguly bez tresci", async () => {
    const { saveRules, rulesForPrompt } = await swiezyModul();
    saveRules([regula({ id: "a", text: "   " }), regula({ id: "b", text: "Realna." })]);
    expect(rulesForPrompt()).toBe("Realna.");
  });

  it("przezywa uszkodzony plik zamiast wywracac serwer", async () => {
    writeFileSync(process.env.RULES_PATH!, "{to nie jest json", "utf-8");
    const { loadRules } = await swiezyModul();
    // Bez regul asystent nadal odpowiada i nadal ma custom prompt.
    expect(loadRules()).toEqual([]);
  });

  it("odrzuca wpisy o zlym ksztalcie, zachowujac poprawne", async () => {
    writeFileSync(
      process.env.RULES_PATH!,
      JSON.stringify([regula(), { id: "zly" }, "tekst"]),
      "utf-8"
    );
    const { loadRules } = await swiezyModul();
    expect(loadRules()).toHaveLength(1);
  });

  it("zapisuje sugestie asystenta zawsze jako WYLACZONA", async () => {
    const { suggestRule, loadRules, rulesForPrompt } = await swiezyModul();
    const nowa = suggestRule("Radio", "Radio graj przez HEOS.");
    expect(nowa?.enabled).toBe(false);
    expect(nowa?.suggested).toBe(true);
    expect(loadRules()).toHaveLength(1);
    // Wylaczona = nie dotyka promptu, dopoki czlowiek jej nie wlaczy.
    expect(rulesForPrompt()).toBeUndefined();
  });

  it("nie duplikuje sugestii o tej samej tresci", async () => {
    const { suggestRule, loadRules } = await swiezyModul();
    suggestRule("Radio", "Radio graj przez HEOS.");
    const druga = suggestRule("Radio inaczej", "  Radio graj przez HEOS.  ");
    expect(druga).toBeNull();
    expect(loadRules()).toHaveLength(1);
  });

  it("uznaje za duplikat to samo zdanie inaczej zlozone", async () => {
    const { suggestRule, loadRules } = await swiezyModul();
    suggestRule("Radio", "Radio graj przez HEOS.");
    // Ekstraktor rzadko powtarza wypowiedz znak w znak — inna wielkosc liter
    // albo zlamany wiersz to ta sama rada, nie druga.
    const druga = suggestRule("Radio", "radio graj\n  przez HEOS.");
    expect(druga).toBeNull();
    expect(loadRules()).toHaveLength(1);
  });

  it("przestaje przyjmowac sugestie, gdy kolejka jest pelna", async () => {
    const { suggestRule, loadRules } = await swiezyModul();
    for (let i = 0; i < 20; i++) suggestRule(`S${i}`, `Sugestia numer ${i}.`);
    // Ekstrakcja chodzi co ture, wiec bez sufitu tydzien gadania zasypalby
    // reguly napisane przez czlowieka.
    expect(suggestRule("Nadmiar", "Ta juz sie nie miesci.")).toBeNull();
    expect(loadRules()).toHaveLength(20);
  });

  it("wlaczona sugestia zwalnia miejsce w kolejce", async () => {
    const { suggestRule, saveRules, loadRules } = await swiezyModul();
    for (let i = 0; i < 20; i++) suggestRule(`S${i}`, `Sugestia numer ${i}.`);
    // Sufit dotyczy CZEKAJACYCH na przejrzenie — przyjeta regula juz nie czeka.
    saveRules(loadRules().map((r, i) => (i === 0 ? { ...r, enabled: true } : r)));
    expect(suggestRule("Nowa", "Ta juz sie miesci.")).not.toBeNull();
    expect(loadRules()).toHaveLength(21);
  });

  it("przycina biale znaki przy zapisie", async () => {
    const { saveRules } = await swiezyModul();
    const [zapisana] = saveRules([regula({ title: "  Muzyka  ", text: "  Tresc.  " })]);
    expect(zapisana.title).toBe("Muzyka");
    expect(zapisana.text).toBe("Tresc.");
  });
});
