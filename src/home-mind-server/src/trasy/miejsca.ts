/**
 * Nazwy miejsc, ktorych uzywa sie w domu, przelozone na adresy zrozumiale dla
 * Google.
 *
 * Routes API odpowiada na pytanie A -> B, wiec musi dostac dwa punkty. W mowie
 * pada jeden ("jak dojade do centrum"), a drugim jest zawsze dom. Dlatego dom
 * ma osobny wpis i jest domyslnym poczatkiem trasy.
 *
 * Dopasowanie idzie przez `uprosc()`, bo nazwe podaje model po tym, jak
 * przeszla przez rozpoznawanie mowy - "Sw. Marcina" i "swietego marcina" maja
 * trafic w ten sam wpis. Nazwy nieznane przepuszczamy DALEJ, do Google:
 * geokoder radzi sobie z adresem lepiej niz jakikolwiek slownik, ktory tu
 * napiszemy, a slownik jest tylko skrotem na to, czego geokoder wiedziec nie
 * moze ("praca").
 *
 * Same wpisy pochodza z panelu albo z `.env` - patrz `ustawienia.ts`.
 */

import { uprosc } from "../memory/tekst.js";
import { miejsca as wpisy } from "./ustawienia.js";

/** Klucz uznawany za dom. */
const KLUCZ_DOMU = "dom";

/** Klucze uproszczone, zeby "Praca Lecha" i "praca lecha" byly tym samym. */
function mapa(): Map<string, string> {
  const wynik = new Map<string, string>();
  for (const [nazwa, adres] of Object.entries(wpisy())) {
    wynik.set(uprosc(nazwa).trim(), adres.trim());
  }
  return wynik;
}

/** Adres domu - domyslny poczatek kazdej trasy. `undefined`, gdy nie ustawiony. */
export function adresDomu(): string | undefined {
  return mapa().get(KLUCZ_DOMU);
}

/**
 * Adres dla nazwy miejsca. Nazwa nieznana wraca bez zmian - to najczesciej
 * zwykly adres, ktory Google zgeokoduje sam.
 */
export function adresMiejsca(nazwa: string): string {
  return mapa().get(uprosc(nazwa).trim()) ?? nazwa.trim();
}

/** Znane skroty (po uproszczeniu) - do opisu narzedzia i do diagnostyki. */
export function znaneMiejsca(): string[] {
  return [...mapa().keys()];
}
