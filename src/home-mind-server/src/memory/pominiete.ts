/**
 * Trwały ślad po tym, czego pamięć NIE przyjęła.
 *
 * Dwa filtry odrzucają dziś materiał, zanim stanie się faktem: bramka
 * ekstrakcji (cała tura była poleceniem) i filtr treści (fakt wygląda na
 * śmieć). Oba pisały tylko na stdout, a to znaczy, że dowody znikały przy
 * każdym przebudowaniu kontenera — 11 zapisów z jednego dnia wyparowałoby
 * przy najbliższym wdrożeniu.
 *
 * Utrata faktu jest cicha: nie ma błędu, nie ma śladu, a za tydzień nie
 * sposób odróżnić „filtr to wyciął" od „nigdy tego nie powiedziano". Dlatego
 * odrzucenia lądują w pliku na trwałym wolumenie — po to, żeby dało się je
 * przeczytać i ocenić, a nie po to, żeby coś nimi sterować.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { envOrUndefined } from "../env.js";

/** Czytane przy każdym wywołaniu, żeby test mógł podstawić katalog tymczasowy. */
function sciezka(): string {
  return envOrUndefined("SKIPPED_LOG_PATH") ?? "/data/pominiete-ekstrakcje.jsonl";
}

/**
 * Sufit rozmiaru. Przy kilkudziesięciu turach dziennie to lata zapisów, ale
 * plik bez ograniczenia na urządzeniu, które ma chodzić latami, i tak jest
 * usterką czekającą na swój dzień.
 */
const MAX_BAJTOW = 2 * 1024 * 1024;

export interface ZapisanePominiecie extends Pominiecie {
  /** Nadawane przy odczycie — plik nie przechowuje identyfikatorów. */
  id: string;
  kiedy: string;
}

export interface Pominiecie {
  /** `bramka` — cała tura odrzucona; `filtr` — pojedynczy fakt odrzucony. */
  rodzaj: "bramka" | "filtr";
  powod: string;
  /** Wypowiedź użytkownika (bramka) albo treść faktu (filtr). */
  tresc: string;
  userId: string;
  narzedzia?: string[];
}

/**
 * Dopisz jedną linię JSON. Nigdy nie rzuca.
 *
 * Wołane w środku ekstrakcji faktów, przed ich zapisem — awaria zapisu ma
 * kosztować wpis w dzienniku, a nie fakty z tej samej tury.
 */
export function zapiszPominiecie(wpis: Pominiecie): void {
  try {
    const plik = sciezka();
    mkdirSync(dirname(plik), { recursive: true });

    if (existsSync(plik) && statSync(plik).size > MAX_BAJTOW) {
      // Zostaw młodszą połowę: starsze wpisy zdążyły już zostać przejrzane
      // albo nigdy nie zostaną.
      const linie = readFileSync(plik, "utf-8").split("\n").filter(Boolean);
      writeFileSync(plik, linie.slice(Math.floor(linie.length / 2)).join("\n") + "\n", "utf-8");
    }

    appendFileSync(plik, JSON.stringify({ kiedy: new Date().toISOString(), ...wpis }) + "\n", "utf-8");
  } catch (err) {
    console.error("[pominiete] nie udalo sie zapisac wpisu:", err);
  }
}

/**
 * Identyfikator wpisu, wyliczany z jego treści.
 *
 * Plik jest dziennikiem dopisywanym linia po linii i nie przechowuje żadnych
 * identyfikatorów — nadawanie ich przy zapisie znaczyłoby, że stare wpisy ich
 * nie mają. Skrót z czasu i treści jest stabilny między odczytami, a to
 * wszystko, czego panel potrzebuje, żeby wskazać wpis do usunięcia.
 */
function identyfikator(kiedy: string, tresc: string): string {
  return createHash("sha1").update(`${kiedy}|${tresc}`).digest("hex").slice(0, 12);
}

/** Wpisy od najnowszego. Uszkodzone linie są pomijane, nie wywracają odczytu. */
export function czytajPominiecia(limit = 500): ZapisanePominiecie[] {
  const plik = sciezka();
  if (!existsSync(plik)) return [];

  try {
    const wpisy: ZapisanePominiecie[] = [];
    for (const linia of readFileSync(plik, "utf-8").split("\n")) {
      if (!linia.trim()) continue;
      try {
        const w = JSON.parse(linia);
        if (typeof w?.tresc !== "string" || typeof w?.kiedy !== "string") continue;
        wpisy.push({ ...w, id: identyfikator(w.kiedy, w.tresc) });
      } catch {
        // Pojedyncza uszkodzona linia nie moze zabrac ze soba calego dziennika.
      }
    }
    return wpisy.reverse().slice(0, limit);
  } catch (err) {
    console.error("[pominiete] nie udalo sie odczytac dziennika:", err);
    return [];
  }
}

/** Usuwa wpis z dziennika. Zwraca, czy cokolwiek usunięto. */
export function usunPominiecie(id: string): boolean {
  const plik = sciezka();
  if (!existsSync(plik)) return false;

  try {
    const linie = readFileSync(plik, "utf-8").split("\n").filter(Boolean);
    const zostaje = linie.filter((linia) => {
      try {
        const w = JSON.parse(linia);
        return identyfikator(w.kiedy, w.tresc) !== id;
      } catch {
        return true;
      }
    });
    if (zostaje.length === linie.length) return false;
    writeFileSync(plik, zostaje.length ? zostaje.join("\n") + "\n" : "", "utf-8");
    return true;
  } catch (err) {
    console.error("[pominiete] nie udalo sie usunac wpisu:", err);
    return false;
  }
}
