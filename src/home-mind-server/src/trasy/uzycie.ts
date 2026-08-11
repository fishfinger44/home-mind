/**
 * Dzienny licznik wywolan Routes API.
 *
 * Wolajacym jest model, a nie czlowiek: jedna zapetlona rozmowa potrafi
 * wystrzelic setki zapytan, zanim ktokolwiek to zauwazy. Twardym hamulcem jest
 * limit quota po stronie Google (odrzuca zapytania, zamiast naliczac), a to
 * jest hamulec drugi, po naszej stronie - dziala od razu, widac go w logu i nie
 * wymaga wchodzenia do konsoli.
 *
 * Doba liczona lokalnie (TZ kontenera), a Google rozlicza swoje limity wedlug
 * czasu pacyficznego. To sie rozjezdza o kilka godzin i tak ma byc: nasz licznik
 * ma byc CIASNIEJSZY od cudzego, a nie identyczny.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envOrUndefined } from "../env.js";
import { limitDzienny } from "./ustawienia.js";

interface PlikUzycia {
  dzien: string;
  liczba: number;
}

function sciezka(): string {
  return envOrUndefined("TRASY_UZYCIE_PATH") ?? "/data/trasy-uzycie.json";
}

export { limitDzienny };

function dzisiaj(now = new Date()): string {
  // "sv-SE" daje YYYY-MM-DD, jedyny format tej listy, ktory sortuje sie sam.
  return now.toLocaleDateString("sv-SE", {
    timeZone: envOrUndefined("TZ") ?? "Europe/Warsaw",
  });
}

let pamiec: PlikUzycia | null = null;

function wczytaj(): PlikUzycia {
  const dzien = dzisiaj();
  if (pamiec && pamiec.dzien === dzien) return pamiec;

  let dane: PlikUzycia = { dzien, liczba: 0 };
  try {
    const plik = sciezka();
    if (existsSync(plik)) {
      const parsed = JSON.parse(readFileSync(plik, "utf8")) as PlikUzycia;
      if (parsed?.dzien === dzien && Number.isFinite(parsed.liczba)) {
        dane = { dzien, liczba: parsed.liczba };
      }
    }
  } catch (err) {
    console.warn(`[trasy] nie moge odczytac licznika: ${(err as Error).message}`);
  }

  pamiec = dane;
  return dane;
}

function zapisz(dane: PlikUzycia): void {
  pamiec = dane;
  try {
    const plik = sciezka();
    mkdirSync(dirname(plik), { recursive: true });
    writeFileSync(plik, JSON.stringify(dane, null, 2));
  } catch (err) {
    // Nieszkodliwe: liczenie idzie dalej w pamieci tego procesu.
    console.warn(`[trasy] nie moge zapisac licznika: ${(err as Error).message}`);
  }
}

/** Ile wywolan poszlo dzis. */
export function zuzyteDzis(): number {
  return wczytaj().liczba;
}

/** Czy dzienny limit jest juz wyczerpany. */
export function limitWyczerpany(): boolean {
  return zuzyteDzis() >= limitDzienny();
}

/** Zapisz jedno wywolanie. Wolane PRZED zapytaniem, nie po nim. */
export function policzWywolanie(): void {
  const dane = wczytaj();
  zapisz({ dzien: dane.dzien, liczba: dane.liczba + 1 });
}

/** Tylko na potrzeby testow. */
export function zapomnijUzycie(): void {
  pamiec = null;
}
