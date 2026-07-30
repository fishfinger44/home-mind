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
  delete process.env.SEARCH_ALLOW_PAID;
  delete process.env.BRAVE_FREE_CREDIT_USD;
  delete process.env.BRAVE_PRICE_PER_1K_USD;
});

describe("not spending money", () => {
  it("drops an exhausted backend instead of trying it anyway", async () => {
    const m = await freshModule();
    m.markExhausted("tavily", "HTTP 429");

    // Only Tavily is configured, and it is out — so there is nothing to try.
    const chain = m.searchChain("tavily", (b) => b === "tavily");

    expect(chain).toEqual([]);
  });

  it("keeps searching on a backend that still has free allowance", async () => {
    const m = await freshModule();
    m.markExhausted("tavily", "HTTP 429");

    const chain = m.searchChain("tavily", (b) => b === "tavily" || b === "gemini_micro");

    expect(chain).toEqual(["gemini_micro"]);
  });

  it("uses an exhausted backend only when paid searches are allowed", async () => {
    const m = await freshModule({ SEARCH_ALLOW_PAID: "true" });
    m.markExhausted("tavily", "HTTP 429");

    expect(m.searchChain("tavily", (b) => b === "tavily")).toEqual(["tavily"]);
  });

  it("falls back to the self-hosted instance once the metered ones are spent", async () => {
    const m = await freshModule();
    m.markExhausted("gemini_micro", "HTTP 429");
    m.markExhausted("tavily", "HTTP 432");

    // Nothing to run out of on our own machine, so the assistant keeps working.
    const chain = m.searchChain("gemini_micro", (b) => b !== "brave");

    expect(chain).toEqual(["searxng"]);
    expect(m.isExhausted("searxng")).toBe(false);
    expect(m.costStance("searxng")).toBe("free");
  });

  it("derives Brave's allowance from the renewable credit it grants", async () => {
    // $5 of credit at $5 per 1000 queries — Brave states no query cap itself.
    const m = await freshModule({ BRAVE_MONTHLY_QUOTA: "", BRAVE_FREE_CREDIT_USD: "5" });

    expect(m.quotaFor("brave")).toBe(1000);
  });

  it("never slides onto a backend whose cost it cannot establish", async () => {
    const m = await freshModule();
    // Brave with no stated monthly allowance: possibly billed per query.
    m.setRemoteQuota("brave", {
      used: 0,
      quota: 0,
      stance: "unknown",
      checkedAt: new Date().toISOString(),
    });

    // As a fallback it is skipped...
    expect(m.searchChain("tavily", () => true)).toEqual(["tavily", "gemini_micro", "searxng"]);
    // ...but choosing it explicitly is the user's own decision to make.
    expect(m.searchChain("brave", () => true)[0]).toBe("brave");
  });

  it("believes the provider's own count over its local tally", async () => {
    const m = await freshModule();
    m.recordSearch("tavily"); // this server has seen exactly one

    m.setRemoteQuota("tavily", {
      used: 45, // ...but the key was used elsewhere too
      quota: 1000,
      stance: "free_until_quota",
      checkedAt: new Date().toISOString(),
    });

    expect(m.usedThisMonth("tavily")).toBe(45);
    expect(m.quotaFor("tavily")).toBe(1000);
    const snapshot = m.usageSnapshot().backends.find((b) => b.backend === "tavily");
    expect(snapshot).toMatchObject({ used: 45, remaining: 955, source: "provider" });
  });
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
      "searxng",
      "brave",
    ]);
  });

  it("drops backends whose key is not configured", async () => {
    const m = await freshModule();

    expect(m.searchChain("tavily", (b) => b !== "brave")).toEqual([
      "tavily",
      "gemini_micro",
      "searxng",
    ]);
  });

  it("takes a spent backend out rather than demoting it", async () => {
    const m = await freshModule();
    m.markExhausted("tavily", "HTTP 429");

    // Past its allowance Tavily bills, so it is gone for the month — only
    // backends with free allowance left are offered.
    expect(m.searchChain("tavily", () => true)).toEqual(["gemini_micro", "searxng", "brave"]);
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
