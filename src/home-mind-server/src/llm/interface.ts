/**
 * LLM Interface
 *
 * Provider-agnostic interfaces for chat and fact extraction.
 * Concrete implementations (Anthropic, OpenAI, etc.) implement these.
 */

import type { ExtractedFact, Fact } from "../memory/types.js";

/**
 * How the assistant reaches the internet.
 *
 * - `grounding` — the model itself searches, server-side, inside the same
 *   request (Gemini's `googleSearch` tool). One API call, the whole prompt is
 *   sent once: the cheapest and fastest option. Requires a Google project WITH
 *   billing — the free tier lists Search grounding as "Not available" and
 *   rejects such requests with 429 RESOURCE_EXHAUSTED.
 * - `gemini_micro` — we expose our own `web_search` tool and answer it with a
 *   separate, tiny grounded request against a SECOND (billed) key. Lets the
 *   conversation run on a free key while search runs on a billed project, at
 *   the cost of a second full-prompt round-trip.
 * - `tavily` / `brave` — our own `web_search` tool backed by a third-party
 *   search API. Google sees nothing, not even the query; results are raw
 *   snippets rather than a synthesized answer.
 * - `searxng` — the same tool, answered by a SearXNG instance we host
 *   ourselves. No key, no account, no allowance to run out of; the public
 *   engines behind it can rate-limit the house IP, so it works best as the
 *   fallback the metered backends drop into.
 */
export type WebSearchMode = "grounding" | "gemini_micro" | "tavily" | "searxng" | "brave";

export const WEB_SEARCH_MODES: readonly WebSearchMode[] = [
  "grounding",
  "gemini_micro",
  "tavily",
  "searxng",
  "brave",
] as const;

/**
 * How firmly the speaker has been established.
 *
 * - `certain`  a logged-in Home Assistant user made the request
 * - `asserted` someone said who they are ("this is Ania") — trusted, but only
 *              as far as an unverified claim goes
 * - `inferred` a guess from a weak signal: who is home, or later a voice/face
 *              match below its confidence bar
 * - `unknown`  no signal at all — an automation, a shared device, a guest
 *
 * The split exists because a wrong guess has two very different costs. Reading
 * the wrong person's memory leaks it; writing to the wrong person's memory
 * corrupts it, and nothing untangles that afterwards. So personal memory is
 * read only when the speaker is `certain` or `asserted`, and written only then
 * too — a guess gets a name to greet, never a profile to rummage through.
 */
export type IdentityConfidence = "certain" | "asserted" | "inferred" | "unknown";

/** Whether this identity is firm enough to touch a personal memory profile. */
export function trustsProfile(confidence?: IdentityConfidence): boolean {
  return confidence === "certain" || confidence === "asserted";
}

// Chat types (LLM-agnostic)
/**
 * Jedna wypowiedź w turze — czyja jest i co w niej padło.
 *
 * `userId` jest pusty, gdy mówcy nie rozpoznano albo jego odcisk nie pasuje do
 * nikogo z domowników. Taka wypowiedź jest dla modelu KONTEKSTEM, ale nie może
 * niczego zlecić: bez tożsamości nie ma w czyim imieniu działać.
 */
export interface Wypowiedz {
  tekst: string;
  /** Nazwa odcisku głosu z voice-matcha, np. `lech`. */
  mowca?: string | null;
  /** Profil pamięci osoby, gdy odcisk pasuje do kogoś z Ustawień → Osoby. */
  userId?: string | null;
  userName?: string | null;
  rozpoznany?: boolean;
  podobienstwo?: number | null;
}

export interface ChatRequest {
  message: string;
  userId: string;
  conversationId?: string;
  isVoice?: boolean;
  customPrompt?: string;
  /** Entity IDs exposed to Assist in HA; when set, the home layout + device
   *  cheat sheet are restricted to these (keeps unselected entities out of the
   *  prompt). */
  exposedEntities?: string[];
  /** Max web_search calls the model may make per request (HA option). 0 = no
   *  internet; default 1. Higher = more thorough but more LLM round-trips. */
  webSearchLimit?: number;
  /** Token budget for recalled facts sent to the LLM (HA option). 0 = send no
   *  memory at all (and skip the recall round-trip); omitted = server default
   *  (MEMORY_TOKEN_LIMIT). More memory = better personalisation, more tokens
   *  on every single request. */
  memoryTokenLimit?: number;
  /** How the assistant reaches the internet (HA option). See WebSearchMode. */
  webSearchMode?: WebSearchMode;
  /** How sure the caller is about who is speaking. Governs whether personal
   *  memory may be read and whether anything may be written to that profile. */
  identityConfidence?: IdentityConfidence;
  /**
   * Tura rozbita na wypowiedzi poszczególnych mówców.
   *
   * Ustawiane tylko wtedy, gdy w nagraniu był WIĘCEJ NIŻ JEDEN głos — przy jednym
   * mówcy (96% tur) pole nie przychodzi i wszystko działa jak dotąd.
   *
   * SKĄD SIĘ WZIĘŁO. Satelita trzyma mikrofon otwarty, dopóki w pokoju ktoś mówi,
   * więc po komendzie potrafi dokleić telewizor albo rozmowę domowników (zmierzone
   * 16.09: 4% tur dobijało do sufitu 15 s). Wszystko to szło do modelu jako słowa
   * jednej osoby — tej, którą biometria rozpoznała na POCZĄTKU nagrania.
   */
  wypowiedzi?: Wypowiedz[];
  /**
   * Nie wyciągaj faktów z tej wymiany.
   *
   * Dla wywołań wewnętrznych, które nie są rozmową z człowiekiem: kontrola
   * sprzeczności reguł i kontrola pamięci względem reguł. Ich wsadem jest
   * WŁASNY prompt systemu, więc ekstrakcja przepisuje reguły z powrotem do
   * pamięci jako fakty — a to znaczy, że sprawdzacz duplikatów sam produkuje
   * duplikaty, które potem znajduje. Sprzężenie zwrotne, które samo się karmi.
   *
   * `memoryTokenLimit: 0` tego nie załatwia: wyłącza CZYTANIE pamięci, a zapis
   * odbywa się bezwarunkowo po każdej odpowiedzi.
   */
  skipExtraction?: boolean;
  /** Display name of whoever is speaking, when the caller could establish it.
   *  Today it comes from the Home Assistant user behind the request; a voice or
   *  face recogniser could supply it instead. Absent = unidentified, which the
   *  assistant is told to treat as the shared profile rather than guess. */
  userName?: string;
}

/**
 * Structured failure information emitted when chat produces no usable
 * response (no text and no tool call). The HA integration surfaces
 * `hint` to the user instead of the generic "I received your request but
 * got no response." fallback, so failures are diagnosable from HA Assist
 * without needing server logs.
 */
export interface ChatError {
  code:
    | "EMPTY_CONTENT"
    | "MAX_TOKENS_TRUNCATED"
    | "CONTENT_FILTERED";
  hint: string;
}

export interface ChatResponse {
  response: string;
  toolsUsed: string[];
  factsLearned: number;
  error?: ChatError;
}

export type StreamCallback = (chunk: string) => void;

// Provider interfaces
export interface IChatEngine {
  chat(request: ChatRequest, onChunk?: StreamCallback): Promise<ChatResponse>;
}

/**
 * Jedno wywołanie narzędzia razem z argumentami.
 *
 * `ChatResponse.toolsUsed` niesie same nazwy i tak zostaje — czyta je
 * integracja HA, żeby wiedzieć, czy tura coś zrobiła. Do nauki nazwa nie
 * wystarcza: „call_service" nie mówi ani której usługi, ani na czym. Cała
 * wiedza o tym, JAK obsługuje się ten dom, siedzi w argumentach, a te były
 * dotąd wyrzucane zaraz po wywołaniu.
 */
export interface UzyteNarzedzie {
  nazwa: string;
  argumenty: Record<string, unknown>;
}

export interface IFactExtractor {
  extract(
    userMessage: string,
    assistantResponse: string,
    existingFacts?: Fact[]
  ): Promise<ExtractedFact[]>;

  /**
   * Jedno małe zapytanie do modelu, poza ekstrakcją faktów.
   *
   * Opcjonalne z rozmysłem: to nie jest część kontraktu ekstraktora, tylko
   * pożyczenie klienta, który już jest skonfigurowany — inaczej szukanie
   * procedur wymagałoby własnego klienta, własnego klucza w konfiguracji
   * i własnej ścieżki przełączania providera w locie. Brak metody ma
   * wyłączyć tę jedną funkcję, a nie wywrócić ekstrakcję: dlatego wołający
   * sprawdza jej obecność, a atrapy w testach nie muszą jej znać.
   */
  zapytaj?(prompt: string, maxTokens?: number): Promise<string>;
}
