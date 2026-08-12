import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, entityIdFrom, extractAndStoreFacts, filterExtractedFacts, normalizeTimestamp, truncateHistory, recallFacts, resolveSearchMode, groundedGeminiSearch, readBraveQuotaHeaders, QuotaError, suggestionTitle,
  daneUslugi,
  znormalizujWywolanie,
  sprawdzPamiec,
} from "./tool-handler.js";
import type { KontekstPamieci } from "./tool-handler.js";
import { loadRules, resetRulesCache } from "../rules/store.js";
import type { HomeAssistantClient } from "../ha/client.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor } from "./interface.js";
import type { ExtractedFact } from "../memory/types.js";

describe("handleToolCall", () => {
  let ha: HomeAssistantClient;

  beforeEach(() => {
    ha = {
      getState: vi.fn().mockResolvedValue({ state: "on" }),
      getEntities: vi.fn().mockResolvedValue([{ entity_id: "light.kitchen" }]),
      searchEntities: vi.fn().mockResolvedValue([{ entity_id: "light.bed" }]),
      callService: vi.fn().mockResolvedValue({ success: true }),
      getHistory: vi.fn().mockResolvedValue([{ state: "22" }]),
    } as unknown as HomeAssistantClient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches get_state to ha.getState", async () => {
    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(ha.getState).toHaveBeenCalledWith("light.kitchen");
    expect(result).toEqual({ state: "on" });
  });

  it("dispatches get_entities to ha.getEntities", async () => {
    const result = await handleToolCall(ha, "get_entities", {
      domain: "light",
    });

    expect(ha.getEntities).toHaveBeenCalledWith("light");
    expect(result).toEqual([{ entity_id: "light.kitchen" }]);
  });

  it("dispatches get_entities without domain", async () => {
    await handleToolCall(ha, "get_entities", {});

    expect(ha.getEntities).toHaveBeenCalledWith(undefined);
  });

  it("dispatches search_entities to ha.searchEntities", async () => {
    const result = await handleToolCall(ha, "search_entities", {
      query: "bedroom",
    });

    expect(ha.searchEntities).toHaveBeenCalledWith("bedroom");
    expect(result).toEqual([{ entity_id: "light.bed" }]);
  });

  it("dispatches call_service to ha.callService", async () => {
    const result = await handleToolCall(ha, "call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
      data: { brightness: 255 },
    });

    expect(ha.callService).toHaveBeenCalledWith(
      "light",
      "turn_on",
      "light.kitchen",
      { brightness: 255 },
      false
    );
    expect(result).toEqual({ success: true });
  });

  it("passes return_response through for response-only services", async () => {
    await handleToolCall(ha, "call_service", {
      domain: "weather",
      service: "get_forecasts",
      entity_id: "weather.home",
      data: { type: "daily" },
      return_response: true,
    });

    expect(ha.callService).toHaveBeenCalledWith(
      "weather",
      "get_forecasts",
      "weather.home",
      { type: "daily" },
      true
    );
  });

  it("takes return_response from data, where models often put it", async () => {
    await handleToolCall(ha, "call_service", {
      domain: "media_assistant",
      service: "search",
      data: { query: "Smerfy", return_response: true },
    });

    // The flag must be lifted out and the field removed: left in data it would
    // be an unexpected key against a strict service schema.
    expect(ha.callService).toHaveBeenCalledWith(
      "media_assistant",
      "search",
      undefined,
      { query: "Smerfy" },
      true
    );
  });

  it("dispatches get_history to ha.getHistory", async () => {
    const result = await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-01-02T00:00:00Z",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z"
    );
    expect(result).toEqual([{ state: "22" }]);
  });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall(ha, "nonexistent_tool", {});

    expect(result).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  it("wraps exceptions in error object", async () => {
    (ha.getState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Connection refused")
    );

    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(result).toEqual({ error: "Connection refused" });
  });

  it("wraps non-Error exceptions in error object", async () => {
    (ha.getState as ReturnType<typeof vi.fn>).mockRejectedValue("string error");

    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(result).toEqual({ error: "string error" });
  });
});

describe("filtering service-call procedures out of memory", () => {
  const odrzucane = [
    // Prawdziwy zapis z pamieci, sprzeczny z promptem
    'Aby zagrać ulubioną muzykę na Denonie: wywołaj media_player.play_media na encji '
      + 'media_player.denon_avr_x2400h z media_content_id="Favorites"',
    "Radio graj przez HEOS: wywołaj media_player.select_source na encji media_player.denon",
    "User can play music on Denon using play_media service with Artist/Album format",
    "To turn off the AC use climate.turn_off and call_service with hvac_mode",
  ];
  const zachowywane = [
    // Nazwa encji w fakcie jest w porzadku — to wiedza o domu, nie procedura
    "Main light in the kitchen is light.wled_kitchen",
    "User has an Apple TV in the living room named media_player.pokoj_dzienny",
    "User's dining room lights are nicknamed 'światła nad stołem'",
    "Normal NOx for this home is around 100ppm",
  ];

  it("drops instructions on how to call services", () => {
    const { kept, skipped } = filterExtractedFacts(
      odrzucane.map((content) => ({ content, category: "device" as const, confidence: 0.9 }))
    );
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(odrzucane.length);
    for (const s of skipped) expect(s.reason).toContain("service-call procedure");
  });

  it("keeps facts that merely name an entity", () => {
    const { kept, skipped } = filterExtractedFacts(
      zachowywane.map((content) => ({ content, category: "device" as const, confidence: 0.9 }))
    );
    expect(skipped).toHaveLength(0);
    expect(kept).toHaveLength(zachowywane.length);
  });
});

describe("odrzucona procedura trafia na liste regul jako sugestia", () => {
  let katalog: string;
  let memory: IMemoryStore;
  let extractor: IFactExtractor;

  const procedura =
    "Radio graj przez HEOS: wywołaj media_player.select_source na encji media_player.denon";

  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), "rules-hook-"));
    process.env.RULES_PATH = join(katalog, "rules.json");
    resetRulesCache();

    memory = {
      getFacts: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn().mockResolvedValue(["id-1"]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;

    extractor = {
      extract: vi.fn().mockResolvedValue([
        { content: procedura, category: "device", confidence: 0.9 },
        { content: "Main light in the kitchen is light.wled_kitchen", category: "device", confidence: 0.9 },
      ]),
    } as unknown as IFactExtractor;
  });

  afterEach(() => {
    rmSync(katalog, { recursive: true, force: true });
    delete process.env.RULES_PATH;
    resetRulesCache();
    vi.clearAllMocks();
  });

  it("zapisuje sugestie WYLACZONA, a fakt zwykly trafia do pamieci", async () => {
    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    const reguly = loadRules();
    expect(reguly).toHaveLength(1);
    expect(reguly[0].text).toBe(procedura);
    expect(reguly[0].suggested).toBe(true);
    // Nic nie dziala, dopoki czlowiek tego nie wlaczy — to cala roznica
    // miedzy sugestia a tym, co pamiec robila wczesniej sama z siebie.
    expect(reguly[0].enabled).toBe(false);

    // Procedura nadal NIE idzie do pamieci — zmienil sie tylko jej los.
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "Main light in the kitchen is light.wled_kitchen", category: "device", confidence: 0.9 },
    ]);
  });

  it("nieudany zapis sugestii nie blokuje zapisu faktow", async () => {
    // Sciezka przez plik zamiast katalogu = mkdir pada (ENOTDIR). Zapis regul
    // dzieje sie w srodku ekstrakcji, wiec jego awaria nie moze zabrac ze soba
    // faktow z tej samej tury.
    writeFileSync(join(katalog, "blokada"), "x", "utf-8");
    process.env.RULES_PATH = join(katalog, "blokada", "rules.json");
    resetRulesCache();

    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "Main light in the kitchen is light.wled_kitchen", category: "device", confidence: 0.9 },
    ]);
  });
});

describe("suggestionTitle", () => {
  it("bierze pierwsze zdanie jako etykiete", () => {
    expect(suggestionTitle("Radio graj przez HEOS: wywołaj select_source")).toBe(
      "Radio graj przez HEOS"
    );
  });

  it("nie lamie etykiety na kropce w id encji", () => {
    // Pierwsza wersja urwala sie na "media_player" — a sugestie skladaja sie
    // wlasnie z identyfikatorow encji.
    expect(suggestionTitle("Radio graj przez media_player.select_source na denonie.")).toBe(
      "Radio graj przez media_player.select_source n…"
    );
  });

  it("skraca dluga tresc zamiast rozpychac liste", () => {
    const tytul = suggestionTitle("a".repeat(80));
    expect(tytul).toHaveLength(46);
    expect(tytul.endsWith("…")).toBe(true);
  });

  it("ma zapasowa etykiete, gdy nie ma z czego jej zrobic", () => {
    expect(suggestionTitle(". reszta")).toBe("Sugestia asystenta");
  });
});

describe("entityIdFrom", () => {
  it("accepts the flat entity_id our tool documents", () => {
    expect(entityIdFrom({ entity_id: "button.kuchnia" })).toBe("button.kuchnia");
  });

  it("accepts Home Assistant's own target syntax", () => {
    // Every HA doc writes it this way, so models reach for it. Dropping the
    // entity here produced a 400 on a real "mop the kitchen" command.
    expect(entityIdFrom({ target: { entity_id: "button.kuchnia" } })).toBe(
      "button.kuchnia"
    );
  });

  it("accepts entity_id tucked into data, the pre-2024 shape", () => {
    expect(entityIdFrom({ data: { entity_id: "vacuum.robot" } })).toBe(
      "vacuum.robot"
    );
  });

  it("joins a list of entities", () => {
    expect(entityIdFrom({ target: { entity_id: ["light.a", "light.b"] } })).toBe(
      "light.a,light.b"
    );
  });

  it("returns undefined when no entity is named", () => {
    expect(entityIdFrom({ domain: "script", service: "turn_on" })).toBeUndefined();
  });

  it("prefers the flat form when both are given", () => {
    expect(
      entityIdFrom({ entity_id: "light.a", target: { entity_id: "light.b" } })
    ).toBe("light.a");
  });
});

describe("filterExtractedFacts", () => {
  it("keeps valid facts", () => {
    const facts: ExtractedFact[] = [
      { content: "User prefers 22°C for the bedroom", category: "preference", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("skips facts shorter than 10 characters", () => {
    const facts: ExtractedFact[] = [
      { content: "Too short", category: "preference", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("too short");
  });

  it("skips facts with transient state patterns", () => {
    const transientFacts: ExtractedFact[] = [
      { content: "Kitchen light is currently displaying red color", category: "device" },
      { content: "Sensor is showing 22 degrees right now in the bedroom", category: "baseline" },
      { content: "The light was just turned on by the assistant", category: "device" },
      { content: "Temperature is now set to 25 degrees", category: "device" },
    ];
    const { kept, skipped } = filterExtractedFacts(transientFacts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(4);
    for (const s of skipped) {
      expect(s.reason).toContain("transient");
    }
  });

  it("skips facts with confidence below 0.5", () => {
    const facts: ExtractedFact[] = [
      { content: "User might prefer warm lighting", category: "preference", confidence: 0.3 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped[0].reason).toContain("low confidence");
  });

  it("keeps facts without confidence field (defaults to acceptable)", () => {
    const facts: ExtractedFact[] = [
      { content: "User prefers lights dim in the evening", category: "preference" },
    ];
    const { kept } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
  });

  it("skips device spec/capability dump facts", () => {
    const facts: ExtractedFact[] = [
      { content: "light.led_strip_colors_kitchen supports RGBW and color_temp modes", category: "device", confidence: 0.9 },
      { content: "light.kitchen supports 170 effects including rainbow and fire", category: "device", confidence: 0.8 },
      { content: "The entity has supported_color modes of rgbw and xy", category: "device", confidence: 0.85 },
      { content: "Device supports brightness and on_off color modes", category: "device", confidence: 0.9 },
      { content: "The light has a firmware version 2.1.3 installed", category: "device", confidence: 0.7 },
      { content: "Light strip supports rgb color mode natively", category: "device", confidence: 0.8 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(6);
    for (const s of skipped) {
      expect(s.reason).toContain("device spec");
    }
  });

  it("skips command echo facts (restating what assistant did)", () => {
    const facts: ExtractedFact[] = [
      { content: "Kitchen light was set to red color by the assistant", category: "device", confidence: 0.8 },
      { content: "Bedroom brightness was changed to 50 percent", category: "device", confidence: 0.7 },
      { content: "Living room light was turned off at night", category: "device", confidence: 0.8 },
      { content: "Temperature has been set to 22 degrees in the bedroom", category: "baseline", confidence: 0.8 },
      { content: "The light color has been changed to blue", category: "device", confidence: 0.7 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(5);
    for (const s of skipped) {
      expect(s.reason).toContain("command echo");
    }
  });

  it("does not false-positive on legitimate facts containing similar words", () => {
    const facts: ExtractedFact[] = [
      { content: "User's name is Jure and he supports open source projects", category: "identity", confidence: 0.9 },
      { content: "User prefers warm white color temperature for evenings", category: "preference", confidence: 0.85 },
      { content: "User calls the kitchen LED strip Big Bertha", category: "device", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it("applies all filters and returns mixed results", () => {
    const facts: ExtractedFact[] = [
      { content: "User's name is Jure", category: "identity", confidence: 1.0 },
      { content: "short", category: "preference", confidence: 0.9 },
      { content: "Light is currently red in the kitchen", category: "device", confidence: 0.8 },
      { content: "Maybe the user likes blue lights", category: "preference", confidence: 0.2 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe("User's name is Jure");
    expect(skipped).toHaveLength(3);
  });
});

describe("extractAndStoreFacts", () => {
  let memory: IMemoryStore;
  let extractor: IFactExtractor;

  beforeEach(() => {
    memory = {
      getFacts: vi.fn().mockResolvedValue([
        { id: "old-1", content: "old fact", category: "preference" },
      ]),
      addFact: vi.fn().mockResolvedValue("new-id"),
      addFacts: vi.fn().mockResolvedValue(["new-id"]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;

    extractor = {
      extract: vi.fn().mockResolvedValue([
        {
          content: "User prefers 22°C for bedroom",
          category: "preference",
          confidence: 0.9,
          replaces: ["old-1"],
        },
      ]),
    } as unknown as IFactExtractor;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls getFacts, extract, deleteFact for replaced, addFacts for new", async () => {
    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "I prefer 22",
      "Got it!"
    );

    expect(memory.getFacts).toHaveBeenCalledWith("user-1");
    expect(extractor.extract).toHaveBeenCalledWith("I prefer 22", "Got it!", [
      { id: "old-1", content: "old fact", category: "preference" },
    ]);
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "old-1");
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9 },
    ]);
    expect(count).toBe(1);
  });

  it("nie wola ekstraktora, gdy tura byla czystym wykonaniem polecenia", async () => {
    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "zapal swiatlo w kuchni",
      "Zapalone.",
      true,
      undefined,
      ["call_service"]
    );

    // Cala oszczednosc polega na tym, ze nie ma round-tripu ani po fakty, ani
    // do modelu — samo pominiecie ekstrakcji nie wystarczyloby.
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(memory.getFacts).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it("ekstrahuje normalnie, gdy wywolujacy nie poda uzytych narzedzi", async () => {
    // Domyslna pusta lista musi zachowywac stare zachowanie, a nie po cichu
    // wlaczac pomijanie.
    await extractAndStoreFacts(memory, extractor, "user-1", "zapal swiatlo", "Zapalone.");
    expect(extractor.extract).toHaveBeenCalled();
  });

  it("stores multiple facts via batch and returns correct count", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "Fact A is a long enough preference", category: "preference", confidence: 0.8, replaces: [] },
      { content: "Fact B is identity information", category: "identity", confidence: 0.9, replaces: [] },
      { content: "Fact C is baseline sensor data", category: "baseline", confidence: 0.7, replaces: [] },
    ]);
    (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue(["id-1", "id-2", "id-3"]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(3);
    expect(memory.addFacts).toHaveBeenCalledTimes(1);
  });

  describe("on a shared profile (allowPersonal = false)", () => {
    beforeEach(() => {
      (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
        { content: "Main light in the kitchen is light.wled_kitchen", category: "device", confidence: 0.9 },
        { content: "Normal NOx reading in the hall is 100ppm", category: "baseline", confidence: 0.8 },
        { content: "Actually the film starts from the Apple TV, not Kodi", category: "correction", confidence: 0.8 },
        { content: "This person prefers 22°C in the bedroom", category: "preference", confidence: 0.9 },
        { content: "The person speaking is called Ania", category: "identity", confidence: 0.9 },
        { content: "This person is usually home by 6pm on weekdays", category: "pattern", confidence: 0.7 },
      ]);
      (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue(["a", "b", "c"]);
    });

    it("keeps what is true of the house and drops what is true of a person", async () => {
      const count = await extractAndStoreFacts(memory, extractor, "default", "msg", "resp", false);

      const stored = (memory.addFacts as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(stored.map((f: { category: string }) => f.category)).toEqual([
        "device",
        "baseline",
        "correction",
      ]);
      expect(count).toBe(3);
    });

    it("still stores everything when the speaker is known", async () => {
      (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue([
        "a", "b", "c", "d", "e", "f",
      ]);

      await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp", true);

      const stored = (memory.addFacts as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(stored).toHaveLength(6);
    });

    it("writes nothing when the conversation was purely personal", async () => {
      (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
        { content: "This person prefers 22°C in the bedroom", category: "preference", confidence: 0.9 },
      ]);

      const count = await extractAndStoreFacts(memory, extractor, "default", "msg", "resp", false);

      expect(count).toBe(0);
      expect(memory.addFacts).not.toHaveBeenCalled();
    });

    it("does not delete a fact that the dropped personal one claimed to replace", async () => {
      (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
        { content: "This person prefers 22°C in the bedroom", category: "preference", confidence: 0.9, replaces: ["old-1"] },
      ]);

      await extractAndStoreFacts(memory, extractor, "default", "msg", "resp", false);

      // Dropping the replacement while honouring its deletion would lose the
      // old fact and store nothing in its place.
      expect(memory.deleteFact).not.toHaveBeenCalled();
    });
  });

  describe("routing writes between the speaker and the house", () => {
    it("files personal facts under the speaker and house facts under the shared profile", async () => {
      const memory = {
        getFacts: vi.fn().mockResolvedValue([]),
        addFacts: vi.fn().mockResolvedValue(["id"]),
        deleteFact: vi.fn().mockResolvedValue(true),
      } as unknown as IMemoryStore;
      const extractor = {
        extract: vi.fn().mockResolvedValue([
          { content: "Prefers 22°C", category: "preference", confidence: 0.9 },
          { content: "Main light is light.wled_kitchen", category: "device", confidence: 0.9 },
          { content: "Normal NOx is 100ppm", category: "baseline", confidence: 0.9 },
        ]),
      } as unknown as IFactExtractor;

      const count = await extractAndStoreFacts(
        memory,
        extractor,
        "lech",
        "msg",
        "resp",
        true,
        "default"
      );

      expect(memory.addFacts).toHaveBeenCalledWith("lech", [
        { content: "Prefers 22°C", category: "preference", confidence: 0.9 },
      ]);
      expect(memory.addFacts).toHaveBeenCalledWith("default", [
        { content: "Main light is light.wled_kitchen", category: "device", confidence: 0.9 },
        { content: "Normal NOx is 100ppm", category: "baseline", confidence: 0.9 },
      ]);
      expect(count).toBe(2);
    });

    it("shows the extractor both profiles so it stops rediscovering house facts", async () => {
      const memory = {
        getFacts: vi.fn(async (userId: string) =>
          userId === "default"
            ? [{ id: "h-1", content: "Main light is light.wled_kitchen", category: "device" }]
            : [{ id: "p-1", content: "Prefers 22°C", category: "preference" }]
        ),
        addFacts: vi.fn().mockResolvedValue(["id"]),
        deleteFact: vi.fn().mockResolvedValue(true),
      } as unknown as IMemoryStore;
      const extractor = {
        extract: vi.fn().mockResolvedValue([]),
      } as unknown as IFactExtractor;

      await extractAndStoreFacts(memory, extractor, "lech", "msg", "resp", true, "default");

      expect(extractor.extract).toHaveBeenCalledWith("msg", "resp", [
        { id: "p-1", content: "Prefers 22°C", category: "preference" },
        { id: "h-1", content: "Main light is light.wled_kitchen", category: "device" },
      ]);
    });

    it("deletes a replaced fact from the profile that actually holds it", async () => {
      const memory = {
        getFacts: vi.fn(async (userId: string) =>
          userId === "default"
            ? [{ id: "h-1", content: "Main light is light.wled_bedroom", category: "device" }]
            : []
        ),
        addFacts: vi.fn().mockResolvedValue(["id"]),
        deleteFact: vi.fn().mockResolvedValue(true),
      } as unknown as IMemoryStore;
      const extractor = {
        extract: vi.fn().mockResolvedValue([
          {
            content: "Main light is light.wled_kitchen",
            category: "device",
            confidence: 0.9,
            replaces: ["h-1"],
          },
        ]),
      } as unknown as IFactExtractor;

      await extractAndStoreFacts(memory, extractor, "lech", "msg", "resp", true, "default");

      // The correction lives in the shared profile. Deleting it against the
      // speaker's profile would no-op and leave both versions in play.
      expect(memory.deleteFact).toHaveBeenCalledWith("default", "h-1");
    });
  });

  it("recalls only impersonal facts on a shared profile", async () => {
    const shared = {
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue([
        { content: "Main light is light.wled_kitchen", category: "device" },
        { content: "Prefers 22°C in the bedroom", category: "preference" },
        { content: "Normal NOx is 100ppm", category: "baseline" },
      ]),
    } as unknown as IMemoryStore;

    // A shared profile still gets what it knows about the house — that is the
    // whole point of letting it learn — but nothing about a person, including
    // anything filed there before the rule existed.
    expect(await recallFacts(shared, "default", "msg", 1500, 1500, false)).toEqual([
      "Main light is light.wled_kitchen",
      "Normal NOx is 100ppm",
    ]);

    expect(await recallFacts(shared, "user-1", "msg", 1500, 1500, true)).toHaveLength(3);
  });

  describe("with a speaker profile alongside the shared one", () => {
    const own = [
      { content: "Prefers 22°C in the bedroom", category: "preference" },
    ];
    const house = [
      { content: "Main light is light.wled_kitchen", category: "device" },
      { content: "Someone works from home", category: "pattern" },
    ];

    function splitMemory() {
      return {
        getFactsWithinTokenLimit: vi.fn(async (userId: string) =>
          userId === "default" ? house : own
        ),
      } as unknown as IMemoryStore;
    }

    it("recalls the speaker's own facts together with the house's", async () => {
      const facts = await recallFacts(
        splitMemory(),
        "lech",
        "msg",
        1500,
        1500,
        true,
        "default"
      );

      // Being recognised must add memory, not remove it: the personal fact and
      // the house fact both come back.
      expect(facts).toEqual([
        "Prefers 22°C in the bedroom",
        "Main light is light.wled_kitchen",
      ]);
    });

    it("never reads a personal fact out of the shared profile", async () => {
      const facts = await recallFacts(
        splitMemory(),
        "lech",
        "msg",
        1500,
        1500,
        true,
        "default"
      );

      // "Someone works from home" sits in the shared profile, so it is about
      // nobody in particular — reading it back as this speaker's own would be
      // the misattribution the split exists to prevent.
      expect(facts).not.toContain("Someone works from home");
    });

    it("keeps the merged recall inside the token budget", async () => {
      const big = {
        getFactsWithinTokenLimit: vi.fn(async () => [
          { content: "x".repeat(400), category: "device" },
          { content: "y".repeat(400), category: "device" },
        ]),
      } as unknown as IMemoryStore;

      // 100 tokens ≈ 400 chars, so exactly one fact fits — asking two profiles
      // must not quietly spend twice the budget.
      const facts = await recallFacts(big, "lech", "msg", 100, 100, true, "default");
      expect(facts).toHaveLength(1);
    });
  });

  it("defaults to allowing personal facts when the flag is omitted", async () => {
    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9 },
    ]);
  });

  it("returns 0 when extraction yields no facts", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(0);
    expect(memory.addFacts).not.toHaveBeenCalled();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("does not call deleteFact when replaces is empty", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "New fact about user preference", category: "preference", confidence: 0.8, replaces: [] },
    ]);

    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("does not call deleteFact when replaces is undefined", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "New fact about user preference", category: "preference", confidence: 0.8 },
    ]);

    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("filters out garbage facts before storing", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9, replaces: [] },
      { content: "Light is currently red in the kitchen", category: "device", confidence: 0.8, replaces: [] },
      { content: "too short", category: "preference", confidence: 0.9, replaces: [] },
    ]);
    (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue(["id-1"]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(1);
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9 },
    ]);
  });
});

describe("normalizeTimestamp", () => {
  it("passes through timestamps with Z suffix unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00Z")).toBe("2026-01-15T20:00:00Z");
    expect(normalizeTimestamp("2026-01-15T20:00:00.000Z")).toBe("2026-01-15T20:00:00.000Z");
  });

  it("passes through timestamps with +HH:MM offset unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00+01:00")).toBe("2026-01-15T20:00:00+01:00");
    expect(normalizeTimestamp("2026-01-15T20:00:00-05:00")).toBe("2026-01-15T20:00:00-05:00");
  });

  it("passes through timestamps with +HHMM offset unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00+0100")).toBe("2026-01-15T20:00:00+0100");
  });

  it("appends Z to bare timestamps", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00")).toBe("2026-01-15T20:00:00Z");
    expect(normalizeTimestamp("2026-01-15T20:00:00.000")).toBe("2026-01-15T20:00:00.000Z");
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeTimestamp(undefined)).toBeUndefined();
  });
});

describe("handleToolCall get_history normalization", () => {
  let ha: HomeAssistantClient;

  beforeEach(() => {
    ha = {
      getState: vi.fn().mockResolvedValue({ state: "on" }),
      getEntities: vi.fn().mockResolvedValue([]),
      searchEntities: vi.fn().mockResolvedValue([]),
      callService: vi.fn().mockResolvedValue({ success: true }),
      getHistory: vi.fn().mockResolvedValue([{ state: "22" }]),
    } as unknown as HomeAssistantClient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes bare start_time and end_time by appending Z", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-15T20:00:00",
      end_time: "2026-01-15T21:00:00",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-15T20:00:00Z",
      "2026-01-15T21:00:00Z"
    );
  });

  it("passes through timestamps that already have timezone info", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-15T20:00:00+01:00",
      end_time: "2026-01-15T21:00:00Z",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-15T20:00:00+01:00",
      "2026-01-15T21:00:00Z"
    );
  });

  it("passes undefined timestamps through without normalization", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      undefined,
      undefined
    );
  });
});

describe("truncateHistory", () => {
  it("strips attributes and keeps all entries when under limit", () => {
    const entries = [
      { entity_id: "sensor.temp", state: "22", attributes: { unit: "°C", friendly_name: "Temperature", icon: "mdi:thermometer" }, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" },
      { entity_id: "sensor.temp", state: "23", attributes: { unit: "°C", friendly_name: "Temperature", icon: "mdi:thermometer" }, last_changed: "2026-01-01T01:00:00Z", last_updated: "2026-01-01T01:00:00Z" },
    ];

    const result = truncateHistory(entries);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ entity_id: "sensor.temp", state: "22", last_changed: "2026-01-01T00:00:00Z" });
    // No attributes in output
    expect((result[0] as any).attributes).toBeUndefined();
  });

  it("downsamples to MAX_HISTORY_ENTRIES when over limit", () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      entity_id: "sensor.temp",
      state: String(20 + (i % 10)),
      attributes: { unit: "°C" },
      last_changed: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
      last_updated: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
    }));

    const result = truncateHistory(entries);
    expect(result.length).toBeLessThanOrEqual(200);
    // First and last preserved
    expect(result[0].state).toBe(entries[0].state);
    expect(result[result.length - 1].state).toBe(entries[entries.length - 1].state);
  });

  it("returns empty array for empty input", () => {
    expect(truncateHistory([])).toEqual([]);
  });
});

describe("recallFacts", () => {
  const makeMemory = () =>
    ({
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue([
        { content: "user likes warm white" },
        { content: "Denon is the living room amp" },
      ]),
    }) as unknown as IMemoryStore;

  it("uses the per-request budget when the caller sets one", async () => {
    const memory = makeMemory();

    const facts = await recallFacts(memory, "user-1", "msg", 500, 1500);

    expect(memory.getFactsWithinTokenLimit).toHaveBeenCalledWith("user-1", 500, "msg");
    expect(facts).toEqual(["user likes warm white", "Denon is the living room amp"]);
  });

  it("falls back to the server default when the request omits it", async () => {
    const memory = makeMemory();

    await recallFacts(memory, "user-1", "msg", undefined, 1500);

    expect(memory.getFactsWithinTokenLimit).toHaveBeenCalledWith("user-1", 1500, "msg");
  });

  it("skips the recall round-trip entirely at 0", async () => {
    const memory = makeMemory();

    const facts = await recallFacts(memory, "user-1", "msg", 0, 1500);

    expect(facts).toEqual([]);
    expect(memory.getFactsWithinTokenLimit).not.toHaveBeenCalled();
  });

  it("treats a server default of 0 as memory disabled", async () => {
    const memory = makeMemory();

    expect(await recallFacts(memory, "user-1", "msg", undefined, 0)).toEqual([]);
    expect(memory.getFactsWithinTokenLimit).not.toHaveBeenCalled();
  });
});

describe("resolveSearchMode", () => {
  it("routes grounding to the billed micro-call when a search key exists", () => {
    // `grounding` only reaches the tool when the engine could not ground itself.
    expect(resolveSearchMode("grounding", true)).toBe("gemini_micro");
  });

  it("falls back to Tavily when grounding is impossible and no search key is set", () => {
    expect(resolveSearchMode("grounding", false)).toBe("tavily");
  });

  it("degrades gemini_micro to Tavily when its key is missing", () => {
    expect(resolveSearchMode("gemini_micro", false)).toBe("tavily");
  });

  it("keeps gemini_micro when the key is there", () => {
    expect(resolveSearchMode("gemini_micro", true)).toBe("gemini_micro");
  });

  it("passes third-party providers through untouched", () => {
    expect(resolveSearchMode("tavily", true)).toBe("tavily");
    expect(resolveSearchMode("brave", true)).toBe("brave");
  });

  it("treats an unset mode like grounding", () => {
    expect(resolveSearchMode(undefined, true)).toBe("gemini_micro");
    expect(resolveSearchMode(undefined, false)).toBe("tavily");
  });
});

describe("groundedGeminiSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_SEARCH_MODEL;
  });

  // Docker Compose sets unconfigured variables to an empty string, which `??`
  // happily keeps — that built a URL with no model in it and came back as a
  // bare 404 that looked like a dead API key.
  it("falls back to the default model when the env var is set but blank", async () => {
    process.env.GEMINI_SEARCH_MODEL = "";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await groundedGeminiSearch("anything", "test-key");

    expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-3.6-flash:generateContent");
  });

  it("returns the answer, its sources and the queries the model ran", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "Canberra" }, { text: " is the capital." }] },
            groundingMetadata: {
              webSearchQueries: ["capital of Australia"],
              groundingChunks: [
                { web: { title: "Wikipedia", uri: "https://example.org/canberra" } },
                { web: { title: "no url" } },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await groundedGeminiSearch("capital of Australia", "test-key");

    expect(out.answer).toBe("Canberra is the capital.");
    expect(out.queries).toEqual(["capital of Australia"]);
    // Chunks without a URL are dropped rather than passed on as empty citations.
    expect(out.results).toEqual([
      { title: "Wikipedia", url: "https://example.org/canberra" },
    ]);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.toolConfig).toEqual({ includeServerSideToolInvocations: true });
    // The whole point of the micro-call: only the query travels, not the prompt.
    expect(JSON.stringify(body.contents)).toContain("capital of Australia");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
  });

  it("raises QuotaError on 429 so the chain moves to another backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "quota" })
    );

    // 429 on a grounded call means the project cannot ground (free tier) or the
    // monthly allowance is gone — either way, stop using this backend.
    await expect(groundedGeminiSearch("anything", "test-key")).rejects.toBeInstanceOf(
      QuotaError
    );
  });

  it("throws a plain error on other failures, leaving the backend in rotation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })
    );

    const err = await groundedGeminiSearch("anything", "test-key").catch((e) => e);
    expect(err).not.toBeInstanceOf(QuotaError);
    expect(String(err)).toContain("Gemini search error 500");
  });
});

describe("readBraveQuotaHeaders", () => {
  // Both modules are imported fresh against a throwaway usage file: the counters
  // live on disk, so without this the first case's numbers leak into the second.
  async function freshModules() {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), "brave-headers-"));
    process.env.SEARCH_USAGE_PATH = join(dir, "usage.json");
    return {
      dir,
      handler: await import("./tool-handler.js"),
      usage: await import("./search-usage.js"),
    };
  }

  afterEach(() => {
    delete process.env.SEARCH_USAGE_PATH;
  });

  // "50, 2000" is per-second then per-month; only the second figure is a
  // monthly allowance.
  it("reads the monthly allowance out of Brave's rate-limit headers", async () => {
    const { handler, usage, dir } = await freshModules();

    handler.readBraveQuotaHeaders(
      new Headers({
        "x-ratelimit-limit": "50, 2000",
        "x-ratelimit-remaining": "49, 1993",
      })
    );

    expect(usage.remoteQuota("brave")).toMatchObject({
      used: 7,
      quota: 2000,
      stance: "free_until_quota",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a credit-based plan that states no allowance in queries", async () => {
    const { handler, usage, dir } = await freshModules();

    handler.readBraveQuotaHeaders(
      new Headers({ "x-ratelimit-limit": "50, 0", "x-ratelimit-remaining": "49, 0" })
    );

    // A monthly limit of 0 says the cap is in dollars, not queries. Recording
    // it as a quota of zero would read as "nothing left" and block the backend
    // for the month; the allowance derived from the credit stays in charge.
    expect(usage.remoteQuota("brave")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("daneUslugi", () => {
  it("przepuszcza normalne wywolanie bez zmian", () => {
    expect(
      daneUslugi({ domain: "calendar", service: "create_event", entity_id: "calendar.x", data: { summary: "Dentysta" } })
    ).toEqual({ summary: "Dentysta" });
  });

  // Zmierzone na zywo: to samo polecenie raz przyszlo poprawnie, raz z polami
  // uslugi o poziom glebiej — HA odrzucal je, bo `data` nie jest polem uslugi.
  it("rozpakowuje data zagniezdzone w data", () => {
    expect(
      daneUslugi({
        domain: "calendar",
        service: "create_event",
        data: {
          entity_id: "calendar.lechfish_gmail_com",
          data: { summary: "Podlewanie kwiatów", start_date_time: "2026-08-11 18:00:00" },
        },
      })
    ).toEqual({
      entity_id: "calendar.lechfish_gmail_com",
      summary: "Podlewanie kwiatów",
      start_date_time: "2026-08-11 18:00:00",
    });
  });

  it("nie rusza pola data, ktore nie jest obiektem", () => {
    expect(daneUslugi({ data: { data: "dwa" } })).toEqual({ data: "dwa" });
    expect(daneUslugi({ data: { data: [1, 2] } })).toEqual({ data: [1, 2] });
  });

  it("radzi sobie z brakiem data", () => {
    expect(daneUslugi({ domain: "light", service: "turn_on" })).toEqual({});
  });

  // Druga zmierzona deformacja: model wsadzil CALE wywolanie do `data`, wiec
  // domain i service zniknely z gory i HA dostawal undefined.
  it("wyciaga domain i service z data, gdy nie ma ich na gorze", () => {
    expect(
      znormalizujWywolanie({
        data: {
          data: { summary: "Podlewanie kwiatów" },
          service: "create_event",
          entity_id: "calendar.lechfish_gmail_com",
          domain: "calendar",
        },
      })
    ).toEqual({
      domain: "calendar",
      service: "create_event",
      data: { summary: "Podlewanie kwiatów", entity_id: "calendar.lechfish_gmail_com" },
    });
  });

  // logbook.log ma WLASNE pole `domain` — bezwarunkowe usuwanie zabraloby mu
  // poprawny argument, wiec ruszamy tylko gdy na gorze go brakuje.
  it("nie zabiera pola domain uslugom, ktore maja je na gorze", () => {
    expect(
      znormalizujWywolanie({
        domain: "logbook",
        service: "log",
        data: { name: "Test", message: "x", domain: "light" },
      })
    ).toEqual({
      domain: "logbook",
      service: "log",
      data: { name: "Test", message: "x", domain: "light" },
    });
  });
});

describe("sprawdzPamiec", () => {
  const kontekst = (
    facts: { content: string; category?: string }[],
    nadpisz: Partial<KontekstPamieci> = {}
  ): KontekstPamieci => ({
    memory: {
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue(
        facts.map((f) => ({ category: f.category ?? "preference", ...f }))
      ),
    } as unknown as IMemoryStore,
    userId: "lech",
    limit: 1500,
    allowPersonal: true,
    ...nadpisz,
  });

  it("finds facts by topic rather than by the whole question", async () => {
    const ctx = kontekst([{ content: "Lech nie pije kawy po 18:00" }]);

    const wynik = await sprawdzPamiec("kawa wieczorem", ctx);

    expect(wynik.fakty).toEqual(["Lech nie pije kawy po 18:00"]);
    expect(ctx.memory.getFactsWithinTokenLimit).toHaveBeenCalledWith(
      "lech",
      1500,
      "kawa wieczorem"
    );
  });

  // The whole point of the tool is recovering from a miss, so the two ways of
  // coming back empty must not read alike: one means "there is no such habit",
  // the other means "I could not look". Collapsing them is how an assistant
  // starts asserting things it never checked.
  it("says nothing-found means not-known, not not-so", async () => {
    const wynik = await sprawdzPamiec("kawa wieczorem", kontekst([]));

    expect(wynik.fakty).toEqual([]);
    expect(wynik.uwaga).toContain("nie wiem");
    expect(wynik.uwaga).toContain("nie zmyslaj");
  });

  it("reports a missing store as a fault, not as an empty memory", async () => {
    const wynik = await sprawdzPamiec("kawa wieczorem", undefined);

    expect(wynik.fakty).toEqual([]);
    expect(wynik.uwaga).toContain("awaria");
  });

  it("asks again instead of searching for nothing", async () => {
    const ctx = kontekst([{ content: "cokolwiek" }]);

    const wynik = await sprawdzPamiec("   ", ctx);

    expect(wynik.fakty).toEqual([]);
    expect(ctx.memory.getFactsWithinTokenLimit).not.toHaveBeenCalled();
  });

  // A speaker whose personal facts are withheld from the prompt must not get
  // them back by having the model ask for them out loud.
  it("honours the personal-memory gate the prompt block runs under", async () => {
    const ctx = kontekst(
      [
        { content: "Lech nie pije kawy po 18:00", category: "preference" },
        { content: "Denon to wzmacniacz w salonie", category: "device" },
      ],
      { allowPersonal: false }
    );

    const wynik = await sprawdzPamiec("kawa wieczorem", ctx);

    expect(wynik.fakty).toEqual(["Denon to wzmacniacz w salonie"]);
  });
});
