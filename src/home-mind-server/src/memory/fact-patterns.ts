/**
 * Shared garbage-detection patterns for fact filtering.
 * Used both at extraction time (tool-handler.ts) and by the periodic cleanup job.
 *
 * ⚠️ These read what the EXTRACTOR wrote, and since 2026-08-11 it writes Polish.
 * Three of the four families below were English-only, so leaving them that way
 * would not have failed loudly — it would have quietly stopped filtering, and
 * the junk would only surface a week later as a memory full of device states.
 * Every family that matches prose therefore matches both languages; the
 * service-call family is mostly identifiers and needs no translation.
 *
 * Content is normalised with `uprosc()` before matching, so Polish patterns are
 * written WITHOUT diacritics — speech-to-text drops them, and `\b` does not
 * behave next to non-ASCII letters.
 */

import { uprosc } from "./tekst.js";

// Patterns that indicate transient state — these should not be stored as long-term facts
export const TRANSIENT_PATTERNS =
  /\b(currently|right now|at the moment|is showing|was just|is displaying|just turned|just set|is now|obecnie|aktualnie|teraz|w tej chwili|w tym momencie|chwilowo|przed chwila|wlasnie (wlaczy|wylaczy|ustawi|zmieni))\b/i;

// Device spec/capability dump patterns — LLM catalogs entity attributes instead of extracting user facts
export const DEVICE_SPEC_PATTERNS =
  /\b(supports?\s+\d+|supports?\s+(rgbw|rgb|color_temp|xy|hs|brightness|on_off)|color.?mode|effect.?list|\d+\+?\s+effects?|firmware|protocol|supported.?features?|supported.?color|(obsluguje|wspiera)\s+(tryb\w*|rgbw|rgb|color_temp|jasnos\w*)|tryb\w* koloru|lista efektow|oprogramowanie ukladowe)\b/i;

// Service-call procedures — the assistant writing down HOW to operate the house
// instead of WHAT is true about it.
//
// These go stale the moment the rules change and nothing links them to the
// system prompt, so the two end up contradicting each other. A real case: the
// prompt said music goes only through script.zagraj_muzyke while memory held
// "wywolaj media_player.play_media ... NIE trzeba sprawdzac stanu", learned
// back when that was the right answer. Worse, decay does not save us — recall
// reinforces whatever it retrieves, so a wrong-but-relevant procedure gets
// stronger every time the subject comes up.
//
// Entity ids are deliberately NOT matched: "main light is light.wled_kitchen"
// is a fact worth keeping. What is matched is SERVICE names, which only appear
// when something is describing a call, and the parameter names that go with them.
export const SERVICE_PROCEDURE_PATTERNS =
  // Distinctive service names, which do not occur in ordinary prose, are matched
  // bare — "using play_media service" is as much a procedure as ".play_media".
  // turn_on/turn_off/toggle only count after a dot, because "turn off the light"
  // is a perfectly good thing for a fact to say.
  /\b(call_service|service_data|media_content_id|media_content_type|play_media|select_source|set_hvac_mode|send_command|volume_set|volume_mute|set_cover_position|select_option|wywołaj|wywolaj)\b|\.(turn_on|turn_off|toggle|open_cover|close_cover|media_play|media_pause|press)\b/i;

// Command-echo patterns — assistant restating what it just did, not a user-stated fact
//
// The Polish side matches the impersonal past ("ustawiono", "wlaczono"), which
// is how the assistant reports its own actions, and the passive participles.
// Deliberately NOT matching bare "ustawil"/"wlaczyl": "Lech wlaczyl ogrzewanie
// podlogowe w 2024" is a fact about the house, not an echo.
export const COMMAND_ECHO_PATTERNS =
  /\b(was set to|was changed to|was turned|has been set|has been turned|has been changed|ustawiono|wlaczono|wylaczono|zmieniono|zostal[aoy]? (ustawion|wlaczon|wylaczon|zmienion|zgaszon|otwart|zamkniet))\w*\b/i;

/**
 * The reason string for a rejected service-call procedure.
 *
 * Named rather than inlined because the caller acts on this one specifically:
 * a procedure is not garbage, it is an instruction filed in the wrong place, so
 * it is offered as a house rule instead of being dropped. The other reasons
 * describe facts that are simply wrong to keep.
 */
export const SERVICE_PROCEDURE_REASON =
  "service-call procedure (belongs in the system prompt, not memory)";

/**
 * Check if a fact's content matches any garbage pattern.
 * Returns the reason string if it's garbage, or null if it's clean.
 */
export function matchesGarbagePattern(content: string, confidence?: number): string | null {
  if (content.length < 10) {
    return "too short (<10 chars)";
  }

  // Length is measured on the original; everything else on the folded form, so
  // "właśnie" and "wlasnie" are the same word to every pattern below.
  const tekst = uprosc(content);

  if (TRANSIENT_PATTERNS.test(tekst)) {
    return "transient state pattern";
  }

  if (DEVICE_SPEC_PATTERNS.test(tekst)) {
    return "device spec/capability dump";
  }

  if (COMMAND_ECHO_PATTERNS.test(tekst)) {
    return "command echo (restating action)";
  }

  if (SERVICE_PROCEDURE_PATTERNS.test(tekst)) {
    return SERVICE_PROCEDURE_REASON;
  }

  if (typeof confidence === "number" && confidence < 0.5) {
    return `low confidence (${confidence})`;
  }

  return null;
}

/**
 * Filter out garbage facts. Works with any object that has content and optional confidence.
 * Returns kept facts and skipped facts with reasons.
 */
export function filterFacts<T extends { content: string; confidence?: number }>(
  facts: T[]
): { kept: T[]; skipped: { fact: T; reason: string }[] } {
  const kept: T[] = [];
  const skipped: { fact: T; reason: string }[] = [];

  for (const fact of facts) {
    const reason = matchesGarbagePattern(fact.content, fact.confidence);
    if (reason) {
      skipped.push({ fact, reason });
    } else {
      kept.push(fact);
    }
  }

  return { kept, skipped };
}
