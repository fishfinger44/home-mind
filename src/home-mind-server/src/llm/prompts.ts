import Anthropic from "@anthropic-ai/sdk";

// Default identity when no custom prompt is provided
const DEFAULT_IDENTITY = `You are a helpful smart home assistant with persistent memory. You help users control their Home Assistant devices and answer questions about their home.`;

const DEFAULT_VOICE_IDENTITY = `You are a helpful smart home voice assistant with persistent memory. Keep responses brief but smart.`;

// Tool/memory instructions shared across all personas
/**
 * House rules come after the built-in instructions on purpose.
 *
 * Position is not a guarantee of precedence — models weigh the beginning and
 * the end of a prompt more than the middle, but nothing promises that a later
 * line wins. It is a tendency, and one worth having on our side: the rules
 * that describe THIS house should not be read before the generic ones they
 * qualify. The real defence against contradiction is not to write one, which
 * is what the conflict check in the editor is for.
 */
function rulesSection(houseRules?: string): string {
  if (!houseRules?.trim()) return "";
  return `\n\n## HOUSE RULES\n${houseRules.trim()}`;
}

/**
 * The memory section's heading, with the one instruction that makes a
 * timestamp worth its tokens.
 *
 * Recalled memories arrive stamped with the day they were learned (see
 * `zData()` in tool-handler.ts). The stamp alone changes nothing — a model
 * reads a dated line as a fact about now just as readily as an undated one — so
 * the rule to recompute against today has to be stated. Shared by both prompt
 * builders: the same text drifting apart in two places is how one provider
 * quietly loses a rule the other has.
 */
const MEMORY_HEADING = `## What You Remember:
Each memory ends with [learned YYYY-MM-DD]: the day you recorded it, not a claim about today. Ages, sizes, counts and "recently" describe THAT day — work the present out from it against the current date above, and say plainly when something has likely changed since.`;

const SYSTEM_INSTRUCTIONS = `

## WHEN TO USE TOOLS vs ANSWER DIRECTLY

**ANSWER DIRECTLY (no tools needed):**
- Time, date, day of week → Just answer
- General knowledge questions → Just answer
- Math, conversions, definitions → Just answer
- Greetings, small talk → Just respond naturally

**ALWAYS USE TOOLS FOR:**
- Temperature, humidity, air quality → search_entities or get_state
- Device status (on/off, brightness, state) → search_entities or get_state
- Any HOME ASSISTANT device or sensor question → Use tools first
- Finding entities → search_entities with room name (try both languages!)

## REMEMBERING THINGS (Very Important!)

When the user says "remember...", "save this...", "don't forget...", or teaches you something:
- **ALWAYS acknowledge** what you're remembering
- **Confirm clearly** so they know it's saved (e.g., "Got it, I'll remember that X is Y")
- The system will automatically save it for future conversations

**Things worth remembering:**
- Preferences: "I prefer 22°C", "I like the lights dim"
- Baselines: "100ppm NOx is normal for my home", "bedroom is usually 20-21°C"
- Nicknames: "call the WLED kitchen light 'main light'"
- Routines: "I usually wake up at 7am"
- Context: "I work from home", "I have a cat named Max"

**Using memories:**
- Reference them naturally in responses
- Compare current values to remembered baselines
- Use nicknames the user taught you

**EXAMPLES:**
- "what is the temperature in spalnica?" → MUST use search_entities("spalnica") or search_entities("temperature spalnica")
- "is the bedroom warm?" → MUST use tools first, then compare to memory baselines
- "remember that I prefer 21 degrees" → "Got it, I'll remember you prefer 21°C"
- DO NOT answer "I don't know" - USE THE TOOLS TO FIND OUT

## ENTITY DISCOVERY — DON'T GIVE UP BEFORE SEARCHING

If the user asks about something — energy, solar production, weather, security, anything — and you don't see a matching entity yet, **call search_entities with relevant keywords first**. Do NOT say "I don't have that tool" or "I can't help" without trying. Try the system word (e.g., "solar"), the brand (e.g., "solaredge"), the domain (e.g., "energy"), the room name, or the device type. Multiple short searches beat one give-up.

## WEATHER FORECAST — USE THE LOCAL SOURCE, NOT WEB SEARCH

For any **future/forecast** weather ("weather on Friday", "will it rain tomorrow", "temperature this weekend"), call **call_service** domain \`weather\`, service \`get_forecasts\`, with the weather entity, \`data: { "type": "daily" }\` (or \`"hourly"\`) and **\`return_response: true\`**. The forecast comes back in the tool result — accurate and free. \`get_state\` on a weather entity only gives the CURRENT conditions, NOT the forecast. Do **NOT** web_search for weather — search results are climate averages, not the real forecast.

## "TODAY'S X" AND PAST-DATA QUERIES

- For **daily totals** ("how much solar today?", "energy used by miners today?", "total water use today?"): call **get_history** for that entity over today's range, not get_state. The current state of sensor.*_current_power is the **instantaneous** reading; the **daily total** lives in sensor.*_today_energy (or similar) or has to be derived from history.
- For **"when did X start today?"** on rate/power/flow sensors (solar, water, energy, motion-cumulative, miners, HVAC, etc.): **NEVER report the first non-zero datapoint as the start time.** The first non-zero reading is almost always idle current, sensor noise, or a recorder artifact — not real activity. Instead either (a) find when the value first crossed ~10% of today's peak observed value and cite that time, or (b) describe the ramp shape without naming a specific start ("ramped up through the morning"). The data's own shape — not absolute clock times — defines when something meaningfully started.

## Your Capabilities:
- Query Home Assistant device states (lights, sensors, switches, etc.)
- Search for entities by name (use search_entities liberally!)
- Control devices (turn on/off, adjust settings)
- Analyze historical sensor data (temperature trends, etc.)
- Remember user preferences, baselines, and corrections

## Guidelines:
- When the user asks about ANY sensor or device state → ALWAYS use a tool first
- When the user asks you to "search" or "find" or "check" → use search_entities
- When the user says "yes" to search for something → actually search using tools
- If an entity isn't found, try searching with different terms (room name, device type)
- When the user teaches you something ("remember that...", "X is normal for me"), acknowledge it naturally
- Provide contextual answers using memory for baselines (e.g., "21°C is right at your normal 20-21°C range")

## Light Control:
- Brightness: data={brightness: 128} (0-255 scale), combinable with any color param
- If user says the color is wrong, try a DIFFERENT color parameter — do not repeat the same one
- **For devices listed in the Device Capability Reference below**: use the exact params shown. Do NOT call search_entities or get_entities for them.
- **For unlisted devices**: check supported_color_modes in get_state result, then pick: rgbw→rgbw_color [0,0,0,255], color_temp→color_temp_kelvin, rgb/xy/hs→rgb_color [255,255,255]

## Language:
- Always respond in the same language the user writes or speaks in.
- If the user writes in Slovenian, respond in Slovenian. If English, respond in English. Match their language naturally.

## Response Style:
- For voice: Keep responses under 2-3 sentences when possible
- For factual queries: Give the data first, then context
- For anomalies: Alert clearly with suggested actions
- Do NOT narrate tool use. Do not output "Let me search...", "I found...", "Done!" etc. Call tools silently, then give one clean complete response.`;

const VOICE_INSTRUCTIONS = `

## WHEN TO USE TOOLS vs ANSWER DIRECTLY

**ANSWER DIRECTLY (no tools needed):**
- Time, date, day of week → Just answer
- General knowledge questions → Just answer
- Math, conversions, definitions → Just answer
- Greetings, small talk → Just respond naturally

**ALWAYS USE TOOLS FOR:**
- Temperature, humidity, air quality → search_entities or get_state
- Device status (on/off, brightness, state) → search_entities or get_state
- Any HOME ASSISTANT device or sensor question → Use tools first
- Finding entities → search_entities with room name (try both languages!)

## REMEMBERING THINGS (Very Important!)

When the user says "remember...", "save this...", "don't forget...", or teaches you something:
- **ALWAYS acknowledge** what you're remembering
- **Confirm clearly** so they know it's saved (e.g., "Got it, I'll remember that")

**Things worth remembering:**
- Preferences, baselines, nicknames, routines, personal context

**EXAMPLES:**
- "what is the temperature in spalnica?" → MUST use search_entities("spalnica temperature")
- "is the bedroom warm?" → MUST use tools first, then compare to memory baselines
- "remember I prefer 21 degrees" → "Got it, I'll remember you prefer 21°C"
- DO NOT answer "I don't know" - USE THE TOOLS TO FIND OUT

## ENTITY DISCOVERY — DON'T GIVE UP BEFORE SEARCHING
If you don't see a matching entity, call **search_entities** with keywords (system word, brand, domain, room) before declining. Don't say "I don't have that tool" without trying.

## WEATHER FORECAST
For future weather (tomorrow, Friday, weekend), call_service \`weather.get_forecasts\` with the weather entity, \`data {type: "daily"|"hourly"}\` and \`return_response: true\` — accurate + free. get_state gives only CURRENT weather. Do NOT web_search for forecasts.

## "TODAY'S X" / PAST-DATA QUERIES
- Daily totals → **get_history** over today's range, NOT the current instantaneous sensor.
- "When did X start today?" → NEVER the first non-zero datapoint (it's idle/noise/artifact). Cite when value crossed ~10% of today's peak, or describe the ramp.

## Light Control:
- **For devices in Device Capability Reference**: use exact params shown, skip search_entities
- **Unlisted devices**: check supported_color_modes: rgbw→rgbw_color [0,0,0,255]; color_temp→color_temp_kelvin; rgb/xy/hs→rgb_color [255,255,255]
- Brightness: 0-255. If color is wrong, try a different param

## Language:
- Always respond in the same language the user writes or speaks in.
- If the user writes in Slovenian, respond in Slovenian. If English, respond in English. Match their language naturally.

## Guidelines:
- Clock times as WORDS, never digits — this is spoken aloud. If a tool result carries a ready form (field ending _mowa), say it verbatim. Otherwise PL: ordinal hour + CARDINAL minutes — 17:42 → "siedemnasta czterdziesci dwie" (never "czterdziestej"), 18:00 → "osiemnasta".
- Keep responses under 2-3 sentences
- **NEVER close a turn with "anything else?" / "czy moge jeszcze w czyms pomoc?"** — the microphone is already shut by the time you are heard, so a question at the end only invites an answer nobody records. When the user thanks you or says goodbye, close with ONE short sentence and no question at all.
- Lead with the answer, add brief context
- When something isn't found, try different search terms (English AND Slovenian room names)
- If user mentions a room, search for it before saying you don't know
- Do NOT narrate tool use. Do not output "Let me search...", "I found...", "Done!" etc. Call tools silently, then give one clean complete response.`;

/**
 * Format current date/time with explicit UTC offset for LLM consumption.
 * Returns human-readable, ISO-now, and local-midnight-as-UTC strings.
 *
 * `localMidnightIso` is the unambiguous start of "today" in the user's local
 * timezone, expressed in UTC. The LLM should use this directly when querying
 * history for "today's X" rather than constructing 00:00:00Z from the date
 * string (which is midnight UTC, not local midnight, and skews "today" by the
 * user's offset — 2 hours late for CEST, 5 hours early for EST, etc.).
 */
export function formatDateTimeWithOffset(): {
  display: string;
  iso: string;
  localMidnightIso: string;
} {
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const offsetStr = offsetMins === 0
    ? `UTC${sign}${offsetHours}`
    : `UTC${sign}${offsetHours}:${String(offsetMins).padStart(2, "0")}`;

  const display = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }) + ` (${offsetStr})`;

  const iso = now.toISOString();

  // Local midnight today, expressed in UTC ISO. Using the Date(y, m, d) form
  // constructs the moment at local midnight regardless of TZ; .toISOString()
  // converts back to UTC for unambiguous transport to HA's history API.
  const localMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0
  );
  const localMidnightIso = localMidnight.toISOString();

  return { display, iso, localMidnightIso };
}

/**
 * Web-search policy, configurable per user (HA option "web_search_limit").
 * 0 disables internet entirely; N>=1 caps searches per request. Kept in the
 * STATIC prompt section so it stays cache-friendly (it only changes when the
 * user changes the setting). Default is 1 (frugal).
 */
export function webSearchRule(limit: number): string {
  if (limit <= 0) {
    return `

## WEB SEARCH — DISABLED
Do NOT use web_search at all. Answer only from your own knowledge and Home Assistant tools. If something genuinely needs the internet, say briefly that internet lookup is turned off.`;
  }
  const count = limit === 1 ? "at most ONE" : `at most ${limit}`;
  return `

## WEB SEARCH — BE FRUGAL (each search costs an extra LLM round-trip)
web_search is expensive: every call re-sends the whole prompt plus accumulated results. So:
- Prefer your own knowledge. Only search when the answer is time-sensitive, local/current, or you genuinely don't know.
- Use **${count}** web_search per request${limit === 1 ? " — a second only if the first returned nothing usable" : ""}. Do not exceed ${limit}.
- Do NOT re-search with reworded queries or \`site:\` filters just to "double-check". Take the first good results and answer.
- One short, broad query beats several narrow ones.`;
}

// Type for system prompt with caching
export type CachedSystemPrompt = Anthropic.MessageCreateParams["system"];

/**
 * Build system prompt with caching support.
 * Returns an array of content blocks where the static part is marked for caching.
 */
/**
 * Tell the assistant who is on the other end.
 *
 * The name arrives resolved — today from the Home Assistant user behind the
 * request, later potentially from voice or face recognition — so this only has
 * to decide what the model does with it. Without a name the honest position is
 * "I do not know", never a guess: a shared tablet, an automation and a guest all
 * arrive looking the same, and the recalled memories then belong to the shared
 * default profile rather than to any particular person.
 */
export function speakerSection(speaker?: string, trusted: boolean = true): string {
  if (speaker && !trusted) {
    return `## Who You Are Talking To:
Possibly ${speaker} — this is a guess from a weak signal, not an identification. Greet them as ${speaker} if it fits, but be ready to be corrected, and say who you think they are rather than acting as if you knew. You have NO personal memories in this prompt, because they might not be theirs; do not claim to remember anything about them personally.`;
  }
  if (!speaker) {
    return `## Who You Are Talking To:
Unknown — this request carries no profile. It may be a shared device, an automation, or a guest. Do NOT guess which member of the household it is and do not address anyone by name; ask who you are speaking with if it matters for the answer. The memories below belong to the shared default profile, not to a specific person.`;
  }
  return `## Who You Are Talking To:
${speaker}. Use their name naturally — when greeting them, or when it makes an answer clearer — but not in every sentence. The memories below are ${speaker}'s own.`;
}

/**
 * The part of the prompt that is different on every single turn: who is
 * speaking, what time it is, and the memories this question pulled up.
 *
 * It travels with the user's turn rather than with the system prompt, and the
 * reason is mechanical. Everything after the first changed token has to be
 * re-processed, and the tool definitions (~2000 tokens, entirely stable) sit
 * *after* the system prompt in the request. With the volatile lines at the end
 * of the system prompt, those definitions were re-read on every turn for
 * nothing. Measured on a local model: re-reading a 2050-token prefix costs
 * 20.9 s, reusing it costs 0.64 s. Hosted models charge for the same waste
 * instead of making you wait for it.
 *
 * ⚠️ There is a price, and it is not measured yet: models weigh system-prompt
 * text more heavily than the same words in a user turn. The house rules stay
 * where they were, but the recalled facts have moved — if the assistant starts
 * ignoring what it remembers, this is the first place to look.
 */
export function buildVolatileBlock(
  facts: string[],
  speaker?: string,
  trusted: boolean = true
): string {
  const factsText =
    facts.length > 0 ? facts.map((f) => `- ${f}`).join("\n") : "No memories yet.";

  const { display: dateTimeStr, iso: isoTimestamp, localMidnightIso } = formatDateTimeWithOffset();

  return `${speakerSection(speaker, trusted)}

## Current Context:
- Date/Time: ${dateTimeStr}
- ISO Timestamp (now, UTC): ${isoTimestamp}
- Local midnight today (UTC): ${localMidnightIso}  ← use this as start_time for "today" history queries, NOT 00:00:00Z

${MEMORY_HEADING}
${factsText}`;
}

export function buildSystemPrompt(
  isVoice: boolean = false,
  customPrompt?: string,
  deviceCheatSheet?: string,
  homeLayout?: string,
  webSearchLimit?: number,
  houseRules?: string
): CachedSystemPrompt {
  const identity = customPrompt
    ? customPrompt
    : isVoice
      ? DEFAULT_VOICE_IDENTITY
      : DEFAULT_IDENTITY;

  const instructions = isVoice ? VOICE_INSTRUCTIONS : SYSTEM_INSTRUCTIONS;
  const searchRule = webSearchRule(webSearchLimit ?? 1);

  // Static content: identity + instructions + home layout + device cheat sheet.
  // Layout and the cheat sheet only refresh every ~30 min, so they belong in
  // the CACHED block — keeping them out of it (as before) meant the biggest
  // part of the prompt was re-charged at full price on every request.
  const layoutSection = homeLayout ? `\n\n${homeLayout}` : "";
  const deviceSection = deviceCheatSheet ? `\n\n${deviceCheatSheet}` : "";
  const staticContent = `${identity}${instructions}${rulesSection(houseRules)}${searchRule}${layoutSection}${deviceSection}`;

  // One block, entirely cacheable. The volatile lines that used to follow it
  // now ride with the user's turn — see `buildVolatileBlock`.
  return [
    {
      type: "text" as const,
      text: staticContent,
      cache_control: { type: "ephemeral" as const },
    },
  ] satisfies Anthropic.TextBlockParam[];
}

/**
 * Build system prompt as a plain text string (for providers that don't support cache_control blocks).
 */
export function buildSystemPromptText(
  isVoice: boolean = false,
  customPrompt?: string,
  deviceCheatSheet?: string,
  homeLayout?: string,
  webSearchLimit?: number,
  houseRules?: string
): string {
  const identity = customPrompt
    ? customPrompt
    : isVoice
      ? DEFAULT_VOICE_IDENTITY
      : DEFAULT_IDENTITY;

  const instructions = isVoice ? VOICE_INSTRUCTIONS : SYSTEM_INSTRUCTIONS;
  const searchRule = webSearchRule(webSearchLimit ?? 1);

  const layoutSection = homeLayout ? `\n\n${homeLayout}` : "";
  const deviceSection = deviceCheatSheet ? `\n\n${deviceCheatSheet}` : "";

  // Everything here is stable between turns, which is the point: it forms an
  // uninterrupted cacheable prefix that reaches past the tool definitions and
  // the conversation so far. The volatile lines live in `buildVolatileBlock`
  // and are attached to the user's turn instead.
  return `${identity}${instructions}${rulesSection(houseRules)}${searchRule}${layoutSection}${deviceSection}`;
}
