import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let katalog: string;

// Kazdy test dostaje wlasny plik ustawien: domyslne wartosci maja obowiazywac
// takze wtedy, gdy pliku nie ma, a wspolny plik przenosilby stan miedzy testami.
beforeEach(async () => {
  katalog = mkdtempSync(join(tmpdir(), "ogr-"));
  process.env.RESTRICTIONS_PATH = join(katalog, "ograniczenia.json");
  const { resetRestrictionsCache } = await import("./restricted.js");
  resetRestrictionsCache();
});

afterEach(() => {
  rmSync(katalog, { recursive: true, force: true });
  delete process.env.RESTRICTIONS_PATH;
});

import { checkRestriction, zapiszOgraniczenia } from "./restricted.js";

const nierozpoznany = false;
const rozpoznany = true;

describe("urzadzenia tylko dla rozpoznanych domownikow", () => {
  it("blokuje uruchomienie odkurzacza nierozpoznanemu glosowi", () => {
    const w = checkRestriction("vacuum", "send_command", "vacuum.roborock", nierozpoznany);
    expect(w.allowed).toBe(false);
    expect(w.reason).toContain("rozpoznany domownik");
  });

  it("blokuje przycisk rutyny Roborocka — tak wlasnie ruszyl przypadkiem", () => {
    // Rutyna startuje odkurzacz nie dotykajac domeny vacuum. Ograniczenie samej
    // domeny zostawiloby te droge otwarta.
    const w = checkRestriction("button", "press",
      "button.living_room_roborock_qrevo_edge_series_kuchnia_mopowanie", nierozpoznany);
    expect(w.allowed).toBe(false);
  });

  it("blokuje otwieranie rolet i wlaczanie klimatyzacji", () => {
    expect(checkRestriction("cover", "open_cover", "cover.salon_lewa", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("climate", "set_hvac_mode", "climate.580d0d2f9e31", nierozpoznany).allowed).toBe(false);
  });

  it("POZWALA kazdemu zatrzymac i wylaczyc", () => {
    // Kierunek dzialania niesie ryzyko: uruchomienie budzi dom, zatrzymanie nie.
    expect(checkRestriction("vacuum", "stop", "vacuum.roborock", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("climate", "turn_off", "climate.580d0d2f9e31", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("cover", "stop_cover", "cover.salon_lewa", nierozpoznany).allowed).toBe(true);
  });

  it("nie rusza swiatel, muzyki, filmow ani projektora", () => {
    for (const [d, s, e] of [
      ["light", "turn_on", "light.kitchen"],
      ["media_player", "play_media", "media_player.pokoj_dzienny"],
      ["script", "turn_on", "script.zagraj_muzyke"],
      ["switch", "turn_on", "switch.projektor"],
      ["media_assistant", "find_and_play", undefined],
    ] as const) {
      expect(checkRestriction(d, s, e, nierozpoznany).allowed).toBe(true);
    }
  });

  it("rozpoznany domownik moze wszystko", () => {
    expect(checkRestriction("vacuum", "send_command", "vacuum.roborock", rozpoznany).allowed).toBe(true);
    expect(checkRestriction("cover", "open_cover", "cover.salon_lewa", rozpoznany).allowed).toBe(true);
  });

  it("lapie encje z ograniczonej domeny podana bez pola domain", () => {
    expect(checkRestriction(undefined, "press", "cover.sypialnia", nierozpoznany).allowed).toBe(false);
  });

  it("gospodarstwo moze otworzyc odkurzacz dla wszystkich", () => {
    zapiszOgraniczenia({ grupy: ["rolety", "klimatyzacja"], wolnoZatrzymywac: true });
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("button", "press", "button.roborock_kuchnia", nierozpoznany).allowed).toBe(true);
    expect(checkRestriction("cover", "open_cover", "cover.salon", nierozpoznany).allowed).toBe(false);
  });

  it("gospodarstwo moze domknac swiatlo i zablokowac zatrzymywanie", () => {
    zapiszOgraniczenia({ grupy: ["swiatlo"], wolnoZatrzymywac: false });
    expect(checkRestriction("light", "turn_on", "light.kitchen", nierozpoznany).allowed).toBe(false);
    // Bez wyjatku uspokajajacego nawet gaszenie wymaga rozpoznania.
    expect(checkRestriction("light", "turn_off", "light.kitchen", nierozpoznany).allowed).toBe(false);
    expect(checkRestriction("vacuum", "start", "vacuum.roborock", nierozpoznany).allowed).toBe(true);
  });

  it("nazywa grupe w odmowie, zeby dalo sie ja odnalezc w panelu", () => {
    expect(checkRestriction("cover", "open_cover", "cover.salon", nierozpoznany).reason)
      .toContain("Rolety");
  });
});
