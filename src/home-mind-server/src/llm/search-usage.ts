// Monthly usage accounting for the web-search backends, so the assistant can
// move to a backend that still has quota instead of failing mid-sentence.
//
// None of the three backends reports "requests left this month" on a normal
// response, and their free allowances all reset monthly, so we count locally and
// persist the counters. The count is a floor, not gospel: a request that fails
// after the provider already charged it, or usage from another client sharing the
// same key, will not be seen here. That is why an actual quota rejection (429 /
// 402) also marks the backend exhausted — the observed error is more
// trustworthy than our own tally.
//
// Published free allowances at the time of writing (2026-07):
//   tavily        1000 credits/month, no card required
//   brave         the free tier was withdrawn in Feb 2026; new accounts get $5
//                 of monthly credit (~1000 queries) and are then BILLED
//   gemini_micro  5000 grounded prompts/month included on a BILLED project,
//                 then $14 per 1000
// Override any of them with the *_MONTHLY_QUOTA env vars.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SearchBackend = "gemini_micro" | "tavily" | "brave";

export const SEARCH_BACKENDS: readonly SearchBackend[] = ["gemini_micro", "tavily", "brave"];

const USAGE_PATH = process.env.SEARCH_USAGE_PATH ?? "/data/search-usage.json";

/** Fraction of the monthly quota at which we stop choosing a backend. */
const THRESHOLD = Number(process.env.SEARCH_QUOTA_THRESHOLD ?? "0.9");

const DEFAULT_QUOTAS: Record<SearchBackend, number> = {
  tavily: Number(process.env.TAVILY_MONTHLY_QUOTA ?? "1000"),
  brave: Number(process.env.BRAVE_MONTHLY_QUOTA ?? "2000"),
  gemini_micro: Number(process.env.GEMINI_SEARCH_MONTHLY_QUOTA ?? "5000"),
};

interface UsageFile {
  month: string;
  counts: Partial<Record<SearchBackend, number>>;
  /** Backends that answered with a quota error — skipped until the month rolls. */
  exhausted: Partial<Record<SearchBackend, string>>;
}

function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyFile(): UsageFile {
  return { month: currentMonth(), counts: {}, exhausted: {} };
}

let cache: UsageFile | null = null;

function load(): UsageFile {
  if (cache && cache.month === currentMonth()) return cache;
  let data = emptyFile();
  try {
    if (existsSync(USAGE_PATH)) {
      const parsed = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as UsageFile;
      if (parsed?.month === currentMonth()) {
        data = {
          month: parsed.month,
          counts: parsed.counts ?? {},
          exhausted: parsed.exhausted ?? {},
        };
      } else if (parsed?.month) {
        // New month: allowances reset, so drop the counters AND the exhausted flags.
        console.log(`[search] new quota month (${parsed.month} -> ${currentMonth()}) — counters reset`);
      }
    }
  } catch (err) {
    console.warn(`[search] could not read usage file: ${(err as Error).message}`);
  }
  cache = data;
  return data;
}

function persist(data: UsageFile): void {
  cache = data;
  try {
    mkdirSync(dirname(USAGE_PATH), { recursive: true });
    writeFileSync(USAGE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    // Non-fatal: counting continues in memory for this process.
    console.warn(`[search] could not persist usage: ${(err as Error).message}`);
  }
}

export function quotaFor(backend: SearchBackend): number {
  return DEFAULT_QUOTAS[backend];
}

export function usedThisMonth(backend: SearchBackend): number {
  return load().counts[backend] ?? 0;
}

export function isExhausted(backend: SearchBackend): boolean {
  const data = load();
  if (data.exhausted[backend]) return true;
  const quota = quotaFor(backend);
  if (quota <= 0) return false; // 0 = "unmetered", never blocks
  return (data.counts[backend] ?? 0) >= quota * THRESHOLD;
}

export function recordSearch(backend: SearchBackend): void {
  const data = load();
  const used = (data.counts[backend] ?? 0) + 1;
  data.counts[backend] = used;
  persist(data);

  const quota = quotaFor(backend);
  if (quota > 0) {
    const pct = Math.round((used / quota) * 100);
    // Warn once we cross the threshold so the switch is visible in the log.
    if (used === Math.ceil(quota * THRESHOLD)) {
      console.warn(
        `[search] ${backend} reached ${pct}% of its monthly quota (${used}/${quota}) — ` +
          "switching to another backend for the rest of the month"
      );
    }
  }
}

export function markExhausted(backend: SearchBackend, reason: string): void {
  const data = load();
  if (!data.exhausted[backend]) {
    console.warn(`[search] ${backend} is out of quota (${reason}) — skipping it until next month`);
  }
  data.exhausted[backend] = new Date().toISOString();
  persist(data);
}

/**
 * Order the backends to try: the preferred one first, then the rest as fallback.
 * `available` filters out backends whose key is missing. Backends over quota are
 * moved to the back rather than dropped, so a fully exhausted month still makes
 * an attempt instead of refusing to answer at all.
 */
export function searchChain(
  preferred: SearchBackend,
  available: (b: SearchBackend) => boolean
): SearchBackend[] {
  const ordered = [preferred, ...SEARCH_BACKENDS.filter((b) => b !== preferred)].filter(available);
  const withQuota = ordered.filter((b) => !isExhausted(b));
  const withoutQuota = ordered.filter((b) => isExhausted(b));
  if (withQuota.length === 0 && ordered.length > 0) {
    console.warn("[search] every configured search backend is at or over quota — trying anyway");
  }
  return [...withQuota, ...withoutQuota];
}

/** Snapshot for GET /api/search/usage (and, later, an HA sensor). */
export function usageSnapshot(): {
  month: string;
  backends: {
    backend: SearchBackend;
    used: number;
    quota: number;
    remaining: number;
    exhausted: boolean;
    exhaustedAt?: string;
  }[];
} {
  const data = load();
  return {
    month: data.month,
    backends: SEARCH_BACKENDS.map((b) => {
      const used = data.counts[b] ?? 0;
      const quota = quotaFor(b);
      return {
        backend: b,
        used,
        quota,
        remaining: quota > 0 ? Math.max(quota - used, 0) : -1,
        exhausted: isExhausted(b),
        ...(data.exhausted[b] ? { exhaustedAt: data.exhausted[b] } : {}),
      };
    }),
  };
}

/** Test seam: forget the in-memory cache. */
export function resetUsageCache(): void {
  cache = null;
}
