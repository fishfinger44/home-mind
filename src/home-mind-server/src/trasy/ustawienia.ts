/**
 * Ustawienia planowania tras: `.env` jako podklad, panel jako nadpisanie.
 *
 * Ten sam uklad co przy przelaczaniu modelu (`llm/runtime-config.ts`): plik w
 * wolumenie wygrywa z env i przezywa restart kontenera, a env zostaje tym, co
 * dziala zaraz po postawieniu serwera od zera.
 *
 * Miejsca sa nadpisywane W CALOSCI, a nie scalane z env. Inaczej skasowanie
 * wpisu w panelu byloby niemozliwe - wracalby przy kazdym odczycie, a nikt nie
 * zgadlby dlaczego.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envNumber, envOrUndefined } from "../env.js";

export interface ZapisaneUstawienia {
  /** Klucz Google Maps Platform. Nigdy nie wychodzi przez API na zewnatrz. */
  klucz?: string;
  miejsca?: Record<string, string>;
  limitDzienny?: number;
  ileWariantow?: number;
}

/** Skad pochodzi wartosc - do pokazania w panelu. */
export type Zrodlo = "panel" | "env" | "domyslne" | "brak";

function sciezka(): string {
  return envOrUndefined("TRASY_CONFIG_PATH") ?? "/data/trasy-config.json";
}

let pamiec: ZapisaneUstawienia | null = null;

function zapisane(): ZapisaneUstawienia {
  if (pamiec) return pamiec;
  let dane: ZapisaneUstawienia = {};
  try {
    const plik = sciezka();
    if (existsSync(plik)) {
      const parsed = JSON.parse(readFileSync(plik, "utf8")) as ZapisaneUstawienia;
      if (parsed && typeof parsed === "object") dane = parsed;
    }
  } catch (err) {
    console.warn(`[trasy] nie moge odczytac ustawien: ${(err as Error).message}`);
  }
  pamiec = dane;
  return dane;
}

/** Tylko wpisy tekstowe - plik da sie edytowac recznie, wiec moze byc krzywy. */
function tylkoNapisy(wartosc: unknown): Record<string, string> {
  if (!wartosc || typeof wartosc !== "object") return {};
  return Object.fromEntries(
    Object.entries(wartosc as Record<string, unknown>).filter(
      (para): para is [string, string] =>
        typeof para[1] === "string" && para[1].trim() !== "" && para[0].trim() !== ""
    )
  );
}

function miejscaZEnv(): Record<string, string> {
  const surowe = envOrUndefined("TRASY_MIEJSCA");
  if (!surowe) return {};
  try {
    return tylkoNapisy(JSON.parse(surowe));
  } catch (err) {
    console.warn(`[trasy] TRASY_MIEJSCA nie jest poprawnym JSON-em: ${(err as Error).message}`);
    return {};
  }
}

/** Klucz do Routes API. `undefined` = narzedzie nie ma czym dzwonic. */
export function kluczApi(): string | undefined {
  const zPliku = zapisane().klucz;
  if (typeof zPliku === "string" && zPliku.trim() !== "") return zPliku.trim();
  return envOrUndefined("GOOGLE_ROUTES_API_KEY");
}

export function zrodloKlucza(): Zrodlo {
  const zPliku = zapisane().klucz;
  if (typeof zPliku === "string" && zPliku.trim() !== "") return "panel";
  return envOrUndefined("GOOGLE_ROUTES_API_KEY") ? "env" : "brak";
}

/** Skroty miejsc w oryginalnej pisowni (klucze normalizuje dopiero `miejsca.ts`). */
export function miejsca(): Record<string, string> {
  const zPliku = zapisane().miejsca;
  if (zPliku && Object.keys(tylkoNapisy(zPliku)).length > 0) return tylkoNapisy(zPliku);
  return miejscaZEnv();
}

export function zrodloMiejsc(): Zrodlo {
  const zPliku = zapisane().miejsca;
  if (zPliku && Object.keys(tylkoNapisy(zPliku)).length > 0) return "panel";
  return Object.keys(miejscaZEnv()).length > 0 ? "env" : "brak";
}

/** Ile wywolan na dobe wolno. 0 = narzedzie wylaczone. */
export function limitDzienny(): number {
  const zPliku = zapisane().limitDzienny;
  if (typeof zPliku === "number" && Number.isFinite(zPliku) && zPliku >= 0) return Math.floor(zPliku);
  return envNumber("TRASY_LIMIT_DZIENNY", 100);
}

/** Ile wariantow trasy pokazac modelowi. Jedno zapytanie, wiec cena ta sama. */
export function ileWariantow(): number {
  const zPliku = zapisane().ileWariantow;
  if (typeof zPliku === "number" && Number.isFinite(zPliku) && zPliku > 0) return Math.floor(zPliku);
  return envNumber("TRASY_ILE_WARIANTOW", 3);
}

/**
 * Zapisz zmiany z panelu. Pola pominiete zostaja bez zmian; `klucz: ""` kasuje
 * nadpisanie i oddaje pierwszenstwo temu z `.env`.
 */
export function zapiszUstawienia(zmiany: ZapisaneUstawienia): ZapisaneUstawienia {
  const teraz = { ...zapisane() };

  if (zmiany.klucz !== undefined) {
    if (zmiany.klucz.trim() === "") delete teraz.klucz;
    else teraz.klucz = zmiany.klucz.trim();
  }
  if (zmiany.miejsca !== undefined) teraz.miejsca = tylkoNapisy(zmiany.miejsca);
  if (zmiany.limitDzienny !== undefined && Number.isFinite(zmiany.limitDzienny)) {
    teraz.limitDzienny = Math.max(0, Math.floor(zmiany.limitDzienny));
  }
  if (zmiany.ileWariantow !== undefined && Number.isFinite(zmiany.ileWariantow)) {
    teraz.ileWariantow = Math.min(5, Math.max(1, Math.floor(zmiany.ileWariantow)));
  }

  const plik = sciezka();
  mkdirSync(dirname(plik), { recursive: true });
  writeFileSync(plik, JSON.stringify(teraz, null, 2));
  pamiec = teraz;
  return teraz;
}

/** Tylko na potrzeby testow. */
export function zapomnijUstawienia(): void {
  pamiec = null;
}
