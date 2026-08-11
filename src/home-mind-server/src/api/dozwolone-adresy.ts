import type { Request, Response, NextFunction } from "express";

/**
 * Bramka adresowa dla API.
 *
 * Powód: `identityConfidence` przy `POST /api/chat` jest parametrem OD
 * WOŁAJĄCEGO, więc bramka na dane osobowe jest uczciwa dla ścieżki głosowej i
 * tylko doradcza dla zwykłego HTTP. Dopóki `API_TOKEN` jest pusty, jedynym
 * realnym ograniczeniem jest to, SKĄD przyszło zapytanie.
 *
 * Adres bierzemy z gniazda (`req.socket.remoteAddress`), a nie z `req.ip`.
 * `req.ip` czyta `X-Forwarded-For`, gdy włączone jest `trust proxy` — dziś nie
 * jest, ale gdyby kiedyś było, nagłówek od klienta przechodziłby przez bramkę
 * jak przez papier. Serwer stoi w `network_mode: host`, więc adres gniazda to
 * prawdziwy adres klienta; nie ma pośrednika, którego trzeba by rozwijać.
 */

type Wpis =
  | { rodzaj: "ipv4"; siec: number; maska: number }
  | { rodzaj: "ipv6"; adres: string };

/** IPv4 jako liczba; null gdy to nie jest czwórka bajtów. */
function naLiczbe(ip: string): number | null {
  const czesci = ip.split(".");
  if (czesci.length !== 4) return null;
  let wynik = 0;
  for (const c of czesci) {
    if (!/^\d{1,3}$/.test(c)) return null;
    const b = Number(c);
    if (b > 255) return null;
    wynik = wynik * 256 + b;
  }
  return wynik;
}

/**
 * Sprowadza adres z gniazda do postaci porównywalnej z listą.
 * Node oddaje adres IPv4 przez gniazdo IPv6 jako `::ffff:192.168.88.10` —
 * dla listy to ma być zwykłe `192.168.88.10`. Zdejmujemy też `%eth0` (strefa).
 */
export function znormalizujAdres(adres: string): string {
  let a = adres.trim().toLowerCase();
  const strefa = a.indexOf("%");
  if (strefa !== -1) a = a.slice(0, strefa);
  if (a.startsWith("::ffff:") && naLiczbe(a.slice(7)) !== null) return a.slice(7);
  return a;
}

/**
 * Rozbiera jeden wpis listy: `192.168.88.227`, `192.168.88.0/24` albo `::1`.
 * Zwraca null dla wpisu, którego nie umiemy rozebrać — wołający MUSI to
 * potraktować jak błąd konfiguracji, a nie po cichu pominąć.
 */
export function rozbierzWpis(tekst: string): Wpis | null {
  const wpis = tekst.trim().toLowerCase();
  if (!wpis) return null;

  const ukosnik = wpis.indexOf("/");
  if (ukosnik === -1) {
    const liczba = naLiczbe(wpis);
    if (liczba !== null) return { rodzaj: "ipv4", siec: liczba, maska: 32 };
    // Wszystko inne traktujemy jak literał IPv6 — porównywany dosłownie, więc
    // musi być zapisany dokładnie tak, jak oddaje go gniazdo (`::1`).
    if (/^[0-9a-f:]+$/.test(wpis) && wpis.includes(":")) {
      return { rodzaj: "ipv6", adres: wpis };
    }
    return null;
  }

  const baza = naLiczbe(wpis.slice(0, ukosnik));
  const maska = Number(wpis.slice(ukosnik + 1));
  if (baza === null || !Number.isInteger(maska) || maska < 0 || maska > 32) return null;
  // Zerujemy bity poza maską, żeby `192.168.88.5/24` znaczyło to samo co
  // `192.168.88.0/24` zamiast nie łapać niczego.
  const bity = maska === 0 ? 0 : (0xffffffff << (32 - maska)) >>> 0;
  return { rodzaj: "ipv4", siec: (baza & bity) >>> 0, maska };
}

/**
 * Rozbiera całą listę z `API_ALLOWLIST`. Rzuca wyjątkiem przy złym wpisie —
 * lista, z której cicho wypadł adres, jest gorsza niż jej brak: dopuszczałaby
 * mniej, niż widać w konfiguracji, albo (przy literówce w jedynym wpisie)
 * zamykała pulpity bez śladu w logu.
 */
export function rozbierzListe(lista: string): Wpis[] {
  const wpisy: Wpis[] = [];
  const zle: string[] = [];
  for (const kawalek of lista.split(",")) {
    const tekst = kawalek.trim();
    if (!tekst) continue;
    const wpis = rozbierzWpis(tekst);
    if (wpis) wpisy.push(wpis);
    else zle.push(tekst);
  }
  if (zle.length > 0) {
    throw new Error(`API_ALLOWLIST — nie rozumiem wpisów: ${zle.join(", ")}`);
  }
  return wpisy;
}

/** Czy adres mieści się w którymkolwiek wpisie listy. */
export function adresDozwolony(adres: string, wpisy: Wpis[]): boolean {
  const a = znormalizujAdres(adres);
  const liczba = naLiczbe(a);
  for (const wpis of wpisy) {
    if (wpis.rodzaj === "ipv6") {
      if (wpis.adres === a) return true;
      continue;
    }
    if (liczba === null) continue;
    const bity = wpis.maska === 0 ? 0 : (0xffffffff << (32 - wpis.maska)) >>> 0;
    if (((liczba & bity) >>> 0) === wpis.siec) return true;
  }
  return false;
}

/**
 * Middleware. Przy pustej liście przepuszcza wszystko (tak jak było) — decyzja
 * o zamknięciu API należy do konfiguracji, nie do kodu.
 * `/health` zostaje publiczne, bo po nim poznaje się, czy usługa żyje.
 */
export function utworzBramkeAdresow(
  lista: string | undefined
): (req: Request, res: Response, next: NextFunction) => void {
  const wpisy = lista ? rozbierzListe(lista) : [];

  return (req: Request, res: Response, next: NextFunction) => {
    if (wpisy.length === 0) return next();
    if (req.path === "/health") return next();

    const zrodlo = req.socket.remoteAddress;
    if (zrodlo && adresDozwolony(zrodlo, wpisy)) return next();

    // Logujemy każde odrzucenie: jeśli po zmianie listy przestanie działać
    // pulpit na telefonie, w logu ma stać jego adres, a nie cisza.
    console.warn(
      `Bramka adresowa: odrzucone ${req.method} ${req.originalUrl} z ${zrodlo ?? "nieznanego adresu"}`
    );
    res.status(403).json({
      error: "Adres spoza listy dozwolonych",
      address: zrodlo ? znormalizujAdres(zrodlo) : null,
    });
  };
}
