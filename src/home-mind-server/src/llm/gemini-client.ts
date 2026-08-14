// Native Gemini chat engine.
//
// Talks to the *native* Gemini API (generateContent) rather than the
// OpenAI-compatibility layer, because Grounding with Google Search
// (`googleSearch` built-in tool) is only available natively. On Gemini 3 the
// built-in search tool can be combined with our HA function tools in a single
// request (requires toolConfig.includeServerSideToolInvocations), so the model
// searches the web server-side — no separate Tavily/Brave round-trip — while
// still driving Home Assistant. The OpenAI-compat engine remains the default
// for Anthropic/Ollama and for OpenAI-compatible Gemini without grounding.

import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { SHARED_PROFILE_ID } from "../memory/types.js";
import { rulesForPrompt } from "../rules/store.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPromptText, buildVolatileBlock } from "./prompts.js";
import { TOOL_DEFINITIONS, toGeminiTools } from "./tool-definitions.js";
import { handleToolCall, extractAndStoreFacts, recallFacts } from "./tool-handler.js";
import type { KontekstPamieci } from "./tool-handler.js";
import { trustsProfile } from "./interface.js";
import { zdecyduj } from "./router-rozmowy.js";
import type { WebSearchSettings } from "./tool-handler.js";
import type {
  ChatRequest,
  ChatResponse,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
  UzyteNarzedzie,
} from "./interface.js";
import { envOrUndefined } from "../env.js";

const NATIVE_BASE =
  envOrUndefined("GEMINI_NATIVE_BASE_URL") ??
  "https://generativelanguage.googleapis.com/v1beta";

const MAX_TOOL_ITERATIONS = 8;

// Sciezka ROZMOWNA jest widoczna dla modelu tylko wtedy, gdy jest i adres
// shima, i wlacznik. Zestawy narzedzi licza sie RAZ, ale wybor nastepuje przy
// kazdym zapytaniu — dzieki temu przelacznik z UI dziala od razu, bez restartu.
// 🔑 Gdy sciezka jest wylaczona, `odpowiedz_rozmowa` nie trafia do definicji,
// wiec model go NIE WIDZI i zachowanie asystenta jest jak przed ta zmiana.
const BEZ_ROZMOWY = TOOL_DEFINITIONS.filter((t) => t.name !== "odpowiedz_rozmowa");

// With grounding, the model searches server-side via googleSearch, so our own
// web_search tool is redundant and is left out. In every other search mode
// (micro-call / Tavily / Brave) it is the only way to the internet, so it stays.
const HA_FUNCTION_TOOLS = toGeminiTools(BEZ_ROZMOWY.filter((t) => t.name !== "web_search"));
const HA_FUNCTION_TOOLS_WITH_SEARCH = toGeminiTools(BEZ_ROZMOWY);
const HA_FUNCTION_TOOLS_ROZMOWA = toGeminiTools(
  TOOL_DEFINITIONS.filter((t) => t.name !== "web_search")
);
const HA_FUNCTION_TOOLS_WITH_SEARCH_ROZMOWA = toGeminiTools(TOOL_DEFINITIONS);

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
  thoughtSignature?: string;
  [k: string]: unknown;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: unknown[] };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/**
 * Sklej porcje strumienia w te same `parts`, ktore dalby jeden zwykly request.
 *
 * 🔴 TO JEST NAJRYZYKOWNIEJSZY KAWALEK STRUMIENIOWANIA GEMINI i dlatego siedzi
 * osobno, pod testami. Powod: przy odpowiedzi z narzedziami tura modelu jest
 * ODSYLANA Z POWROTEM DOSLOWNIE, bo `parts` niosa `thoughtSignature`, ktorego
 * Gemini 3 wymaga przy kontynuacji. Zgubienie go albo rozbicie jednego
 * `functionCall` na dwa konczy sie bledem 400 przy nastepnym przebiegu —
 * czyli awaria daleko od przyczyny.
 *
 * ⚠️ Tekst SKLEJAMY, `functionCall` NIGDY. To nie jest symetria dla urody:
 * tekst przychodzi po kawalku i ma byc jednym akapitem, a kazde wywolanie
 * narzedzia jest osobnym zadaniem. Sklejenie dwoch wywolan w jedno to dokladnie
 * awaria „puste odpowiedzi przy sterowaniu wieloma encjami", ktora kosztowala
 * nas `splitConcatenatedJson()` po stronie OpenAI-compat.
 *
 * `onTekst` dostaje WYLACZNIE tekst przeznaczony dla czlowieka — czesci
 * oznaczone jako `thought` sa zbierane, ale nie wypowiadane.
 */
export function scalCzesci(
  zebrane: GeminiPart[],
  nowe: GeminiPart[] | undefined,
  onTekst?: (kawalek: string) => void
): void {
  for (const czesc of nowe ?? []) {
    const mysl = czesc.thought === true;
    if (czesc.functionCall) {
      zebrane.push({ ...czesc });
      continue;
    }
    if (typeof czesc.text === "string") {
      const ostatnia = zebrane[zebrane.length - 1];
      const mozeDolaczyc =
        ostatnia !== undefined &&
        !ostatnia.functionCall &&
        typeof ostatnia.text === "string" &&
        (ostatnia.thought === true) === mysl;
      if (mozeDolaczyc) {
        ostatnia.text += czesc.text;
        // Podpis potrafi przyjsc dopiero z pozniejsza porcja tej samej czesci.
        if (czesc.thoughtSignature) ostatnia.thoughtSignature = czesc.thoughtSignature;
      } else {
        zebrane.push({ ...czesc });
      }
      if (!mysl && czesc.text && onTekst) onTekst(czesc.text);
      continue;
    }
    // Czesc bez tekstu i bez wywolania (np. sam `thoughtSignature`) — dopinamy
    // do ostatniej, zeby nie zgubic pola wymaganego przy kontynuacji.
    const ostatnia = zebrane[zebrane.length - 1];
    if (ostatnia && czesc.thoughtSignature) {
      ostatnia.thoughtSignature = czesc.thoughtSignature;
    } else {
      zebrane.push({ ...czesc });
    }
  }
}

/**
 * How long to wait before retrying a 429.
 *
 * Google returns a RetryInfo with a `retryDelay` like "27s" for per-minute rate
 * limits; when it does, honour it — guessing shorter just burns another request
 * against the same window. Without it, back off 2s / 6s / 15s: enough to clear a
 * 10-requests-per-minute free-tier window on the second or third try while
 * staying well inside the HA integration's 120s timeout.
 */
export function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds, 30) * 1000;
  }
  return [2000, 6000, 15000][Math.min(attempt - 1, 2)];
}

/** Seconds from a Gemini error body's RetryInfo, when it carries one. */
export function parseRetryDelay(body: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Number(m[1]) : undefined;
}

const MAX_429_ATTEMPTS = 3;

/** Kody, po ktorych warto sprobowac jeszcze raz — usterka jest po stronie
 *  Google i mija sama. ⛔ NIE dopisywac tu 4xx: te znacza, ze zadanie jest zle
 *  i ponawianie go tylko przedluza czekanie czlowieka. */
const PONAWIALNE = new Set([500, 502, 503, 504]);
const MAX_PRZEJSCIOWE_PROBY = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiChatEngine implements IChatEngine {
  private config: Config;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;

  /** Ktore rozmowy mialy OSTATNIA ture na sciezce rozmownej.
   *
   *  Potrzebne wczesnemu routerowi do rozpoznania kontynuacji: „nie wiem" po
   *  zagadce ma zostac na rozmowie, ale „tak" po pytaniu asystenta „czy zgasic
   *  swiatlo?" absolutnie nie. Bez tej pamieci obu przypadkow nie da sie
   *  odroznic, bo tekst wypowiedzi jest w obu tak samo ubogi.
   *
   *  ⚠️ Zyje w PAMIECI PROCESU i ginie przy odtworzeniu silnika (zmiana modelu,
   *  przelacznik w HA). To jest w porzadku: brak wpisu znaczy „nie wiem", a
   *  „nie wiem" prowadzi stara droga — czyli w bezpieczna strone. */
  private ostatniaTuraRozmowna = new Map<string, boolean>();

  constructor(
    config: Config,
    memory: IMemoryStore,
    conversations: IConversationStore,
    extractor: IFactExtractor,
    ha: HomeAssistantClient,
    scanner: DeviceScanner,
    topology: TopologyScanner
  ) {
    this.config = config;
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  async chat(request: ChatRequest, onChunk?: StreamCallback): Promise<ChatResponse> {
    const { message, userId, conversationId, isVoice = false, customPrompt, skipExtraction } = request;
    const toolsUsed: string[] = [];
    // Te same wywołania z argumentami — `toolsUsed` zostaje listą nazw, bo
    // czyta ją integracja HA; nauka potrzebuje szczegółów, patrz UzyteNarzedzie.
    const wywolania: UzyteNarzedzie[] = [];

    // 1. Recall facts
    // Personal memory is only for a speaker we are sure of: a guess that turns
    // out wrong would otherwise read one person's memories out to another.
    const trustedIdentity = trustsProfile(request.identityConfidence ?? "certain");
    const factContents = await recallFacts(
      this.memory,
      userId,
      message,
      request.memoryTokenLimit,
      this.config.memoryTokenLimit,
      trustedIdentity,
      SHARED_PROFILE_ID
    );

    // `sprawdz_pamiec` reads through the same gate as the block above — same
    // profile, same budget, same `trustedIdentity`. Built here rather than in
    // the tool loop so the two can never drift into disagreeing about who the
    // speaker is allowed to be.
    const kontekstPamieci: KontekstPamieci = {
      memory: this.memory,
      userId,
      limit: request.memoryTokenLimit ?? this.config.memoryTokenLimit,
      allowPersonal: trustedIdentity,
      sharedUserId: SHARED_PROFILE_ID,
    };

    // 2. Refresh device/topology, build system prompt
    await Promise.all([this.scanner.refreshIfStale(), this.topology.refreshIfStale()]);
    const exposed = request.exposedEntities?.length
      ? new Set(request.exposedEntities)
      : undefined;
    const deviceCheatSheet = this.scanner.hasProfiles()
      ? this.scanner.formatCheatSheet(exposed)
      : undefined;
    const homeLayout = this.topology.hasLayout()
      ? this.topology.formatSection(exposed)
      : undefined;
    const systemPromptText = buildSystemPromptText(
      isVoice,
      customPrompt,
      deviceCheatSheet,
      homeLayout,
      request.webSearchLimit,
      rulesForPrompt()
    );
    const blokZmienny = buildVolatileBlock(factContents, request.userName, trustedIdentity);

    const webSearchEnabled = (request.webSearchLimit ?? 1) > 0;
    const searchMode = request.webSearchMode ?? this.config.webSearchMode ?? "grounding";
    // Grounding is the only mode handled inside the model's own request; the rest
    // are answered by our web_search tool in the tool loop.
    let useGrounding = webSearchEnabled && searchMode === "grounding";
    const searchSettings: WebSearchSettings = {
      mode: searchMode,
      searchApiKey: this.config.geminiSearchApiKey,
    };

    console.log(
      `[prompt] system~${Math.ceil(systemPromptText.length / 4)}tok ` +
        `facts=${factContents.length} exposed=${request.exposedEntities?.length ?? "none"} ` +
        `search=${webSearchEnabled ? (useGrounding ? "grounding" : searchMode) : "off"}`
    );

    // 3. Assemble conversation contents
    const contents: GeminiContent[] = [];
    // Wyciagniete z bloku `if`, bo tej samej historii potrzebuje sciezka
    // rozmowna w petli narzedzi nizej.
    let historiaRozmowy: { role: string; content: string }[] = [];
    if (conversationId) {
      // 20, bo tyle trzyma magazyn rozmow — nizsza wartosc byla CICHYM SUFITEM
      // nad `ROZMOWA_TUR`: podniesienie tamtego powyzej 10 nie dawalo nic, bo
      // nie bylo czego kroic. Zlapane 15.08 na rundzie zagadek, w ktorej
      // asystent zgubil wlasna zagadke i pytal „czy to byly slowa z naszej
      // zagadki?".
      historiaRozmowy = await this.conversations.getConversationHistory(conversationId, 20);
      for (const msg of historiaRozmowy) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }
    // The volatile block rides on THIS turn only, and what gets stored above is
    // the bare message. Keeping it out of the history is what makes the history
    // itself part of the stable prefix — otherwise every past turn would carry
    // a stale timestamp and yesterday's recalled facts, and the whole
    // conversation would have to be re-read each time.
    contents.push({ role: "user", parts: [{ text: `${blokZmienny}\n\n${message}` }] });

    const systemInstruction = { parts: [{ text: systemPromptText }] };
    // Sciezka rozmowna wymaga OBU rzeczy: adresu shima (infrastruktura, .env)
    // i wlacznika (preferencja, przelaczana z HA bez restartu).
    const rozmowaAktywna =
      Boolean(this.config.rozmowaUrl) && this.config.rozmowaWlaczona !== false;
    // Decyzja wczesnego routera. Liczona TUTAJ, bo potrzebna w dwoch miejscach:
    // do skrotu ponizej i do zestawu narzedzi tuz obok.
    const ostatniaAsystenta = [...historiaRozmowy].reverse().find((w) => w.role === "assistant");
    const decyzjaRouteru = zdecyduj(message, {
      poprzedniaNaRozmowie: conversationId
        ? this.ostatniaTuraRozmowna.get(conversationId) === true
        : false,
      asystentPytal: (ostatniaAsystenta?.content ?? "")
        .trim()
        .replace(/["'”’)\]]+$/, "")
        .endsWith("?"),
    });

    const buildTools = (): unknown[] => {
      const zSzukaniem = webSearchEnabled && !useGrounding;
      // 🔴 WETO ODBIERA MODELOWI NARZEDZIE ROZMOWNE, a nie tylko blokuje nasz
      // skrot. Zmierzone 14.08: przy „opowiedz zart i sprawdz czy okno w salonie
      // jest zamkniete" model sam wywolal `odpowiedz_rozmowa` — wbrew opisowi
      // tego narzedzia, ktory tego zabrania — i okno nie zostalo sprawdzone,
      // a czlowiek uslyszal gladkie „nie mam dostepu do sterowania domem".
      // Opis narzedzia okazal sie prosba, nie bariera. To jest bariera.
      const zRozmowa = rozmowaAktywna && !decyzjaRouteru.wetoDomowe;
      const set = zRozmowa
        ? (zSzukaniem ? HA_FUNCTION_TOOLS_WITH_SEARCH_ROZMOWA : HA_FUNCTION_TOOLS_ROZMOWA)
        : (zSzukaniem ? HA_FUNCTION_TOOLS_WITH_SEARCH : HA_FUNCTION_TOOLS);
      return useGrounding ? [set, { googleSearch: {} }] : [set];
    };
    let tools = buildTools();
    if (rozmowaAktywna && decyzjaRouteru.wetoDomowe) {
      console.log(`[rozmowa] ${decyzjaRouteru.powod} — narzedzie rozmowne zdjete z tej tury`);
    }

    // 4. Tool loop
    let responseText = "";
    const groundingQueries: string[] = [];
    let iterations = 0;
    let forceAnswer = false;
    // Ustawiane, gdy ta tura poszla na sciezke rozmowna — wtedy `responseText`
    // jest juz gotowy i petla narzedzi nie ma nic wiecej do zrobienia.
    let przekazaneDoRozmowy = false;
    // 🔴 Ustawiane, gdy kawalki poszly juz przez `onChunk` ze sciezki rozmownej.
    // Bez tego domykajace `onChunk(responseText)` nizej wyslaloby CALA odpowiedz
    // DRUGI RAZ, a odbiorca (HA) sklejalby ja z juz wypowiedziana — czyli
    // asystent powtarzalby sam siebie.
    let juzStrumieniowane = false;

    // WCZESNY ROUTER — skrot omijajacy decyzje modelu.
    //
    // 🔑 Stoi TUTAJ, a nie przed wejsciem do silnika, celowo: dalej jestesmy
    // w `chat()`, wiec zapis tury do historii i `extractAndStoreFacts` ponizej
    // dzialaja bez zmian. Gdyby skrot siedzial wyzej i omijal silnik, ekstrakcja
    // pamieci zniknelaby po cichu — a rozmowa jest wlasnie tym miejscem, gdzie
    // padaja fakty osobiste. (Ta sama zasada, co przy przekazaniu z petli.)
    //
    // Kosztuje zero wywolan sieciowych. Gdy nie ma pewnosci, nic nie robi
    // i tura idzie stara droga — patrz `router-rozmowy.ts`.
    if (rozmowaAktywna) {
      if (decyzjaRouteru.naRozmowe) {
        console.log(`[rozmowa] router skraca: ${decyzjaRouteru.powod}`);
        const odpowiedzRozmowy = await this.zapytajRozmowa(
          message,
          factContents,
          historiaRozmowy,
          request.userName,
          trustedIdentity,
          conversationId,
          onChunk
        );
        if (odpowiedzRozmowy) {
          responseText = odpowiedzRozmowy;
          juzStrumieniowane = !!onChunk;
          przekazaneDoRozmowy = true;
        } else {
          // Shim padl. NIE odpowiadamy sami i nie zostawiamy czlowieka z niczym
          // — po prostu wchodzimy w normalna petle, gdzie Gemini odpowie jak
          // przed istnieniem tego skrotu.
          console.warn("[rozmowa] shim niedostepny — wracam na normalna sciezke");
        }
      }
    }

    while (!przekazaneDoRozmowy) {
      let data: GeminiResponse;
      try {
        data = await this.generate(
          systemInstruction,
          contents,
          forceAnswer ? undefined : tools,
          isVoice,
          !useGrounding,
          // Strumien tylko wtedy, gdy jest komu oddawac kawalki i nie zostal
          // wylaczony w `.env`. Wylacznik jest tu celowo: to najmlodsza czesc
          // tej sciezki, a `GEMINI_STREAM=false` przywraca stare zachowanie
          // bez przebudowy obrazu.
          onChunk && this.config.geminiStream !== false
            ? (kawalek) => {
                juzStrumieniowane = true;
                onChunk(kawalek);
              }
            : undefined
        );
      } catch (err) {
        // A key whose Google project has no Search grounding (the free tier lists
        // it as "Not available") rejects the whole request with 429 — including the
        // Home Assistant part of it. Rather than fail the turn, drop grounding and
        // retry with our own web_search tool, which any mode can serve.
        if (useGrounding && /Gemini API error 429/.test(String(err))) {
          console.warn(
            "[gemini] grounding rejected with 429 — this key's project has no Google Search " +
              "grounding. Retrying without it; set the search mode to gemini_micro, tavily or brave."
          );
          useGrounding = false;
          tools = buildTools();
          continue;
        }
        throw err;
      }

      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const gm = cand?.groundingMetadata;
      if (gm?.webSearchQueries?.length) groundingQueries.push(...gm.webSearchQueries);

      const u = data.usageMetadata;
      if (u) {
        console.log(
          `[usage] prompt=${u.promptTokenCount ?? 0} ` +
            `(cached=${u.cachedContentTokenCount ?? 0}) ` +
            `completion=${u.candidatesTokenCount ?? 0} total=${u.totalTokenCount ?? 0}`
        );
      }

      const functionCalls = parts.filter((p) => p.functionCall);
      const text = parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text)
        .join("");

      if (functionCalls.length === 0 || forceAnswer) {
        responseText = text;
        break;
      }

      iterations++;

      // Nazwy narzedzi na poziomie `info`, a nie `debug`.
      //
      // 🔑 Powod jest konkretny: gdy tura „jak go jeszcze mozna rozweselic?"
      // zajela 13,1 s i trzy przebiegi LLM, z logu NIE DALO SIE odczytac, co
      // model wolal — bo lecial tam tylko `[usage]`. Liczba przebiegow bez ich
      // powodu nie nadaje sie do niczego poza zgadywaniem.
      console.log(
        `[llm] przebieg ${iterations}, wywolania: ` +
          functionCalls.map((p) => p.functionCall!.name).join(", ")
      );

      // Echo the model turn back VERBATIM (parts include thoughtSignature, which
      // Gemini 3 requires on the follow-up), then answer each function call.
      contents.push({ role: "model", parts });

      const responseParts: GeminiPart[] = [];
      for (const p of functionCalls) {
        const fc = p.functionCall!;
        toolsUsed.push(fc.name);
        wywolania.push({ nazwa: fc.name, argumenty: fc.args ?? {} });

        // 🔑 Sciezka ROZMOWNA. Wychodzimy z petli z ustawionym `responseText`,
        // a NIE omijamy silnika — dzieki temu caly kod ponizej dziala bez
        // zmian: zapis tury do historii, `extractAndStoreFacts`, `trustedIdentity`,
        // `toolsUsed`. Gdyby home-mind wolal shim z zewnatrz, ekstrakcja
        // pamieci zostalaby po cichu pominieta, a rozmowa jest wlasnie tym
        // miejscem, gdzie padaja fakty osobiste.
        if (fc.name === "odpowiedz_rozmowa") {
          console.log(`[rozmowa] przekazuje: ${String(fc.args?.powod ?? "bez powodu")}`);
          const odpowiedzRozmowy = await this.zapytajRozmowa(
            message,
            factContents,
            historiaRozmowy,
            request.userName,
            trustedIdentity,
            conversationId,
            onChunk
          );
          if (odpowiedzRozmowy) {
            responseText = odpowiedzRozmowy;
            juzStrumieniowane = !!onChunk;
            przekazaneDoRozmowy = true;
            break;
          }
          // Shim padl albo nie zdazyl. Nie zostawiamy czlowieka bez odpowiedzi:
          // oddajemy sterowanie Gemini z jawna informacja, zeby odpowiedzial sam.
          console.warn("[rozmowa] shim niedostepny — odpowiada Gemini");
          responseParts.push({
            functionResponse: {
              name: fc.name,
              ...(fc.id ? { id: fc.id } : {}),
              response: {
                result:
                  "Sciezka rozmowna niedostepna. Odpowiedz sam, krotko i po polsku, " +
                  "nie wspominajac o tej usterce.",
              },
            },
          });
          continue;
        }

        const result = await handleToolCall(this.ha, fc.name, fc.args ?? {}, searchSettings, trustedIdentity, userId, kontekstPamieci);
        responseParts.push({
          functionResponse: {
            name: fc.name,
            ...(fc.id ? { id: fc.id } : {}),
            response: { result },
          },
        });
      }
      if (przekazaneDoRozmowy) break;

      contents.push({ role: "user", parts: responseParts });

      if (iterations >= MAX_TOOL_ITERATIONS) {
        console.warn(`[llm] tool loop hit ${MAX_TOOL_ITERATIONS} iterations — forcing a final answer`);
        forceAnswer = true;
      }
    }

    if (groundingQueries.length) {
      console.log(`[gemini] grounded via Google Search: ${JSON.stringify(groundingQueries)}`);
    }

    // 5. Persist + extract facts (fire-and-forget)
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }
    // Slad dla wczesnego routera przy NASTEPNEJ turze — patrz `ostatniaTuraRozmowna`.
    // Zapisujemy zawsze, takze `false`: tura domowa w srodku pogawedki musi
    // ZAMKNAC kontynuacje, inaczej „tak" po pytaniu o zgaszenie swiatla dalej
    // uchodziloby za odpowiedz na zagadke sprzed dwoch tur.
    if (conversationId) {
      // Sufit, bo serwer chodzi tygodniami, a kazde wybudzenie satelity to nowy
      // `conversationId` — bez tego mapa rosnie w nieskonczonosc. Kasujemy
      // najstarszy wpis (Map trzyma kolejnosc wstawiania), a utrata sladu jest
      // nieszkodliwa: brak wpisu = „nie wiem" = stara droga.
      if (this.ostatniaTuraRozmowna.size >= 500) {
        const najstarszy = this.ostatniaTuraRozmowna.keys().next().value;
        if (najstarszy !== undefined) this.ostatniaTuraRozmowna.delete(najstarszy);
      }
      this.ostatniaTuraRozmowna.set(conversationId, przekazaneDoRozmowy);
    }
    // Only a speaker we are sure of gets facts written about them personally: a
    // misattributed fact cannot be untangled later, it simply becomes something
    // the assistant "knows" about the wrong person. A shared device still
    // learns how the house works — just nothing about who was talking.
    // Kontrole wewnetrzne (sprzecznosci regul, kontrola pamieci) podaja tu
    // WLASNY prompt systemu jako wiadomosc. Ekstrakcja przepisalaby reguly do
    // pamieci jako fakty, czyli sprawdzacz duplikatow produkowalby duplikaty.
    if (!skipExtraction) {
      extractAndStoreFacts(
        this.memory,
        this.extractor,
        userId,
        message,
        responseText,
        trustedIdentity,
        SHARED_PROFILE_ID,
        toolsUsed,
        wywolania
      ).catch((err) => console.error("Fact extraction failed:", err));
    }

    // Deliver the whole answer to the streaming callback in one shot (this engine
    // is non-streaming; the HA /api/chat path doesn't require token streaming).
    if (onChunk && responseText && !juzStrumieniowane) onChunk(responseText);

    const error =
      responseText === ""
        ? {
            code: "EMPTY_CONTENT" as const,
            hint:
              "Gemini returned no text. If this recurs, the model may have stopped " +
              "on a tool loop or a safety filter — try rephrasing.",
          }
        : undefined;

    return { response: responseText, toolsUsed, factsLearned: 0, ...(error ? { error } : {}) };
  }

  /**
   * Pyta shim na hoscie, ktory rozmawia przez abonament Claude.
   *
   * Zwraca `null` przy KAZDEJ usterce — brak odpowiedzi nie moze wywrocic tury,
   * bo po drugiej stronie stoi czlowiek i czeka. Wolajacy oddaje wtedy pytanie
   * z powrotem Gemini.
   *
   * ⚠️ Imie rozmowcy jedzie tylko przy `zaufany` — na urzadzeniu wspoldzielonym
   * nie wiadomo, kto mowi, a zle przypisane imie w rozmowie brzmi gorzej niz
   * jego brak. Ta sama zasada, co przy zapisie faktow osobistych.
   */
  private async zapytajRozmowa(
    pytanie: string,
    fakty: string[],
    historia: { role: string; content: string }[],
    mowca?: string,
    zaufany: boolean = true,
    /** Id rozmowy — shim trzyma po nim ZYWY proces `claude`, wiec kolejne tury
     *  nie placa ~3 s startu obudowy (zmierzone: 1,77 s → 0,78 s do pierwszego
     *  kawalka). Bez id kazda tura dostaje wlasny, jednorazowy proces. */
    rozmowaId?: string,
    /** Gdy podane, kawalki ida na biezaco — to one pozwalaja HA zaczac mowic,
     *  zanim odpowiedz sie skonczy. */
    onChunk?: StreamCallback
  ): Promise<string | null> {
    const adres = this.config.rozmowaUrl;
    if (!adres) return null;
    const start = Date.now();
    try {
      // Strumien tylko wtedy, gdy jest komu oddawac kawalki. Inaczej stara
      // koncowka: jeden JSON, zero roznicy w zachowaniu.
      const koncowka = onChunk ? "/rozmowa/strumien" : "/rozmowa";
      const odp = await fetch(`${adres}${koncowka}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pytanie,
          fakty,
          ...(rozmowaId ? { rozmowa_id: rozmowaId } : {}),
          // ⚠️ Historia z LIMITEM. Jest tu potrzebna (to rozmowa), ale to ta sama
          // droga, ktora zatrula asystenta przy awarii "Echo" — wiec wpuszczamy
          // ostatnie kilka tur, a nie calosc.
          //
          // 🔑 `ROZMOWA_TUR` liczy WIADOMOSCI, nie tury: 6 znaczylo trzy wymiany
          // zdan i to bylo za malo na runde zagadek (asystent gubil wlasna
          // zagadke). Podniesione do 16 = osiem wymian.
          // ⛔ Lawiny „Echo" nie ma tu czym rozpedzic tak jak przy komendach:
          // sciezka rozmowna NIE MA narzedzi, wiec awaria „wywolanie jako
          // tekst" nie istnieje, a zapalnikiem tamtej bylo przekrecone STT —
          // od 15.08 wyraznie czystsze (Scribe Realtime).
          historia: historia.slice(-(this.config.rozmowaTur ?? 6)),
          ...(zaufany && mowca ? { mowca } : {}),
          // Wybor z panelu HA. Pola NIEOBECNE, gdy nikt nic nie wybral —
          // wtedy domyslne poda shim, bo to on wie, co przyjmie `claude`.
          ...(this.config.rozmowaModel ? { model: this.config.rozmowaModel } : {}),
          ...(this.config.rozmowaEffort ? { effort: this.config.rozmowaEffort } : {}),
        }),
        // Shim ma wlasny limit; ten jest o kilka sekund dluzszy, zeby zdazyl
        // odpowiedziec wlasnym, czytelnym bledem zamiast zostac zerwanym.
        signal: AbortSignal.timeout(25_000),
      });
      if (!odp.ok) {
        const tresc = await odp.text().catch(() => "");
        console.error(`[rozmowa] shim zwrocil ${odp.status}: ${tresc.slice(0, 200)}`);
        return null;
      }

      if (!onChunk || !odp.body) {
        const dane = (await odp.json()) as { odpowiedz?: string };
        const tekst = (dane.odpowiedz ?? "").trim();
        console.log(`[rozmowa] odpowiedz w ${((Date.now() - start) / 1000).toFixed(1)} s`);
        return tekst || null;
      }

      // NDJSON: linia na kawalek, `{"koniec":true}` konczy, `{"blad":…}` zglasza
      // usterke.
      // ⚠️ Naglowki poszly PRZED trescia, wiec status 200 NIE znaczy, ze tura
      // sie udala — blad moze przyjsc dopiero w strumieniu i trzeba go czytac
      // z tresci.
      let calosc = "";
      let pierwszy: number | null = null;
      let bladStrumienia: string | null = null;
      let bufor = "";
      const dekoder = new TextDecoder();
      for await (const porcja of odp.body as unknown as AsyncIterable<Uint8Array>) {
        bufor += dekoder.decode(porcja, { stream: true });
        const linie = bufor.split("\n");
        // Ostatni element to ogon bez `\n` — czeka na kolejna porcje.
        bufor = linie.pop() ?? "";
        for (const linia of linie) {
          if (!linia.trim()) continue;
          let obiekt: { tekst?: string; koniec?: boolean; blad?: string };
          try {
            obiekt = JSON.parse(linia);
          } catch {
            continue;
          }
          if (obiekt.blad) {
            bladStrumienia = obiekt.blad;
          } else if (obiekt.tekst) {
            if (pierwszy === null) pierwszy = Date.now() - start;
            calosc += obiekt.tekst;
            onChunk(obiekt.tekst);
          }
        }
      }
      if (bladStrumienia) {
        console.error(`[rozmowa] shim zglosil blad w strumieniu: ${bladStrumienia}`);
        return null;
      }
      const tekst = calosc.trim();
      console.log(
        `[rozmowa] pierwszy kawalek po ${((pierwszy ?? 0) / 1000).toFixed(1)} s, ` +
          `calosc w ${((Date.now() - start) / 1000).toFixed(1)} s`
      );
      return tekst || null;
    } catch (e) {
      console.error(`[rozmowa] shim niedostepny: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async generate(
    systemInstruction: { parts: { text: string }[] },
    contents: GeminiContent[],
    tools: unknown[] | undefined,
    isVoice: boolean,
    // Retrying a grounding 429 is pointless — that quota is 0 for the whole
    // month, not for the next few seconds — so the caller disables it there and
    // falls back to a search tool instead.
    allowRetryOn429 = true,
    /** Gdy podane, jedziemy `streamGenerateContent` i oddajemy tekst na biezaco. */
    onTekst?: (kawalek: string) => void
  ): Promise<GeminiResponse> {
    const apiKey = this.config.openaiApiKey; // the Gemini API key (reused)
    if (!apiKey) throw new Error("Gemini API key is not set (OPENAI_API_KEY)");

    const body: Record<string, unknown> = {
      systemInstruction,
      contents,
      generationConfig: { maxOutputTokens: isVoice ? 500 : 2048 },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.toolConfig = { includeServerSideToolInvocations: true };
    }

    const strumien = !!onTekst;
    const url = strumien
      ? `${NATIVE_BASE}/models/${this.config.llmModel}:streamGenerateContent?alt=sse`
      : `${NATIVE_BASE}/models/${this.config.llmModel}:generateContent`;

    for (let attempt = 1; ; attempt++) {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (resp.ok && strumien && resp.body) {
        return await this.czytajStrumien(resp.body, onTekst!);
      }
      if (resp.ok) return (await resp.json()) as GeminiResponse;

      const text = await resp.text();
      // 429 on a free-tier key is usually the 10-requests-per-minute window, and
      // a single voice command can spend three requests in as many seconds — so
      // waiting is the difference between "works" and "unusable".
      if (resp.status === 429 && allowRetryOn429 && attempt < MAX_429_ATTEMPTS) {
        const wait = retryDelayMs(attempt, parseRetryDelay(text));
        console.warn(
          `[gemini] 429 rate limited — retrying in ${wait / 1000}s ` +
            `(attempt ${attempt}/${MAX_429_ATTEMPTS})`
        );
        await sleep(wait);
        continue;
      }

      // 🔴 503 „high demand" po stronie Google JEST PRZEJSCIOWE — i dotad
      // konczylo ture komunikatem „Sorry, I couldn't process that request",
      // czyli awaria dostawcy trwajaca sekunde stawala sie awaria asystenta.
      // Zlapane 14.08 przy wdrazaniu strumienia: te same pytania powtorzone
      // chwile pozniej przechodzily bez zmian w kodzie (A/B 5/5 i 5/5, wiec to
      // NIE byla wina strumienia — tylko chwilowa niewydolnosc Gemini).
      //
      // Krotsze czekanie niz przy 429: tam limit jest minutowy i trzeba go
      // przeczekac, tu wystarczy chwila, a po drugiej stronie stoi czlowiek.
      if (PONAWIALNE.has(resp.status) && attempt < MAX_PRZEJSCIOWE_PROBY) {
        const wait = [500, 1500, 3000][Math.min(attempt - 1, 2)];
        console.warn(
          `[gemini] ${resp.status} (przejsciowe) — ponawiam za ${wait / 1000}s ` +
            `(proba ${attempt}/${MAX_PRZEJSCIOWE_PROBY})`
        );
        await sleep(wait);
        continue;
      }

      throw new Error(`Gemini API error ${resp.status}: ${text.slice(0, 500)}`);
    }
  }

  /**
   * Zamienia SSE z `streamGenerateContent` w jedna odpowiedz — taka samą, jaką
   * dalby zwykly request — oddajac po drodze tekst przez `onTekst`.
   *
   * ⚠️ Reszta silnika NIE WIE, ze cos sie strumieniowalo. To celowe: petla
   * narzedzi, odsylanie tury modelu i obsluga bledow zostaja bez zmian, wiec
   * strumien nie moze wprowadzic wlasnej klasy usterek do kodu, ktory juz
   * dziala.
   */
  private async czytajStrumien(
    body: ReadableStream<Uint8Array>,
    onTekst: (kawalek: string) => void
  ): Promise<GeminiResponse> {
    const czesci: GeminiPart[] = [];
    let finishReason: string | undefined;
    let grounding: { webSearchQueries?: string[]; groundingChunks?: unknown[] } | undefined;
    let usage: GeminiResponse["usageMetadata"];

    let bufor = "";
    const dekoder = new TextDecoder();
    for await (const porcja of body as unknown as AsyncIterable<Uint8Array>) {
      bufor += dekoder.decode(porcja, { stream: true });
      const linie = bufor.split("\n");
      bufor = linie.pop() ?? "";
      for (const linia of linie) {
        if (!linia.startsWith("data:")) continue;
        const surowe = linia.slice(5).trim();
        if (!surowe || surowe === "[DONE]") continue;
        let porcjaOdp: GeminiResponse;
        try {
          porcjaOdp = JSON.parse(surowe) as GeminiResponse;
        } catch {
          continue;
        }
        const kandydat = porcjaOdp.candidates?.[0];
        scalCzesci(czesci, kandydat?.content?.parts, onTekst);
        if (kandydat?.finishReason) finishReason = kandydat.finishReason;
        if (kandydat?.groundingMetadata) grounding = kandydat.groundingMetadata;
        // Rozliczenie przychodzi narastajaco — liczy sie ostatnie.
        if (porcjaOdp.usageMetadata) usage = porcjaOdp.usageMetadata;
      }
    }

    return {
      candidates: [
        {
          content: { parts: czesci },
          ...(finishReason ? { finishReason } : {}),
          ...(grounding ? { groundingMetadata: grounding } : {}),
        },
      ],
      ...(usage ? { usageMetadata: usage } : {}),
    };
  }
}
