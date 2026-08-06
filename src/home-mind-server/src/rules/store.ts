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

const RULES_PATH = envOrUndefined("RULES_PATH") ?? "/data/rules.json";

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
}

/** In-memory copy so prompt building stays synchronous and cheap. */
let cache: HouseRule[] | null = null;

function readFromDisk(): HouseRule[] {
  if (!existsSync(RULES_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(RULES_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.warn(`[rules] ${RULES_PATH} is not a list — ignoring it`);
      return [];
    }
    return parsed.filter(isRule);
  } catch (err) {
    // A broken file must not take the assistant down with it: without rules it
    // still answers, and the custom prompt still applies.
    console.error(`[rules] cannot read ${RULES_PATH}:`, err);
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
  if (cache === null) cache = readFromDisk();
  return cache;
}

export function saveRules(rules: HouseRule[]): HouseRule[] {
  const clean = rules.filter(isRule).map((r) => ({
    id: r.id,
    title: r.title.trim(),
    text: r.text.trim(),
    enabled: r.enabled,
    protected: r.protected,
  }));

  mkdirSync(dirname(RULES_PATH), { recursive: true });
  writeFileSync(RULES_PATH, JSON.stringify(clean, null, 2), "utf-8");
  cache = clean;
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

/** Test seam: drop the cache so the next read hits the disk again. */
export function resetRulesCache(): void {
  cache = null;
}
