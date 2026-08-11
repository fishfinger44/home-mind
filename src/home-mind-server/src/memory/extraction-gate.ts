/**
 * Whether a finished turn is worth running fact extraction over.
 *
 * Extraction is the most expensive thing we do per turn and the least likely
 * to pay: a spoken command carries nothing to remember, yet it costs a full
 * round-trip with the whole profile attached. Home Assistant's own agent
 * already absorbs the commands it understands (`prefer_local`), but two kinds
 * still reach us — commands from a voice we could not place, and commands
 * built on services HA has no intent for, like our music and vacuum scripts.
 *
 * The decision is made *after* the turn on purpose. Before it, we could only
 * guess from wording whether something is a command; afterwards we know what
 * the assistant actually did, which is a firmer signal and needs nothing from
 * Home Assistant's internals — so no future HA release can change its meaning
 * underneath us.
 *
 * Getting it wrong is cheap in both directions: a needless extraction costs
 * tokens we spend today anyway, and a wrongly skipped turn costs one fact that
 * was never learned — never a wrong action, a deleted fact, or a corrupted
 * memory. But a missed fact is *silent*, so every skip is logged with the
 * utterance that caused it; the point is to be able to read back a week of
 * them and see what the filter actually cut.
 */

import { uprosc } from "./tekst.js";

/**
 * Tools that only carry out or read state.
 *
 * `web_search` is deliberately absent: the assistant reaches for it on open
 * questions, and those are conversation rather than commands.
 */
const EXECUTIVE_TOOLS = new Set([
  "call_service",
  "get_state",
  "get_entities",
  "search_entities",
  "get_history",
]);

/**
 * Words that mark a turn as *stating* something rather than ordering it.
 *
 * This list is load-bearing rather than decorative. Corrections to existing
 * facts also travel through extraction, and one phrased as an order — "set the
 * bedroom to 21 and keep it that way" — arrives with `call_service` attached.
 * Without "always"/"zawsze" here, the filter would eat exactly the turns that
 * matter most.
 */
const DECLARATIVE_MARKERS =
  /\b(zapamietaj|zapamietac|pamietaj|wiedz|mam|mamy|jestem|jestesmy|lubie|lubimy|wole|wolimy|nie znosze|nienawidze|nazywa sie|nazywam|u nas|zawsze|zwykle|zazwyczaj|nigdy|codziennie|moj|moja|moje|nasz|nasza|nasze|remember|prefer|always|usually|my name)\b/;

/**
 * A reason to skip extraction for this turn, or null to run it.
 *
 * Shaped like `matchesGarbagePattern()` — a reason string or null — because it
 * does the same job one stage earlier, and the logs read the same way.
 */
export function skipExtraction(userMessage: string, toolsUsed: string[]): string | null {
  // No tools at all means plain conversation, which is where facts live.
  if (toolsUsed.length === 0) return null;

  if (!toolsUsed.every((tool) => EXECUTIVE_TOOLS.has(tool))) return null;

  if (DECLARATIVE_MARKERS.test(uprosc(userMessage))) return null;

  return `wykonanie polecenia (${[...new Set(toolsUsed)].join(", ")}), brak znacznika oznajmujacego`;
}
