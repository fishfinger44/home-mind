import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module reads its path and quotas from env at import time, so each test
// block imports it fresh with a throwaway usage file.
let dir: string;

async function freshModule(env: Record<string, string> = {}) {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "search-usage-"));
  process.env.SEARCH_USAGE_PATH = join(dir, "usage.json");
  process.env.SEARCH_QUOTA_THRESHOLD = "0.9";
  process.env.TAVILY_MONTHLY_QUOTA = "10";
  process.env.BRAVE_MONTHLY_QUOTA = "10";
  process.env.GEMINI_SEARCH_MONTHLY_QUOTA = "10";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import("./search-usage.js");
}

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  delete process.env.SEARCH_USAGE_PATH;
  delete process.env.SEARCH_QUOTA_THRESHOLD;
  delete process.env.TAVILY_MONTHLY_QUOTA;
  delete process.env.BRAVE_MONTHLY_QUOTA;
  delete process.env.GEMINI_SEARCH_MONTHLY_QUOTA;
});

describe("search usage accounting", () => {
  it("starts the month at zero and persists each recorded search", async () => {
    const m = await freshModule();

    expect(m.usedThisMonth("tavily")).toBe(0);
    m.recordSearch("tavily");
    m.recordSearch("tavily");

    expect(m.usedThisMonth("tavily")).toBe(2);
    const onDisk = JSON.parse(readFileSync(process.env.SEARCH_USAGE_PATH!, "utf8"));
    expect(onDisk.counts.tavily).toBe(2);
  });

  it("treats a backend as spent once it crosses the threshold", async () => {
    const m = await freshModule();

    for (let i = 0; i < 8; i++) m.recordSearch("tavily");
    expect(m.isExhausted("tavily")).toBe(false); // 8/10 = 80%

    m.recordSearch("tavily");
    expect(m.isExhausted("tavily")).toBe(true); // 9/10 = 90% = threshold
  });

  it("honours a quota of 0 as unmetered", async () => {
    const m = await freshModule({ TAVILY_MONTHLY_QUOTA: "0" });

    for (let i = 0; i < 50; i++) m.recordSearch("tavily");
    expect(m.isExhausted("tavily")).toBe(false);
  });

  it("keeps a backend out of rotation after a quota error", async () => {
    const m = await freshModule();

    expect(m.isExhausted("brave")).toBe(false);
    m.markExhausted("brave", "HTTP 429");
    expect(m.isExhausted("brave")).toBe(true);

    const snap = m.usageSnapshot();
    const brave = snap.backends.find((b) => b.backend === "brave")!;
    expect(brave.exhausted).toBe(true);
    expect(brave.exhaustedAt).toBeTruthy();
  });
});

describe("searchChain", () => {
  it("puts the preferred backend first and keeps the others as fallback", async () => {
    const m = await freshModule();

    expect(m.searchChain("tavily", () => true)).toEqual([
      "tavily",
      "gemini_micro",
      "brave",
    ]);
  });

  it("drops backends whose key is not configured", async () => {
    const m = await freshModule();

    expect(m.searchChain("tavily", (b) => b !== "brave")).toEqual([
      "tavily",
      "gemini_micro",
    ]);
  });

  it("moves a spent backend behind the ones that still have quota", async () => {
    const m = await freshModule();
    m.markExhausted("tavily", "HTTP 429");

    // Still present — a fully spent month should attempt something rather than
    // refuse — but only after the backends that can still serve.
    expect(m.searchChain("tavily", () => true)).toEqual([
      "gemini_micro",
      "brave",
      "tavily",
    ]);
  });

  it("returns nothing when no backend is configured at all", async () => {
    const m = await freshModule();

    expect(m.searchChain("tavily", () => false)).toEqual([]);
  });
});

describe("usageSnapshot", () => {
  it("reports remaining quota per backend", async () => {
    const m = await freshModule();
    m.recordSearch("gemini_micro");

    const snap = m.usageSnapshot();
    const gemini = snap.backends.find((b) => b.backend === "gemini_micro")!;
    expect(gemini).toMatchObject({ used: 1, quota: 10, remaining: 9, exhausted: false });
    expect(snap.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("marks an unmetered backend with remaining -1", async () => {
    const m = await freshModule({ BRAVE_MONTHLY_QUOTA: "0" });

    const brave = m.usageSnapshot().backends.find((b) => b.backend === "brave")!;
    expect(brave.remaining).toBe(-1);
  });
});
