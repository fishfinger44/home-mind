/**
 * Devices only a recognised voice may operate.
 *
 * Everything in the house answers to anyone — lights, music, films — because a
 * guest or a child asking for the lights is not a problem worth solving. These
 * are the exceptions: things that move, run for half an hour, or change the
 * temperature of the house. A stranger's voice, the television, or a
 * transcription of silence should not be able to start them.
 *
 * The list exists because of a real incident. At ten to midnight a hand-clap
 * reached the assistant as "Jeden.", it offered to clean room one, and an
 * unrelated "tak" started the kitchen mop. Nothing in that chain came from a
 * recognised speaker.
 *
 * Which groups are restricted is a household decision, not a code decision, so
 * it is stored in `/data/ograniczenia.json` and edited from the voice panel —
 * the same place people are enrolled. Recognition and what recognition buys are
 * one subject, and splitting them across two screens would mean setting up a
 * voiceprint in one place and finding out what it is for in another.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { envOrUndefined } from "../env.js";

/** Read per call, not once at import: tests point it at a scratch directory. */
function sciezka(): string {
  return envOrUndefined("RESTRICTIONS_PATH") ?? "/data/ograniczenia.json";
}

/**
 * A group of devices as a household thinks of them, rather than as Home
 * Assistant does.
 *
 * Domains alone are not enough. The Roborock routine buttons matter most: they
 * start the vacuum without touching the `vacuum` domain at all, which is
 * exactly how it was started by accident. Restricting the domain alone would
 * leave the door open, and nobody choosing "the vacuum" in a list means "the
 * vacuum, except through its own shortcuts".
 */
export interface GrupaUrzadzen {
  id: string;
  nazwa: string;
  /** One line under the name in the panel, saying what is at stake. */
  opis: string;
  domeny: string[];
  /** Entities outside those domains that belong to the same group anyway. */
  wzory?: RegExp[];
  /** Restricted unless the household says otherwise. */
  domyslnie: boolean;
  /**
   * Whether the calming-services exemption is withheld from this group.
   *
   * That exemption rests on an assumption — that risk travels in one
   * direction, because starting a machine wakes a household and stopping one
   * does not. For the air conditioning the assumption simply fails: switching
   * it off during a heatwave, or in the middle of the night, is as disruptive
   * as switching it on. Where the assumption does not hold, the group is
   * closed in both directions rather than split.
   */
  bezUlgi?: boolean;
}

export const GRUPY_URZADZEN: GrupaUrzadzen[] = [
  {
    id: "odkurzacz",
    nazwa: "Odkurzacz",
    opis: "Także skróty i rutyny Roborocka — tą drogą ruszył przypadkiem.",
    domeny: ["vacuum"],
    wzory: [/^button\..*roborock/i],
    domyslnie: true,
  },
  {
    id: "rolety",
    nazwa: "Rolety",
    opis: "Otwieranie i zamykanie; zatrzymanie zależy od ustawienia niżej.",
    domeny: ["cover"],
    domyslnie: true,
  },
  {
    id: "klimatyzacja",
    nazwa: "Klimatyzacja",
    opis: "Włączanie ORAZ wyłączanie — oba dotkliwe. Odczyt temperatury zostaje dla wszystkich.",
    domeny: ["climate"],
    wzory: [/^switch\.580d0d2f9e31/i],
    domyslnie: true,
    bezUlgi: true,
  },
  {
    id: "swiatlo",
    nazwa: "Światło",
    opis: "Zwykle dostępne dla wszystkich — gość proszący o światło to nie problem.",
    domeny: ["light"],
    domyslnie: false,
  },
  {
    id: "muzyka",
    nazwa: "Muzyka i filmy",
    opis: "Odtwarzacze, Apple TV, projektor. Domyślnie dla wszystkich.",
    domeny: ["media_player"],
    wzory: [/^script\.zagraj/i, /^media_assistant\./i],
    domyslnie: false,
  },
  {
    id: "zamki",
    nazwa: "Zamki i bramy",
    opis: "Nic takiego nie jest teraz wystawione — ustawienie czeka na przyszłość.",
    domeny: ["lock"],
    domyslnie: true,
  },
];

/**
 * Services that only ever calm a device down.
 *
 * Anyone may stop what is already running — a guest who wants the vacuum out
 * of the way, someone who simply finds it too loud. Refusing that would be
 * obstruction rather than safety, and it is the direction of travel that
 * carries the risk: starting a machine is what wakes a household, not stopping
 * one.
 *
 * That reasoning is not universal, which is why `bezUlgi` exists. It does not
 * hold for the air conditioning, where turning it off on a hot night is as
 * unwelcome as turning it on — so that group is closed both ways.
 *
 * Reading is unaffected either way — these rules apply to call_service only,
 * so anyone can still ask what the temperature is.
 */
const USLUGI_USPOKAJAJACE = new Set([
  "turn_off",
  "stop",
  "pause",
  "return_to_base",
  "stop_cover",
  "media_pause",
  "media_stop",
]);

export interface Ograniczenia {
  /** Ids of the groups a stranger's voice may not operate. */
  grupy: string[];
  /** Whether stopping and turning off stay open to everyone. */
  wolnoZatrzymywac: boolean;
  /**
   * Groups taken away from a specific household member, keyed by the id the
   * assistant receives as `userId`.
   *
   * A DENY list, not an allow list, and the household chose it that way
   * (2026-08-08): being recognised keeps meaning what it has always meant, so
   * enrolling somebody never quietly narrows what they could already do, and
   * existing people needed no migration. The cost is the other direction —
   * enrolling a child opens everything to them until somebody unticks a box —
   * so the panel says so on the tab of anyone with no entry here.
   *
   * The key is whatever `userId` the request carries. For voice that is the
   * Home Assistant person id (`lech`, `wladek`), because the integration maps
   * the voiceprint through `person.*`. A phone logged into Home Assistant
   * sends the account uuid instead and so has no entry — which is correct: an
   * account holder has already authenticated themselves, and this list is
   * about voices.
   */
  osoby?: Record<string, string[]>;
}

export function domyslneOgraniczenia(): Ograniczenia {
  return {
    grupy: GRUPY_URZADZEN.filter((g) => g.domyslnie).map((g) => g.id),
    wolnoZatrzymywac: true,
    osoby: {},
  };
}

/** Keep only real group ids, and drop people left with nothing taken away. */
function czysteOsoby(surowe: unknown): Record<string, string[]> {
  if (!surowe || typeof surowe !== "object" || Array.isArray(surowe)) return {};
  const wynik: Record<string, string[]> = {};
  for (const [osoba, grupy] of Object.entries(surowe as Record<string, unknown>)) {
    if (!osoba || !Array.isArray(grupy)) continue;
    const znane = GRUPY_URZADZEN.filter((g) => grupy.includes(g.id)).map((g) => g.id);
    if (znane.length > 0) wynik[osoba] = znane;
  }
  return wynik;
}

let cache: Ograniczenia | null = null;

export function wczytajOgraniczenia(): Ograniczenia {
  if (cache) return cache;
  if (!existsSync(sciezka())) {
    cache = domyslneOgraniczenia();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(sciezka(), "utf-8"));
    cache = {
      grupy: Array.isArray(parsed?.grupy)
        ? parsed.grupy.filter((id: unknown) => GRUPY_URZADZEN.some((g) => g.id === id))
        : domyslneOgraniczenia().grupy,
      wolnoZatrzymywac: parsed?.wolnoZatrzymywac !== false,
      osoby: czysteOsoby(parsed?.osoby),
    };
    return cache;
  } catch (err) {
    // A broken file must not lock the house down, nor throw it open: fall back
    // to the defaults, which are the settings the household chose out loud.
    console.error(`[ograniczenia] nie mogę odczytać ${sciezka()}:`, err);
    cache = domyslneOgraniczenia();
    return cache;
  }
}

export function zapiszOgraniczenia(nowe: Ograniczenia): Ograniczenia {
  const czyste: Ograniczenia = {
    grupy: GRUPY_URZADZEN.filter((g) => nowe.grupy?.includes(g.id)).map((g) => g.id),
    wolnoZatrzymywac: nowe.wolnoZatrzymywac !== false,
    osoby: czysteOsoby(nowe.osoby),
  };
  mkdirSync(dirname(sciezka()), { recursive: true });
  writeFileSync(sciezka(), JSON.stringify(czyste, null, 2), "utf-8");
  cache = czyste;
  const odebrane = Object.entries(czyste.osoby ?? {})
    .map(([osoba, grupy]) => `${osoba}: -${grupy.join("/")}`)
    .join(", ");
  console.log(
    `[ograniczenia] zapisane: ${czyste.grupy.join(", ") || "brak"}` +
      (odebrane ? ` | odebrane osobom — ${odebrane}` : "")
  );
  return czyste;
}

/** Test seam: drop the cache so the next read hits the disk again. */
export function resetRestrictionsCache(): void {
  cache = null;
}

export interface RestrictionVerdict {
  allowed: boolean;
  /** What to tell the model, in the language it answers in. */
  reason?: string;
}

/** Which of `kandydaci` this call touches, by domain, entity domain or pattern. */
function trafionaGrupa(
  domain: string | undefined,
  entityId: string | undefined,
  kandydaci: GrupaUrzadzen[]
): GrupaUrzadzen | undefined {
  const encje = (entityId ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return kandydaci.find((g) => {
    if (domain && g.domeny.includes(domain.toLowerCase())) return true;
    return encje.some(
      (e) =>
        g.domeny.includes(e.split(".")[0]?.toLowerCase() ?? "") ||
        (g.wzory ?? []).some((w) => w.test(e))
    );
  });
}

export function checkRestriction(
  domain: string | undefined,
  service: string | undefined,
  entityId: string | undefined,
  speakerRecognised: boolean,
  /**
   * Who is asking, when we know. Only consulted for a recognised speaker —
   * an unrecognised voice is judged by `grupy` alone, whoever it claims to be.
   */
  mowca?: string
): RestrictionVerdict {
  const ustawienia = wczytajOgraniczenia();

  if (speakerRecognised) {
    // Being recognised is no longer a master key. It still means "not the
    // television", which is what `grupy` guards; this second list is about
    // which household member, and exists so the children can be enrolled —
    // for their own memory and personality — without that enrolment handing
    // them the vacuum and the air conditioning.
    const odebrane = mowca ? (ustawienia.osoby?.[mowca] ?? []) : [];
    if (odebrane.length === 0) return { allowed: true };

    const zabroniona = trafionaGrupa(
      domain,
      entityId,
      GRUPY_URZADZEN.filter((g) => odebrane.includes(g.id))
    );
    if (!zabroniona) return { allowed: true };

    // Bez ulgi „wolno zatrzymywać" — decyzja domu z 08.08: brak uprawnienia do
    // grupy znaczy brak dotyku w obie strony. Ulga została pomyślana dla
    // OBCEGO, o którym nie wiemy nic poza tym, że stoi w pokoju; tutaj wiemy
    // dokładnie, kto pyta, i to jemu ta grupa została odebrana świadomie.
    return {
      allowed: false,
      reason:
        `Odmowa: „${zabroniona.nazwa}” nie jest dostępna dla tego domownika. ` +
        "Dotyczy to zarówno włączania, jak i wyłączania; odczyt stanu jest dozwolony. " +
        "Powiedz to użytkownikowi wprost, nie tłumacz się nierozpoznaniem głosu " +
        "i nie szukaj innej drogi do tego samego urządzenia.",
    };
  }

  const trafiona = trafionaGrupa(
    domain,
    entityId,
    GRUPY_URZADZEN.filter((g) => ustawienia.grupy.includes(g.id))
  );

  if (!trafiona) return { allowed: true };

  // Ulga rozstrzyga się dopiero tutaj, bo zależy od grupy: klimatyzacja jest
  // zamknięta w obie strony, reszta tylko w kierunku uruchomienia.
  const uspokajajaca = !!service && USLUGI_USPOKAJAJACE.has(service.toLowerCase());
  if (uspokajajaca && ustawienia.wolnoZatrzymywac && !trafiona.bezUlgi) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `Odmowa: „${trafiona.nazwa}” obsługuje tylko rozpoznany domownik, ` +
      "a tego głosu nie rozpoznałem. " +
      (trafiona.bezUlgi
        ? "Dotyczy to zarówno włączania, jak i wyłączania. Odczyt stanu jest dozwolony dla każdego. "
        : ustawienia.wolnoZatrzymywac
          ? "Zatrzymanie i wyłączenie są dozwolone dla każdego, podobnie jak odczyt stanu. "
          : "Odczyt stanu jest dozwolony dla każdego. ") +
      "Powiedz to użytkownikowi wprost i nie szukaj innej drogi do tego samego urządzenia.",
  };
}
