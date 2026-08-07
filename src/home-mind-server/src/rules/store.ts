/**
 * House rules: the operating instructions for this particular home.
 *
 * They live here rather than in the Home Assistant custom prompt because a
 * single block of text is a poor thing to edit. One careless keystroke removes
 * a rule nobody remembers writing, there is no way to mark the ones that must
 * not be touched, and order — which decides who wins a contradiction — is
 * invisible. As a list each rule can be edited, disabled, protected and moved
 * on its own.
 *
 * Order matters and is preserved exactly: later rules are appended later in the
 * prompt, and a later instruction beats an earlier one when the two disagree.
 * That is not a theory — a built-in section telling the assistant to "infer the
 * most likely intended word and act on it" quietly overrode a custom rule that
 * told it to ask, until the built-in one was removed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { envOrUndefined } from "../env.js";

/**
 * Read per call, not once at import.
 *
 * A module-level constant cannot be redirected by a test, so the suite would
 * write to the real `/data` — which is either the running system's rules or, on
 * a machine without that directory, a crash inside fact extraction.
 */
function rulesPath(): string {
  return envOrUndefined("RULES_PATH") ?? "/data/rules.json";
}

export interface HouseRule {
  id: string;
  /** Short label shown in the editor; not sent to the model. */
  title: string;
  /** The instruction itself, verbatim into the prompt. */
  text: string;
  /** Disabled rules stay in the list but leave the prompt entirely. */
  enabled: boolean;
  /**
   * Protected rules are the ones whose loss would be felt long before it was
   * noticed — the assistant claiming it did something it did not, for
   * instance. The editor marks them and asks twice; nothing here forbids
   * deleting one, because a rule that cannot be removed eventually becomes a
   * rule that cannot be corrected.
   */
  protected: boolean;
  /**
   * Written by the assistant rather than by a person.
   *
   * The extractor spots operating procedures in conversation and used to throw
   * them away, because a procedure stored as a fact goes stale and then argues
   * with the prompt. Filing them here instead keeps the signal without the
   * risk: a suggestion is always saved disabled, so it changes nothing until
   * someone reads it, checks it against the rest and turns it on.
   */
  suggested: boolean;
}

/** In-memory copy so prompt building stays synchronous and cheap. */
let cache: HouseRule[] | null = null;
/** Which file the cache belongs to, so a redirected path is never served stale. */
let cachedPath: string | null = null;

function readFromDisk(path: string): HouseRule[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.warn(`[rules] ${path} is not a list — ignoring it`);
      return [];
    }
    return parsed.filter(isRule);
  } catch (err) {
    // A broken file must not take the assistant down with it: without rules it
    // still answers, and the custom prompt still applies.
    console.error(`[rules] cannot read ${path}:`, err);
    return [];
  }
}

function isRule(value: unknown): value is HouseRule {
  const r = value as HouseRule;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.text === "string" &&
    typeof r.enabled === "boolean" &&
    typeof r.protected === "boolean"
  );
}

export function loadRules(): HouseRule[] {
  const path = rulesPath();
  if (cache === null || cachedPath !== path) {
    cache = readFromDisk(path);
    cachedPath = path;
  }
  return cache;
}

export function saveRules(rules: HouseRule[]): HouseRule[] {
  const clean = rules.filter(isRule).map((r) => ({
    id: r.id,
    title: r.title.trim(),
    text: r.text.trim(),
    enabled: r.enabled,
    protected: r.protected,
    // Older files predate the field; absent means a person wrote it.
    suggested: r.suggested === true,
  }));

  const path = rulesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2), "utf-8");
  cache = clean;
  cachedPath = path;
  console.log(`[rules] saved ${clean.length} rules (${clean.filter((r) => r.enabled).length} enabled)`);
  return clean;
}

/**
 * The enabled rules as one block of prompt text, in list order.
 *
 * Returns undefined when there is nothing to add, so the prompt builder can
 * leave the section out entirely rather than emit an empty heading.
 */
export function rulesForPrompt(): string | undefined {
  const enabled = loadRules().filter((r) => r.enabled && r.text.trim());
  if (enabled.length === 0) return undefined;
  return enabled.map((r) => r.text.trim()).join("\n\n");
}

/**
 * How many unreviewed suggestions may wait at once.
 *
 * The extractor runs on every turn, so without a ceiling a week of chatter
 * could bury the handful of rules a person actually wrote. When the queue is
 * full new proposals are dropped rather than rotated: the older ones have been
 * waiting longer and nothing here can tell which is the better advice.
 */
const MAX_PENDING_SUGGESTIONS = 20;

/** Same wording, different spacing or case, is the same rule. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * File a rule proposed by the assistant, disabled and marked as such.
 *
 * Silently ignores a proposal whose text already exists, so the same advice
 * repeated across conversations does not pile up as duplicates.
 */
export function suggestRule(title: string, text: string): HouseRule | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const existing = loadRules();
  const wzorzec = normalize(trimmed);
  if (existing.some((r) => normalize(r.text) === wzorzec)) return null;

  const czekajace = existing.filter((r) => r.suggested && !r.enabled).length;
  if (czekajace >= MAX_PENDING_SUGGESTIONS) {
    console.warn(
      `[rules] ${czekajace} suggestions already waiting — dropping "${title}"`
    );
    return null;
  }

  const rule: HouseRule = {
    id: `s${Date.now().toString(36)}`,
    title: title.trim() || "Sugestia asystenta",
    text: trimmed,
    enabled: false,
    protected: false,
    suggested: true,
  };
  try {
    saveRules([...existing, rule]);
  } catch (err) {
    // Filing a suggestion runs inside fact extraction. A write that fails —
    // a read-only volume, a full disk — must cost us the suggestion and
    // nothing else; the facts from that same turn still have to be stored.
    console.error(`[rules] could not file a suggestion:`, err);
    return null;
  }
  console.log(`[rules] assistant suggested a rule: ${rule.title}`);
  return rule;
}

/** Test seam: drop the cache so the next read hits the disk again. */
export function resetRulesCache(): void {
  cache = null;
  cachedPath = null;
}
