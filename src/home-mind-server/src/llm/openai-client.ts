import OpenAI from "openai";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { SHARED_PROFILE_ID } from "../memory/types.js";
import { rulesForPrompt } from "../rules/store.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPromptText, buildVolatileBlock } from "./prompts.js";
import { TOOL_DEFINITIONS, toOpenAITools } from "./tool-definitions.js";
import { handleToolCall, extractAndStoreFacts, recallFacts } from "./tool-handler.js";
import { trustsProfile } from "./interface.js";
import type { WebSearchSettings, KontekstPamieci } from "./tool-handler.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatError,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
  UzyteNarzedzie,
} from "./interface.js";

type FunctionToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

const OPENAI_TOOLS = toOpenAITools(TOOL_DEFINITIONS);

/**
 * Gemini's OpenAI-compat streaming sometimes concatenates two parallel tool
 * calls into a single tool_call's arguments string — two back-to-back JSON
 * objects like `{...}{...}` — which is not valid JSON. Left as-is it fails to
 * parse locally AND makes the follow-up request 400 (malformed function call).
 * This splits such a string into its individual top-level JSON objects so each
 * becomes its own well-formed tool call. Returns [input] when it's a single
 * value (the normal case). `parallel_tool_calls: false` does NOT prevent this —
 * Gemini ignores it — so we sanitize defensively.
 */
export function splitConcatenatedJson(argsString: string): string[] {
  const s = argsString.trim();
  if (!s) return [s];
  try {
    JSON.parse(s);
    return [s]; // already a single valid value — the common path
  } catch {
    // fall through to brace-scan
  }
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (
    chunks.length > 1 &&
    chunks.every((ch) => {
      try {
        JSON.parse(ch);
        return true;
      } catch {
        return false;
      }
    })
  ) {
    return chunks;
  }
  return [s]; // couldn't cleanly split — let the normal error path handle it
}

/**
 * Hard cap on tool round-trips per user message. A model that loops (repeatedly
 * re-searching entities, retrying a tool it misreads as failing) otherwise runs
 * until the HA integration's 120s client timeout with nothing to show for it —
 * and on a metered API, at the user's expense. On the last iteration we re-ask
 * with tool calling disabled so there is still a written answer.
 */
const MAX_TOOL_ITERATIONS = 8;

export class OpenAIChatEngine implements IChatEngine {
  private client: OpenAI;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;
  private config: Config;

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
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/hoornet/home-mind",
        "X-Title": "Home Mind",
      },
    });
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  async chat(
    request: ChatRequest,
    onChunk?: StreamCallback
  ): Promise<ChatResponse> {
    const { message, userId, conversationId, isVoice = false, customPrompt, skipExtraction } = request;
    const toolsUsed: string[] = [];
    // Te same wywołania z argumentami — `toolsUsed` zostaje listą nazw, bo
    // czyta ją integracja HA; nauka potrzebuje szczegółów, patrz UzyteNarzedzie.
    const wywolania: UzyteNarzedzie[] = [];

    // 1. Load user's memory
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
    // Same gate as the block above — see the note in gemini-client.ts.
    const kontekstPamieci: KontekstPamieci = {
      memory: this.memory,
      userId,
      limit: request.memoryTokenLimit ?? this.config.memoryTokenLimit,
      allowPersonal: trustedIdentity,
      sharedUserId: SHARED_PROFILE_ID,
    };
    if (this.config.logLevel === "debug") {
      const approxTokens = Math.ceil(factContents.join(" ").length / 4);
      console.debug(
        `[recall] userId=${userId} factCount=${factContents.length} tokens=${approxTokens}`
      );
    }

    // 2. Refresh device profiles and home layout if stale, then build system prompt
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
    const systemPrompt = buildSystemPromptText(isVoice, customPrompt, deviceCheatSheet, homeLayout, request.webSearchLimit, rulesForPrompt());
    const blokZmienny = buildVolatileBlock(factContents, request.userName, trustedIdentity, request.wypowiedzi, isVoice);

    // Prompt-size telemetry (sections that dominate the input tokens).
    const approxTok = (s?: string) => Math.ceil((s?.length ?? 0) / 4);
    console.log(
      `[prompt] system~${approxTok(systemPrompt)}tok layout~${approxTok(homeLayout)}tok ` +
      `devices~${approxTok(deviceCheatSheet)}tok facts=${factContents.length} ` +
      `exposed=${request.exposedEntities?.length ?? "none"}`
    );

    // 3. Load conversation history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 4. Add current user message, with the volatile block riding on this turn
    // only — the history above stays bare, which is what keeps it cacheable.
    messages.push({ role: "user", content: `${blokZmienny}\n\n${message}` });

    if (conversationId) {
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }

    // 5. Stream and handle tool call loop
    let result = await this.streamCompletion(messages, isVoice, onChunk);

    let iterations = 0;
    while (result.finishReason === "tool_calls" && result.toolCalls.length > 0) {
      iterations++;

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      // Execute all tool calls in parallel
      const toolPromises = result.toolCalls.map(async (tc: FunctionToolCall) => {
        toolsUsed.push(tc.function.name);

        // Small local models routinely emit truncated or non-JSON arguments.
        // Hand that back as a tool error the model can recover from — throwing
        // here would reject the whole Promise.all and fail the user's request.
        let args: Record<string, unknown>;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          console.warn(
            `[tool] ${tc.function.name} got unparseable arguments: ${tc.function.arguments}`
          );
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: JSON.stringify({
              error:
                `Arguments for ${tc.function.name} were not valid JSON and could not be read. ` +
                `Call the tool again with valid JSON arguments.`,
            }),
          };
        }

        // Dopiero tutaj, nie przy `toolsUsed.push`: argumenty, których nie dało
        // się sparsować, wracają wyżej jako błąd narzędzia i nie ma z nich
        // czego się uczyć.
        wywolania.push({ nazwa: tc.function.name, argumenty: args });

        const toolResult = await handleToolCall(this.ha, tc.function.name, args, {
          mode: request.webSearchMode ?? this.config.webSearchMode,
          searchApiKey: this.config.geminiSearchApiKey,
        } satisfies WebSearchSettings, trustedIdentity, request.userId, kontekstPamieci, request.wypowiedzi);
        return {
          role: "tool" as const,
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult, null, 2),
        };
      });

      const toolResults = await Promise.all(toolPromises);
      messages.push(...toolResults);

      // Continue streaming. On the final allowed iteration, disable tool calling
      // so the model has to answer in words rather than loop again.
      const forceAnswer = iterations >= MAX_TOOL_ITERATIONS;
      if (forceAnswer) {
        console.warn(
          `[llm] tool loop hit ${MAX_TOOL_ITERATIONS} iterations — forcing a final answer`
        );
      }
      result = await this.streamCompletion(messages, isVoice, onChunk, forceAnswer);
      if (forceAnswer) break;
    }

    const responseText = result.text;

    // 6. Store assistant response
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }

    // 7. Extract and store facts (fire-and-forget)
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

    // 8. If the model produced no usable response, attach a structured error
    // so the HA integration can surface a useful hint instead of the generic
    // "I received your request but got no response." fallback. The `finish_reason`
    // from the final stream tells us which diagnostic applies.
    const error = responseText === "" && result.toolCalls.length === 0
      ? this.classifyEmptyResponse(result.finishReason)
      : undefined;

    return {
      response: responseText,
      toolsUsed,
      factsLearned: 0,
      ...(error ? { error } : {}),
    };
  }

  private classifyEmptyResponse(finishReason: string | null): ChatError {
    if (finishReason === "length") {
      return {
        code: "MAX_TOKENS_TRUNCATED",
        hint:
          "Response was cut off at max_tokens before the model finished. " +
          "If you're seeing this often, the conversation prompt may be too large " +
          "for the model's output budget — try a model with more output tokens.",
      };
    }
    if (finishReason === "content_filter") {
      return {
        code: "CONTENT_FILTERED",
        hint:
          "The provider blocked the response (content filter). " +
          "If this happens on benign smart-home commands, try a different model.",
      };
    }
    return {
      code: "EMPTY_CONTENT",
      hint:
        "The model returned no text and no tool calls. " +
        "If you're routing through an OpenAI-compatible shim/proxy, verify it streams " +
        "OpenAI-format SSE chunks. For local models, ensure the model emits a final " +
        "answer rather than just thinking. For the fact extractor specifically, set " +
        "OPENAI_RESPONSE_FORMAT=json_object on picky providers (e.g. some Ollama models).",
    };
  }

  private async streamCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    isVoice: boolean,
    onChunk?: StreamCallback,
    disableTools = false
  ): Promise<{
    text: string;
    finishReason: string | null;
    toolCalls: FunctionToolCall[];
  }> {
    const stream = await this.client.chat.completions.create({
      model: this.config.llmModel,
      max_tokens: isVoice ? 500 : 2048,
      messages,
      tools: OPENAI_TOOLS,
      // Force ONE tool call per turn. Gemini's OpenAI-compat streaming merges
      // parallel tool calls into a single tool_call's arguments (two JSON
      // objects concatenated → unparseable → 400 on the follow-up). This bites
      // any command that targets multiple entities at once (e.g. two lights in
      // one room). Sequential calls keep each tool_call well-formed.
      parallel_tool_calls: false,
      // Keep the tool list in the request (history already references it) but
      // stop the model from issuing more calls.
      ...(disableTools ? { tool_choice: "none" as const } : {}),
      // Stop a local reasoning model from spending the whole output budget on
      // an internal monologue. Measured on qwen3.5:2b: left alone it burned
      // 1200/1200 tokens and returned EMPTY content; with this it answered in
      // 5.8 s. Ollama-only by necessity — Gemini's OpenAI-compatible endpoint
      // rejects `reasoning_effort` with 400 INVALID_ARGUMENT, so sending it to
      // a hosted provider would break every request. (`think: false`, which
      // works on Ollama's native /api/chat, is ignored on /v1.)
      ...(this.config.llmProvider === "ollama" && !this.config.llmThinking
        ? { reasoning_effort: "none" as const }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = "";
    let finishReason: string | null = null;
    let usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    } | null = null;

    // Accumulate tool calls from streamed deltas, indexed by position.
    // extraContent carries provider-specific data (e.g. Gemini's
    // thought_signature) that must be echoed back on the follow-up request.
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string; extraContent?: unknown }
    >();

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;

      // Accumulate text
      if (choice.delta?.content) {
        text += choice.delta.content;
        if (onChunk) {
          onChunk(choice.delta.content);
        }
      }

      // Accumulate tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const extra = (tc as { extra_content?: unknown }).extra_content;
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            // Append to existing tool call's arguments
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            if (extra !== undefined) existing.extraContent = extra;
          } else {
            // New tool call at this index
            toolCallAccumulator.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
              extraContent: extra,
            });
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    if (usage) {
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      console.log(
        `[usage] prompt=${usage.prompt_tokens} (cached=${cached}) completion=${usage.completion_tokens} total=${usage.total_tokens}`
      );
    }

    // Convert accumulated tool calls to the expected format. A single accumulated
    // entry may carry two concatenated JSON arg objects (Gemini merging parallel
    // calls) — split those into separate, well-formed tool calls with unique ids.
    const toolCalls: FunctionToolCall[] = [];
    for (const [, tc] of [...toolCallAccumulator.entries()].sort(
      (a, b) => a[0] - b[0]
    )) {
      const argChunks = splitConcatenatedJson(tc.arguments);
      if (argChunks.length > 1) {
        console.warn(
          `[llm] split ${argChunks.length} concatenated tool-call args for ${tc.name}`
        );
      }
      argChunks.forEach((args, i) => {
        toolCalls.push({
          id: argChunks.length > 1 ? `${tc.id || "call"}_${i}` : tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: args,
          },
          // Echo provider-specific data (Gemini thought_signature) back so the
          // follow-up request passes validation. Ignored by other providers.
          ...(tc.extraContent !== undefined
            ? { extra_content: tc.extraContent }
            : {}),
        } as FunctionToolCall);
      });
    }

    // Some OpenAI-compatible providers (notably Google Gemini's compat endpoint)
    // stream tool calls but report finish_reason "stop" instead of "tool_calls".
    // Normalize so the tool loop below still fires when tool calls were emitted.
    if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }

    return { text, finishReason, toolCalls };
  }
}
