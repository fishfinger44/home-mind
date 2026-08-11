import type { Fact } from "./types.js";

/**
 * The existing facts, as a numbered list.
 *
 * They used to go in as pretty-printed JSON objects, each carrying a ULID and
 * a category: roughly forty tokens of scaffolding around ten tokens of
 * content, repeated for every fact in the profile, on every single turn. The
 * model needs only two things from this list — the wording, so it can spot a
 * duplicate, and a handle to point at what a new fact supersedes. A line
 * number is that handle, and the caller maps it back to the real id. The
 * category is the extractor's own output, so feeding it back teaches nothing.
 */
export function formatExistingFacts(facts: Fact[]): { section: string; ids: string[] } {
  if (facts.length === 0) {
    return { section: "No existing facts stored yet.", ids: [] };
  }

  const lines = facts.map((f, i) => `${i + 1}. ${f.content}`);
  return {
    section: `Existing facts, numbered (check whether a new fact duplicates or replaces one):\n${lines.join("\n")}`,
    ids: facts.map((f) => f.id),
  };
}

/**
 * Turn whatever the model put in `replaces` back into fact ids.
 *
 * It is asked for line numbers, but a model that has seen ids elsewhere in the
 * conversation sometimes echoes one, and numbers arrive as strings about as
 * often as numbers. Anything resolving to neither is dropped rather than
 * guessed at: a bad reference here deletes a fact nobody meant to touch.
 */
export function resolveReplaces(replaces: unknown, ids: string[]): string[] {
  if (!Array.isArray(replaces)) return [];

  const resolved: string[] = [];
  for (const entry of replaces) {
    if (typeof entry === "number" || (typeof entry === "string" && /^\s*\d+\s*$/.test(entry))) {
      const index = Number(entry) - 1;
      if (Number.isInteger(index) && index >= 0 && index < ids.length) {
        resolved.push(ids[index]);
      }
      continue;
    }
    if (typeof entry === "string" && ids.includes(entry)) resolved.push(entry);
  }
  return resolved;
}

/**
 * Fill the prompt's placeholders.
 *
 * A plain `String.replace` with a string pattern would read `$&` and friends
 * in the *replacement* as substitution syntax — so a user message containing
 * one would silently corrupt the prompt. A replacer function is exempt from
 * that reading.
 */
export function fillExtractionPrompt(values: {
  existingFactsSection: string;
  userMessage: string;
  assistantResponse: string;
}): string {
  return EXTRACTION_PROMPT.replace("{existing_facts_section}", () => values.existingFactsSection)
    .replace("{user_message}", () => values.userMessage)
    .replace("{assistant_response}", () => values.assistantResponse)
    // Today's date is computed here rather than passed in: the extractor has no
    // business deciding what day it is, and a caller that forgot the argument
    // would silently produce anchors dated to nothing.
    .replace("{today}", () => new Date().toISOString().slice(0, 10));
}

export const EXTRACTION_PROMPT = `You are a memory extraction assistant for a smart home AI. Analyze this conversation and extract ONLY long-term facts worth remembering about the user and their home.

WRITE EVERY "content" IN POLISH. These instructions are in English; the memory is not.
The household speaks Polish, so the questions that later search this memory are Polish,
and semantic recall matches text to text: an English fact is nearly invisible to a Polish
question. Measured in this home — the same fact scored 0.234 in Polish and 0.022 in
English against the same Polish question. Write what the user said, in their language,
as a complete sentence. Only "category" stays in English, because it is a key, not prose.

Categories (use exactly these):
- baseline: Sensor normal values ("NOx 100ppm is normal for my home")
- preference: User preferences ("I prefer 22°C", "I like lights dim")
- identity: User info ("my name is Jure", "I'm also called Hoornet")
- device: Device nicknames ("call light.wled_kitchen the main kitchen light")
- pattern: Routines ("I usually get home by 6pm")
- correction: Corrections to previous knowledge ("actually X is normal, not Y")

DO NOT extract any of these — they are garbage and pollute memory:
- Current device states: "the kitchen light is currently red", "sensor shows 22°C right now", "the light is on"
- Actions the assistant just performed: "I turned on the kitchen light", "I set brightness to 50%"
- One-time commands or queries: "turn off the light", "what's the temperature". A command ("set kitchen to red") is NOT a preference. Only store preferences when the user explicitly says "I prefer", "I like", "I want it to always be", etc.
- Device capabilities, specs, or attributes: supported features, effect lists, color modes, firmware, protocol info. The "device" category is ONLY for user-assigned nicknames like "call the kitchen light Big Bertha".
- Information from the system prompt or assistant's built-in knowledge: room name mappings, entity configurations, assistant instructions. Only extract facts from what the USER explicitly states in their messages.
- Inferred facts the user never stated: If the user asks "what's the living room temperature", do NOT store "sensor X is in the living room". Only store facts the user explicitly tells you.
- Troubleshooting observations from a single event: "hardware sync issue", "device not responding", "color mode not supported"
- The assistant's own failures or workarounds: "I used rgb_color instead of color_temp", "the command failed"
- Anything that would change in minutes/hours: weather, current time, who is home right now
- Duplicates of existing facts (check the list below)

GOOD extractions (persist across sessions, content in Polish):
[{{"content": "Lech woli temperaturę 20°C w sypialni", "category": "preference", "confidence": 0.9, "replaces": []}}]
[{{"content": "Użytkownik ma na imię Lech", "category": "identity", "confidence": 1.0, "replaces": []}}]
[{{"content": "Odczyt czujnika NOx na poziomie 100 ppm jest w tym domu normalny", "category": "baseline", "confidence": 0.8, "replaces": []}}]

BAD extractions (never store these):
[{{"content": "Światło w kuchni świeci teraz na czerwono", ...}}]  <- transient state
[{{"content": "Asystent włączył światło w sypialni", ...}}]  <- action just performed
[{{"content": "Urządzenie ma problem z synchronizacją sprzętową", ...}}]  <- single-event diagnosis
[{{"content": "Użyto rgb_color, bo color_temp nie zadziałał", ...}}]  <- assistant workaround
[{{"content": "light.led_strip_colors_kitchen obsługuje tryby RGBW i color_temp", ...}}]  <- device spec dump
[{{"content": "Lech woli, żeby światła w kuchni były czerwone", ...}}]  <- one-time command, NOT a stated preference
[{{"content": "Korytarz nazywa się hodnik", ...}}]  <- from system prompt/room mappings, not user-stated
[{{"content": "Czujnik SNZB znajduje się w salonie", ...}}]  <- inferred from context, user never said this

If in doubt, return [] — it is better to miss a fact than to store garbage.

ANCHOR ANYTHING THAT AGES. Today is {today}. A fact is stored for years, so a
number that only holds for a while must be written so that it cannot rot into a
confident falsehood. Never store a bare age, size, count, duration or "recently";
store what stays true instead, or pin the reading to its date:
- "mój syn ma 5 miesięcy" -> "Syn Tadeusz urodził się około marca 2026" (a birth date never ages; the age is derived)
- "cisy sąsiada mają 30 cm" -> "Cisy sąsiada mierzyły 30 cm w sierpniu 2026" (a growing plant is a snapshot, so it carries its date)
- "uczę się hiszpańskiego od dwóch lat" -> "Zaczął uczyć się hiszpańskiego około 2024"
- A stable trait needs no anchor: "woli 22°C", "pies jest mieszańcem owczarka niemieckiego", "ma na imię Lech".
Prefer the anchor to the snapshot: derived-from-a-date is worth more than dated-and-frozen, because it stays correct without anyone revisiting it.

{existing_facts_section}

Conversation:
User: {user_message}
Assistant: {assistant_response}

Return ONLY a JSON array of facts to remember. Each fact must have:
- "content": A complete, standalone statement about the USER or their home (not about the assistant), IN POLISH
- "category": One of the categories above
- "confidence": 0.0 to 1.0 — how confident you are this is a lasting fact (not transient)
- "replaces": Array of NUMBERS from the numbered list of existing facts that this new fact supersedes (empty if none)

Return empty array [] if no facts worth remembering.

Important:
- Only extract SIGNIFICANT facts that should persist across sessions
- Make facts self-contained and clear
- If a new fact updates/changes an existing fact about the SAME TOPIC, include that fact's NUMBER in "replaces"
- Return valid JSON only, no explanation`;

export const VALID_CATEGORIES = [
  "baseline",
  "preference",
  "identity",
  "device",
  "pattern",
  "correction",
] as const;
