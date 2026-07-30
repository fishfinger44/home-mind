// Monthly usage accounting for the web-search backends, so the assistant can
// move to a backend that still has quota — and stop searching entirely rather
// than spend money once nothing free is left.
//
// Where the numbers come from, best source first:
//   1. the provider itself — Tavily's /usage endpoint, Brave's x-ratelimit-*
//      response headers. Authoritative: it counts every use of the key, not
//      just ours, and it reflects plan changes we would never hear about.
//   2. a quota rejection (429/402) — an observed refusal beats any tally.
//   3. our own local count against the published allowance, as a floor for
//      backends that report nothing (the grounded micro-call).
//
// Published free allowances at the time of writing (2026-07):
//   tavily        1000 credits/month, no card required
//   brave         the free tier was withdrawn in Feb 2026; an account gets 5 USD
//                 of credit each month, renewed, and is BILLED past it
//   gemini_micro  5000 grounded prompts/month on a BILLED project, then $14/1000
//   searxng       self-hosted metasearch: unmetered, and free by construction
// Override any of them with the *_MONTHLY_QUOTA env vars.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { envNumber, envOrUndefined } from "../env.js";
import { dirname } from "node:path";

export type SearchBackend = "gemini_micro" | "tavily" | "searxng" | "brave";

// Fallback order when the preferred backend cannot answer. The self-hosted
// metasearch instance sits ahead of Brave deliberately: it costs nothing and
// asks nobody's permission, so it is the right place to land when the metered
// backends are spent.
export const SEARCH_BACKENDS: readonly SearchBackend[] = [
  "gemini_micro",
  "tavily",
  "searxng",
  "brave",
];

const USAGE_PATH = envOrUndefined("SEARCH_USAGE_PATH") ?? "/data/search-usage.json";

/** Fraction of the monthly quota at which we stop choosing a backend. */
const THRESHOLD = envNumber("SEARCH_QUOTA_THRESHOLD", 0.9);

/**
 * Brave publishes no allowance in queries — it grants a renewable 5 USD of
 * credit each month and bills per thousand requests. So derive the number of
 * queries that credit buys, and treat that as the monthly quota. It is an
 * estimate (the rate depends on the plan), which is why an actual 402/429 still
 * overrides it.
 */
function braveQuotaFromCredit(): number {
  const credit = envNumber("BRAVE_FREE_CREDIT_USD", 5);
  const pricePerThousand = envNumber("BRAVE_PRICE_PER_1K_USD", 5);
  if (pricePerThousand <= 0) return 0;
  return Math.floor((credit / pricePerThousand) * 1000);
}

const DEFAULT_QUOTAS: Record<SearchBackend, number> = {
  tavily: envNumber("TAVILY_MONTHLY_QUOTA", 1000),
  brave: envNumber("BRAVE_MONTHLY_QUOTA", braveQuotaFromCredit()),
  gemini_micro: envNumber("GEMINI_SEARCH_MONTHLY_QUOTA", 5000),
  // Self-hosted: no account, no allowance, nothing to run out of.
  searxng: 0,
};

/**
 * What using one more search on this backend would cost.
 *
 * - `free`            the provider states an allowance and we are inside it
 * - `free_until_quota` free up to a published limit, BILLED past it
 * - `unknown`         the provider tells us nothing we can trust — it may bill
 *                     on the very next query
 */
export type CostStance = "free" | "free_until_quota" | "unknown";

/** Numbers reported by the provider itself, which beat our local tally. */
export interface RemoteQuota {
  used: number;
  /** 0 = the provider states no monthly cap (which is not the same as free). */
  quota: number;
  stance: CostStance;
  checkedAt: string;
}

interface UsageFile {
  month: string;
  counts: Partial<Record<SearchBackend, number>>;
  /** Backends that answered with a quota error — skipped until the month rolls. */
  exhausted: Partial<Record<SearchBackend, string>>;
  /** Last figures each provider reported about itself. */
  remote?: Partial<Record<SearchBackend, RemoteQuota>>;
}

function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyFile(): UsageFile {
  return { month: currentMonth(), counts: {}, exhausted: {}, remote: {} };
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
          remote: parsed.remote ?? {},
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

/** The provider's own figures for a backend, when we have fetched them. */
export function remoteQuota(backend: SearchBackend): RemoteQuota | undefined {
  return load().remote?.[backend];
}

/**
 * Store what a provider says about itself. These numbers replace our local
 * tally, which only ever counted the searches THIS server made — the key may
 * well have been used elsewhere (it usually has).
 */
export function setRemoteQuota(backend: SearchBackend, quota: RemoteQuota): void {
  const data = load();
  data.remote = { ...(data.remote ?? {}), [backend]: quota };
  persist(data);
}

/** Milliseconds since the provider's figures were last fetched. */
export function remoteQuotaAge(backend: SearchBackend): number {
  const at = load().remote?.[backend]?.checkedAt;
  return at ? Date.now() - new Date(at).getTime() : Number.POSITIVE_INFINITY;
}

export function quotaFor(backend: SearchBackend): number {
  const remote = remoteQuota(backend);
  if (remote && remote.quota > 0) return remote.quota;
  return DEFAULT_QUOTAS[backend];
}

export function usedThisMonth(backend: SearchBackend): number {
  const remote = remoteQuota(backend);
  // The provider counts every use of the key, including from other clients.
  return Math.max(remote?.used ?? 0, load().counts[backend] ?? 0);
}

/**
 * What one more search here would cost. `unknown` is reserved for a provider
 * that reports figures we cannot interpret; a backend we have no figures for at
 * all falls back to its published allowance.
 */
export function costStance(backend: SearchBackend): CostStance {
  // Our own instance on our own machine — the one backend that can never bill.
  if (backend === "searxng") return "free";
  const remote = remoteQuota(backend);
  if (remote) return remote.stance;
  return "free_until_quota";
}

export function isExhausted(backend: SearchBackend): boolean {
  const data = load();
  if (data.exhausted[backend]) return true;
  const quota = quotaFor(backend);
  if (quota <= 0) return false; // 0 = "unmetered", never blocks
  return usedThisMonth(backend) >= quota * THRESHOLD;
}

export function recordSearch(backend: SearchBackend): void {
  const data = load();
  data.counts[backend] = (data.counts[backend] ?? 0) + 1;
  persist(data);

  const used = usedThisMonth(backend);
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
 * `available` filters out backends whose key is missing.
 *
 * A backend that is out of quota is DROPPED, not demoted. Past the free
 * allowance every one of these bills a card, so an empty chain — no search at
 * all, and the assistant saying so — is the correct outcome, not a fallback
 * worth making. Set SEARCH_ALLOW_PAID=true to spend money deliberately.
 *
 * The same caution applies to a backend whose cost we cannot establish: it is
 * used only when explicitly chosen, never picked up as an automatic fallback.
 */
export function searchChain(
  preferred: SearchBackend,
  available: (b: SearchBackend) => boolean
): SearchBackend[] {
  const allowPaid = (envOrUndefined("SEARCH_ALLOW_PAID") ?? "false").toLowerCase() === "true";
  const ordered = [preferred, ...SEARCH_BACKENDS.filter((b) => b !== preferred)].filter(available);

  const usable = ordered.filter((backend) => {
    if (isExhausted(backend) && !allowPaid) return false;
    // "Unknown cost" is fine when the user picked this backend themselves —
    // that is a deliberate choice. Sliding onto it automatically is not.
    if (costStance(backend) === "unknown" && backend !== preferred && !allowPaid) return false;
    return true;
  });

  if (usable.length === 0 && ordered.length > 0) {
    console.warn(
      "[search] no backend has free allowance left this month — refusing to search " +
        "(set SEARCH_ALLOW_PAID=true to use a paid one)"
    );
  }
  return usable;
}

/** Snapshot for GET /api/search/usage and the HA sensors. */
export function usageSnapshot(): {
  month: string;
  backends: {
    backend: SearchBackend;
    used: number;
    quota: number;
    remaining: number;
    exhausted: boolean;
    /** Whether the figures come from the provider or from our own tally. */
    source: "provider" | "local";
    cost: CostStance;
    checkedAt?: string;
    exhaustedAt?: string;
  }[];
} {
  const data = load();
  return {
    month: data.month,
    backends: SEARCH_BACKENDS.map((b) => {
      const remote = remoteQuota(b);
      const used = usedThisMonth(b);
      const quota = quotaFor(b);
      return {
        backend: b,
        used,
        quota,
        remaining: quota > 0 ? Math.max(quota - used, 0) : -1,
        exhausted: isExhausted(b),
        source: remote ? ("provider" as const) : ("local" as const),
        cost: costStance(b),
        ...(remote ? { checkedAt: remote.checkedAt } : {}),
        ...(data.exhausted[b] ? { exhaustedAt: data.exhausted[b] } : {}),
      };
    }),
  };
}

/** Test seam: forget the in-memory cache. */
export function resetUsageCache(): void {
  cache = null;
}
