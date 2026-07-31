import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-override-"));
  path = join(dir, "llm-override.json");
  process.env.LLM_OVERRIDE_PATH = path;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LLM_OVERRIDE_PATH;
});

describe("loadLlmOverride key retention", () => {
  it("migrates a legacy single key into the per-provider map", async () => {
    writeFileSync(
      path,
      JSON.stringify({ provider: "gemini", model: "m", apiKey: "free-key", baseUrl: "http://x/v1" })
    );
    const { loadLlmOverride } = await import("./runtime-config.js");
    const o = loadLlmOverride()!;
    expect(o.apiKeys).toEqual({ gemini: "free-key" });
    expect(o.baseUrls).toEqual({ gemini: "http://x/v1" });
  });

  it("keeps every provider's key and ignores non-string junk", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        provider: "ollama",
        model: "qwen3:4b",
        apiKeys: { gemini: "free-key", anthropic: "ant-key", bogus: 42 },
      })
    );
    const { loadLlmOverride } = await import("./runtime-config.js");
    const o = loadLlmOverride()!;
    expect(o.apiKeys).toEqual({ gemini: "free-key", anthropic: "ant-key" });
  });

  it("round-trips through save", async () => {
    const { saveLlmOverride, loadLlmOverride } = await import(
      "./runtime-config.js"
    );
    saveLlmOverride({
      provider: "ollama",
      model: "qwen3:4b",
      apiKeys: { gemini: "free-key" },
      baseUrls: { ollama: "http://127.0.0.1:11434/v1" },
    });
    expect(JSON.parse(readFileSync(path, "utf8")).apiKeys).toEqual({ gemini: "free-key" });
    expect(loadLlmOverride()!.apiKeys).toEqual({ gemini: "free-key" });
  });
});
