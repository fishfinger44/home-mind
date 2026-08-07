import "dotenv/config";
import express from "express";
import cors from "cors";
import { createRequire } from "module";
import { loadConfig } from "./config.js";
import { createAuthMiddleware } from "./api/auth.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
import { ShodhMemoryStore } from "./memory/shodh-client.js";
import { createConversationStore } from "./memory/conversation-factory.js";
import { HomeAssistantClient } from "./ha/client.js";
import { DeviceScanner } from "./ha/device-scanner.js";
import { TopologyScanner } from "./ha/topology-scanner.js";
import { createChatEngine, createFactExtractor } from "./llm/factory.js";
import { createRouter } from "./api/routes.js";
import { createRulesRouter, createRulesPage } from "./rules/routes.js";
import { createRestrictionsRouter } from "./llm/restricted-routes.js";
import type { IChatEngine } from "./llm/interface.js";
import { loadLlmOverride, saveLlmOverride } from "./llm/runtime-config.js";
import { createLlmConfigRouter } from "./api/llm-config-routes.js";
import { createSttService } from "./stt/stt-service.js";
import { createTtsService } from "./tts/tts-service.js";
import { MemoryCleanupJob } from "./jobs/memory-cleanup.js";

// Load configuration
const config = loadConfig();

// Initialize components
console.log("Initializing Home Mind API...");

// Initialize Shodh memory store (required)
console.log(`  Connecting to Shodh Memory: ${config.shodhUrl}`);
const memory = new ShodhMemoryStore({
  baseUrl: config.shodhUrl,
  apiKey: config.shodhApiKey,
});

// Verify Shodh is available
const healthy = await memory.isHealthy();
if (!healthy) {
  console.error("ERROR: Shodh Memory is not available at", config.shodhUrl);
  console.error("Please ensure Shodh is running before starting Home Mind.");
  process.exit(1);
}
console.log("  ✓ Memory store: Shodh Memory (cognitive, semantic search)");

// Initialize conversation store
const conversations = createConversationStore(config);
console.log(`  ✓ Conversation store: ${config.conversationStorage}`);

// Apply any persisted runtime LLM override (set via the HA integration) on top
// of the .env config. The provider's API key still comes from .env.
let storedOverride = loadLlmOverride();

// Build the effective config: base .env config with the runtime override's
// provider/model and (when set) API key + base URL layered on top. When the
// override omits a key, the provider's key falls back to .env.
function buildActiveConfig() {
  if (!storedOverride) return config;
  const c = { ...config, llmProvider: storedOverride.provider, llmModel: storedOverride.model };
  if (storedOverride.apiKey) {
    if (storedOverride.provider === "anthropic") c.anthropicApiKey = storedOverride.apiKey;
    // "gemini" (native) reuses openaiApiKey as its Gemini key, like "openai".
    else if (storedOverride.provider === "openai" || storedOverride.provider === "gemini")
      c.openaiApiKey = storedOverride.apiKey;
  }
  if (storedOverride.baseUrl && storedOverride.provider === "openai") {
    c.openaiBaseUrl = storedOverride.baseUrl;
  }
  // Ollama's endpoint is a different field, and it is the one setting that
  // cannot be left at its default in a container: "localhost" there is the
  // server itself, not the machine running Ollama.
  if (storedOverride.baseUrl && storedOverride.provider === "ollama") {
    c.ollamaBaseUrl = storedOverride.baseUrl;
  }
  // Separate billed key for `gemini_micro` web search — independent of the
  // provider, so a free-tier conversation key can coexist with paid search.
  if (storedOverride.searchApiKey) {
    c.geminiSearchApiKey = storedOverride.searchApiKey;
  }
  return c;
}

let activeConfig = buildActiveConfig();
if (storedOverride) {
  console.log(
    `  LLM override: ${storedOverride.provider}/${storedOverride.model} ` +
    `(runtime config${storedOverride.apiKey ? ", custom key" : ""})`
  );
}

const ha = new HomeAssistantClient(config);
console.log(`  Home Assistant: ${config.haUrl}`);

let deviceOverrides = {};
if (config.deviceOverrides) {
  try {
    deviceOverrides = JSON.parse(config.deviceOverrides);
  } catch {
    console.warn("  ⚠ DEVICE_OVERRIDES is not valid JSON — ignored");
  }
}
const scanner = new DeviceScanner(ha, 30 * 60 * 1000, deviceOverrides);
const topology = new TopologyScanner(ha, 30 * 60 * 1000);
await Promise.all([scanner.scan(), topology.scan()]);
console.log(`  ✓ Device scanner: ${scanner.getProfiles().length} light profiles loaded`);
console.log(`  ✓ Topology scanner: home layout ${topology.hasLayout() ? "loaded" : "unavailable"}`);

let currentExtractor = createFactExtractor(activeConfig);
let currentEngine = createChatEngine(
  activeConfig, memory, conversations, currentExtractor, ha, scanner, topology
);
console.log(`  LLM client: ${activeConfig.llmProvider}/${activeConfig.llmModel}`);

// Stable proxy so the mounted router keeps working after a runtime switch.
const llm: IChatEngine = {
  chat: (request, onChunk) => currentEngine.chat(request, onChunk),
};

// Switch provider/model (and optionally API key / base URL) at runtime — called
// by POST /api/config/llm — and persist. Secrets not supplied in the call are
// kept from the previous override for the same provider (so changing only the
// model doesn't wipe a UI-entered key); switching provider without a new key
// falls back to the .env key for that provider.
function applyLlm(
  provider: "anthropic" | "openai" | "ollama" | "gemini",
  model: string,
  apiKey?: string,
  baseUrl?: string,
  searchApiKey?: string
): void {
  // Keys and base URLs are remembered per provider, so switching away and back
  // — including a trip through a local model — returns to the same credentials
  // instead of silently falling through to the .env ones.
  const apiKeys = { ...(storedOverride?.apiKeys ?? {}) };
  if (apiKey) apiKeys[provider] = apiKey;
  const baseUrls = { ...(storedOverride?.baseUrls ?? {}) };
  if (baseUrl) baseUrls[provider] = baseUrl;

  storedOverride = {
    provider,
    model,
    apiKey: apiKeys[provider],
    baseUrl: baseUrls[provider],
    apiKeys,
    baseUrls,
    // The search key belongs to a different project than the chat key, so it
    // survives a provider switch — it is not tied to the selected provider.
    searchApiKey: searchApiKey ?? storedOverride?.searchApiKey,
  };
  activeConfig = buildActiveConfig();
  currentExtractor = createFactExtractor(activeConfig);
  currentEngine = createChatEngine(
    activeConfig, memory, conversations, currentExtractor, ha, scanner, topology
  );
  saveLlmOverride(storedOverride);
  console.log(
    `  LLM switched -> ${provider}/${model}${apiKey ? " (custom key updated)" : ""}`
  );
}

// Initialize STT (optional — only when STT_PROVIDER is set)
const stt = createSttService(config);
if (stt) {
  console.log(`  STT: ${config.sttProvider} / ${config.sttModel}`);
} else {
  console.log("  STT: disabled");
}

// Initialize TTS (optional — only when TTS_PROVIDER is set)
const tts = createTtsService(config);
if (tts) {
  console.log(`  TTS: ${config.ttsProvider} / ${config.ttsModel} (voice: ${config.ttsVoice})`);
} else {
  console.log("  TTS: disabled");
}

// Create Express app
const app = express();

// CORS middleware (only when CORS_ORIGINS is configured)
if (config.corsOrigins) {
  const origins = config.corsOrigins.split(",").map((o) => o.trim());
  app.use(cors({ origin: origins, credentials: true }));
  console.log(`  CORS: ${origins.join(", ")}`);
}

app.use(express.json());

// API token auth (only when API_TOKEN is configured)
const authMiddleware = createAuthMiddleware(config.apiToken);
app.use("/api", authMiddleware);

// Add request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// LLM provider/model switching (used by the HA integration options flow)
app.use(
  "/api",
  createLlmConfigRouter({
    getCurrent: () => ({
      provider: activeConfig.llmProvider,
      model: activeConfig.llmModel,
      baseUrl:
        activeConfig.llmProvider === "openai"
          ? activeConfig.openaiBaseUrl
          : activeConfig.llmProvider === "ollama"
            ? activeConfig.ollamaBaseUrl
            : undefined,
      hasApiKey:
        activeConfig.llmProvider === "anthropic"
          ? !!activeConfig.anthropicApiKey
          : activeConfig.llmProvider === "openai" || activeConfig.llmProvider === "gemini"
            ? !!activeConfig.openaiApiKey
            : true,
      hasSearchApiKey: !!activeConfig.geminiSearchApiKey,
    }),
    apply: applyLlm,
  },
    // Probed on every read of the form, so pulling a model shows up without a
    // restart. Reads the live config, not the startup one, so it follows a
    // base URL just changed from the options flow.
    { get baseUrl() { return activeConfig.ollamaBaseUrl; }, vramGb: config.ollamaVramGb ?? null }
  )
);

// Mount API routes
app.use("/api", createRouter(llm, memory, "shodh", version, config.customPrompt, conversations, stt ?? undefined, tts ?? undefined));
// Reguly domowe: API pod /api, sama strona edytora poza nim, zeby pasek boczny
// Home Assistanta mogl na nia wskazac zwyklym adresem.
app.use("/api", createRulesRouter(llm));
app.use("/api", createRestrictionsRouter());
app.use(createRulesPage());

// Root endpoint
app.get("/", (_req, res) => {
  res.json({
    name: "Home Mind Server",
    version,
    description: "Home Assistant AI with cognitive memory for voice integration",
    memoryBackend: "shodh",
    conversationStorage: config.conversationStorage,
    endpoints: {
      chat: "POST /api/chat",
      chatStream: "POST /api/chat/stream",
      memory: "GET /api/memory/:userId",
      health: "GET /api/health",
    },
  });
});

// Start server
app.listen(config.port, () => {
  console.log(`
┌─────────────────────────────────────────┐
│      Home Mind Server Started           │
├─────────────────────────────────────────┤
│  Port: ${config.port.toString().padEnd(33)}│
│  LLM: ${(config.llmProvider + "/" + config.llmModel).substring(0, 32).padEnd(32)}│
│  Memory: Shodh (cognitive)              │
│  Conversations: ${config.conversationStorage.padEnd(23)}│
│  HA URL: ${config.haUrl.substring(0, 30).padEnd(30)}│
│  Log Level: ${config.logLevel.padEnd(27)}│
└─────────────────────────────────────────┘

Ready to accept requests at http://localhost:${config.port}
`);
});

// Start periodic memory cleanup
const cleanupJob = new MemoryCleanupJob(memory, conversations, config.memoryCleanupIntervalHours);
cleanupJob.start();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  cleanupJob.stop();
  conversations.close();
  memory.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  cleanupJob.stop();
  conversations.close();
  memory.close();
  process.exit(0);
});
