import { z } from "zod";

const ConfigSchema = z
  .object({
    // Server
    port: z.coerce.number().default(3100),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // LLM ("gemini" = native Gemini API with Google Search grounding; reuses
    // openaiApiKey as the Gemini key)
    llmProvider: z.enum(["anthropic", "openai", "ollama", "gemini"]).default("anthropic"),
    llmModel: z.string().default("claude-haiku-4-5-20251001"),
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    openaiBaseUrl: z.string().url().optional(),

    // OpenAI fact-extractor tuning (applies only to OpenAIFactExtractor — chat
    // returns free-form text and ignores these). Some OpenAI-compatible
    // providers (notably qwen3.6:27b via Ollama) emit empty content unless
    // JSON mode is requested; some local models need a larger output budget.
    openaiResponseFormat: z.enum(["json_object"]).optional(),
    openaiMaxTokens: z.coerce.number().int().positive().optional(),

    // Ollama
    ollamaBaseUrl: z.string().url().optional(),
    // VRAM of the card Ollama runs on, GB. Purely informational: it lets the
    // model picker say whether a model fits instead of only how big it is.
    // Nothing detects this — a model that does not fit still runs, just partly
    // on the CPU and several times slower, which is the trap worth flagging.
    ollamaVramGb: z.coerce.number().positive().optional(),
    // Whether a reasoning model may "think" before answering. Ollama only.
    //
    // Left on, qwen3.5 spends the WHOLE output budget on an internal monologue
    // and returns empty content — 1200/1200 tokens with nothing to say, which
    // arrives here as EMPTY_CONTENT and looks like a broken model. Measured:
    // 6290 tokens of monologue on "what's the weather on Sunday".
    //
    // The switch is Ollama-only on purpose: Gemini's OpenAI-compatible endpoint
    // rejects `reasoning_effort` outright (HTTP 400 INVALID_ARGUMENT), so
    // sending it to the cloud would break every request. Note also that
    // `think: false` — which works on Ollama's native /api/chat — is silently
    // IGNORED on /v1, and /v1 is the endpoint this server uses.
    llmThinking: z
      .string()
      .optional()
      .transform((v) => v !== "false"),

    // Sciezka ROZMOWNA — adres shima na hoscie i wlacznik.
    //
    // 🔑 Dwie rozne rzeczy, celowo rozdzielone: `rozmowaUrl` to INFRASTRUKTURA
    // (gdzie stoi shim — nalezy do .env i nie zmienia sie z UI), a
    // `rozmowaWlaczona` to PREFERENCJA, ktora Lech przelacza z HA bez restartu.
    // Brak adresu = funkcji nie ma i zaden przelacznik jej nie wyczaruje.
    rozmowaUrl: z.string().optional().transform((v) => (v ?? "").trim()),
    rozmowaWlaczona: z
      .string()
      .optional()
      .transform((v) => v !== "false"),
    rozmowaTur: z
      .string()
      .optional()
      .transform((v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
      }),
    // ⚠️ CELOWO BEZ ODCZYTU Z `process.env` — patrz `loadConfig` nizej, gdzie
    // reszta pol dostaje swoja zmienna, a te dwa nie.
    //
    // Shim ma wlasne `ROZMOWA_MODEL`/`ROZMOWA_EFFORT` w jednostce systemd i to
    // on jest od domyslnych. Gdyby serwer czytal zmienne o tych samych nazwach
    // ze swojego `.env`, powstalyby dwa miejsca o identycznych nazwach i roznym
    // zasiegu — a to dokladnie ta pomylka, przez ktora wpis w `.env` „nie
    // dziala". Tu ladują WYLACZNIE wybory z panelu HA (z pliku nadpisania).
    rozmowaModel: z.string().optional(),
    rozmowaEffort: z.string().optional(),

    // Home Assistant
    haUrl: z.string().url("HA_URL must be a valid URL"),
    haToken: z.string().min(1, "HA_TOKEN is required"),
    haSkipTlsVerify: z
      .string()
      .transform((v) => v === "true")
      .default("false"),

    // Memory - Shodh (required)
    shodhUrl: z.string().url("SHODH_URL is required"),
    shodhApiKey: z.string().min(1, "SHODH_API_KEY is required"),

    // Web search: how the assistant reaches the internet. See WebSearchMode.
    // `grounding` needs a BILLED Google project; on the free tier Search
    // grounding is "Not available" and requests come back 429.
    webSearchMode: z
      .enum(["grounding", "gemini_micro", "tavily", "searxng", "brave"])
      .default("grounding"),
    // Key of a billed Google project, used only for `gemini_micro` search
    // requests — lets the conversation itself run on a different (free) key.
    geminiSearchApiKey: z.string().optional(),

    // Memory settings
    memoryTokenLimit: z.coerce.number().default(3000),
    memoryCleanupIntervalHours: z.coerce.number().min(0).default(6),

    // Conversation history
    conversationStorage: z.enum(["memory", "sqlite"]).default("memory"),
    conversationDbPath: z.string().default("/data/conversations.db"),

    // Custom prompt
    customPrompt: z.string().optional(),

    // Per-entity device capability overrides (JSON, for devices with incorrect HA-reported modes)
    deviceOverrides: z.string().optional(),

    // App / API access
    corsOrigins: z.string().optional(), // Comma-separated origins, e.g. "http://localhost:5173,https://app.example.com"
    apiToken: z.string().optional(), // Bearer token for API auth (when unset, no auth enforced)
    // Lista adresów, z których wolno wołać `/api` (poza `/health`). Przecinki,
    // pojedyncze adresy albo sieci z maską: "127.0.0.1,::1,192.168.88.0/24".
    // Pusta = brak ograniczenia. Potrzebna, bo dopóki `apiToken` jest pusty,
    // `identityConfidence` w `POST /api/chat` przychodzi od wołającego i każdy
    // w LAN-ie może kazać asystentowi czytać cudzą pamięć.
    apiAllowlist: z.string().optional(),

    // Speech-to-text (for HomeMind App)
    sttProvider: z.enum(["openai", "none"]).default("none"),
    sttApiKey: z.string().optional(), // Overrides openaiApiKey for STT; falls back to openaiApiKey if unset
    sttBaseUrl: z.string().url().optional(), // Custom Whisper-compatible endpoint
    sttModel: z.string().default("whisper-1"),

    // Text-to-speech (for HomeMind App)
    ttsProvider: z.enum(["openai", "none"]).default("none"),
    ttsApiKey: z.string().optional(), // Overrides openaiApiKey for TTS; falls back to openaiApiKey if unset
    ttsBaseUrl: z.string().url().optional(), // Custom OpenAI-compatible TTS endpoint
    ttsModel: z.string().default("tts-1"),
    ttsVoice: z.string().default("alloy"),
  })
  .superRefine((data, ctx) => {
    if (data.llmProvider === "anthropic" && !data.anthropicApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER is anthropic",
        path: ["anthropicApiKey"],
      });
    }
    if (data.llmProvider === "openai" && !data.openaiApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OPENAI_API_KEY is required when LLM_PROVIDER is openai",
        path: ["openaiApiKey"],
      });
    }
    if (data.llmProvider === "gemini" && !data.openaiApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OPENAI_API_KEY (used as the Gemini key) is required when LLM_PROVIDER is gemini",
        path: ["openaiApiKey"],
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  // Treat empty strings as undefined for optional fields
  const emptyToUndefined = (v: string | undefined) =>
    v === "" ? undefined : v;

  const result = ConfigSchema.safeParse({
    port: process.env.PORT,
    logLevel: emptyToUndefined(process.env.LOG_LEVEL),
    llmProvider: emptyToUndefined(process.env.LLM_PROVIDER),
    llmModel: emptyToUndefined(process.env.LLM_MODEL),
    anthropicApiKey: emptyToUndefined(process.env.ANTHROPIC_API_KEY),
    openaiApiKey: emptyToUndefined(process.env.OPENAI_API_KEY),
    openaiBaseUrl: emptyToUndefined(process.env.OPENAI_BASE_URL),
    openaiResponseFormat: emptyToUndefined(process.env.OPENAI_RESPONSE_FORMAT),
    openaiMaxTokens: emptyToUndefined(process.env.OPENAI_MAX_TOKENS),
    ollamaBaseUrl: emptyToUndefined(process.env.OLLAMA_BASE_URL),
    ollamaVramGb: emptyToUndefined(process.env.OLLAMA_VRAM_GB),
    llmThinking: emptyToUndefined(process.env.LLM_THINKING),
    rozmowaUrl: emptyToUndefined(process.env.ROZMOWA_URL),
    rozmowaWlaczona: emptyToUndefined(process.env.ROZMOWA_WLACZONA),
    rozmowaTur: emptyToUndefined(process.env.ROZMOWA_TUR),
    haUrl: process.env.HA_URL,
    haToken: process.env.HA_TOKEN,
    haSkipTlsVerify: process.env.HA_SKIP_TLS_VERIFY,
    shodhUrl: process.env.SHODH_URL,
    shodhApiKey: process.env.SHODH_API_KEY,
    // WEB_SEARCH_PROVIDER is the older name and only ever held tavily|brave,
    // both of which are valid modes — so it keeps working as a fallback.
    webSearchMode:
      emptyToUndefined(process.env.WEB_SEARCH_MODE) ??
      emptyToUndefined(process.env.WEB_SEARCH_PROVIDER),
    geminiSearchApiKey: emptyToUndefined(process.env.GEMINI_SEARCH_API_KEY),
    memoryTokenLimit: process.env.MEMORY_TOKEN_LIMIT,
    memoryCleanupIntervalHours: emptyToUndefined(process.env.MEMORY_CLEANUP_INTERVAL_HOURS),
    conversationStorage: emptyToUndefined(process.env.CONVERSATION_STORAGE),
    conversationDbPath: emptyToUndefined(process.env.CONVERSATION_DB_PATH),
    customPrompt: emptyToUndefined(process.env.CUSTOM_PROMPT),
    deviceOverrides: emptyToUndefined(process.env.DEVICE_OVERRIDES),
    corsOrigins: emptyToUndefined(process.env.CORS_ORIGINS),
    apiToken: emptyToUndefined(process.env.API_TOKEN),
    apiAllowlist: emptyToUndefined(process.env.API_ALLOWLIST),
    sttProvider: emptyToUndefined(process.env.STT_PROVIDER),
    sttApiKey: emptyToUndefined(process.env.STT_API_KEY),
    sttBaseUrl: emptyToUndefined(process.env.STT_BASE_URL),
    sttModel: emptyToUndefined(process.env.STT_MODEL),
    ttsProvider: emptyToUndefined(process.env.TTS_PROVIDER),
    ttsApiKey: emptyToUndefined(process.env.TTS_API_KEY),
    ttsBaseUrl: emptyToUndefined(process.env.TTS_BASE_URL),
    ttsModel: emptyToUndefined(process.env.TTS_MODEL),
    ttsVoice: emptyToUndefined(process.env.TTS_VOICE),
  });

  if (!result.success) {
    console.error("Configuration errors:");
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    process.exit(1);
  }

  return result.data;
}
