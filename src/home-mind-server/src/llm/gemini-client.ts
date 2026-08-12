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
import { buildSystemPromptText } from "./prompts.js";
import { TOOL_DEFINITIONS, toGeminiTools } from "./tool-definitions.js";
import { handleToolCall, extractAndStoreFacts, recallFacts } from "./tool-handler.js";
import type { KontekstPamieci } from "./tool-handler.js";
import { trustsProfile } from "./interface.js";
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

// With grounding, the model searches server-side via googleSearch, so our own
// web_search tool is redundant and is left out. In every other search mode
// (micro-call / Tavily / Brave) it is the only way to the internet, so it stays.
const HA_FUNCTION_TOOLS = toGeminiTools(
  TOOL_DEFINITIONS.filter((t) => t.name !== "web_search")
);
const HA_FUNCTION_TOOLS_WITH_SEARCH = toGeminiTools(TOOL_DEFINITIONS);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiChatEngine implements IChatEngine {
  private config: Config;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;

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
      factContents,
      isVoice,
      customPrompt,
      deviceCheatSheet,
      homeLayout,
      request.webSearchLimit,
      request.userName,
      trustedIdentity,
      rulesForPrompt()
    );

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
    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }
    contents.push({ role: "user", parts: [{ text: message }] });

    const systemInstruction = { parts: [{ text: systemPromptText }] };
    const buildTools = (): unknown[] => {
      const set = webSearchEnabled && !useGrounding
        ? HA_FUNCTION_TOOLS_WITH_SEARCH
        : HA_FUNCTION_TOOLS;
      return useGrounding ? [set, { googleSearch: {} }] : [set];
    };
    let tools = buildTools();

    // 4. Tool loop
    let responseText = "";
    const groundingQueries: string[] = [];
    let iterations = 0;
    let forceAnswer = false;

    while (true) {
      let data: GeminiResponse;
      try {
        data = await this.generate(
          systemInstruction,
          contents,
          forceAnswer ? undefined : tools,
          isVoice,
          !useGrounding
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

      // Echo the model turn back VERBATIM (parts include thoughtSignature, which
      // Gemini 3 requires on the follow-up), then answer each function call.
      contents.push({ role: "model", parts });

      const responseParts: GeminiPart[] = [];
      for (const p of functionCalls) {
        const fc = p.functionCall!;
        toolsUsed.push(fc.name);
        wywolania.push({ nazwa: fc.name, argumenty: fc.args ?? {} });
        const result = await handleToolCall(this.ha, fc.name, fc.args ?? {}, searchSettings, trustedIdentity, userId, kontekstPamieci);
        responseParts.push({
          functionResponse: {
            name: fc.name,
            ...(fc.id ? { id: fc.id } : {}),
            response: { result },
          },
        });
      }
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
    if (onChunk && responseText) onChunk(responseText);

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

  private async generate(
    systemInstruction: { parts: { text: string }[] },
    contents: GeminiContent[],
    tools: unknown[] | undefined,
    isVoice: boolean,
    // Retrying a grounding 429 is pointless — that quota is 0 for the whole
    // month, not for the next few seconds — so the caller disables it there and
    // falls back to a search tool instead.
    allowRetryOn429 = true
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

    const url = `${NATIVE_BASE}/models/${this.config.llmModel}:generateContent`;

    for (let attempt = 1; ; attempt++) {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

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

      throw new Error(`Gemini API error ${resp.status}: ${text.slice(0, 500)}`);
    }
  }
}
