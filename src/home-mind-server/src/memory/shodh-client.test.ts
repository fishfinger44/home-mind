import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShodhMemoryClient, ShodhMemoryStore, wybierzPoTrafnosci } from "./shodh-client.js";
import type { Fact, FactCategory } from "./types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ShodhMemoryClient", () => {
  let client: ShodhMemoryClient;

  beforeEach(() => {
    client = new ShodhMemoryClient({
      baseUrl: "http://localhost:3030",
      apiKey: "test-api-key",
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isHealthy", () => {
    it("returns true when health endpoint responds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "healthy" }),
      });

      const result = await client.isHealthy();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/health",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "X-API-Key": "test-api-key",
          }),
        })
      );
    });

    it("returns false when health endpoint fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it("returns false when health endpoint returns non-ok status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });
  });

  describe("remember", () => {
    it("stores a memory and returns the id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "mem-123", success: true }),
      });

      const id = await client.remember(
        "user-1",
        "User prefers 20°C",
        "preference",
        0.9
      );

      expect(id).toBe("mem-123");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/remember",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            content: "User prefers 20°C",
            memory_type: "Preference",
            importance: 0.9,
            tags: ["preference", "home-mind"],
          }),
        })
      );
    });

    it("maps category to correct Shodh memory type", async () => {
      const categoryMappings: [FactCategory, string][] = [
        ["baseline", "Observation"],
        ["preference", "Preference"],
        ["identity", "Context"],
        ["device", "Context"],
        ["pattern", "Observation"],
        ["correction", "Learning"],
      ];

      for (const [category, expectedType] of categoryMappings) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "mem-123", success: true }),
        });

        await client.remember("user-1", "test", category);

        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        const body = JSON.parse(lastCall[1].body);
        expect(body.memory_type).toBe(expectedType);
      }
    });
  });

  describe("recall", () => {
    it("retrieves memories and converts to Fact format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              id: "mem-123",
              experience: {
                content: "User prefers 20°C",
                memory_type: "Preference",
                tags: ["preference", "home-mind"],
              },
              importance: 0.8,
              created_at: "2026-01-25T10:00:00Z",
              score: 0.95,
            },
          ],
          count: 1,
        }),
      });

      const facts = await client.recall("user-1", "temperature", 10);

      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        id: "mem-123",
        userId: "user-1",
        content: "User prefers 20°C",
        category: "preference",
        confidence: 0.8,
      });
      expect(facts[0].createdAt).toBeInstanceOf(Date);
    });

    it("sends correct query to API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], count: 0 }),
      });

      await client.recall("user-1", "bedroom temperature", 5);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/recall",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            query: "bedroom temperature",
            limit: 5,
          }),
        })
      );
    });

    it("uses default query when none provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], count: 0 }),
      });

      await client.recall("user-1");

      const lastCall = mockFetch.mock.calls[0];
      const body = JSON.parse(lastCall[1].body);
      expect(body.query).toBe("all memories");
    });

    it("warns when the relevance window fills up", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const memories = Array.from({ length: 2 }, (_, i) => ({
        id: `mem-${i}`,
        experience: { content: `Memory ${i}`, memory_type: "Observation", tags: [] },
        importance: 0.5,
        created_at: "2026-01-25T10:00:00Z",
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories, count: memories.length }),
      });

      await client.recall("user-1", "kawa", 2);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("relevance window"));
      warn.mockRestore();
    });
  });

  describe("reinforce", () => {
    it("sends reinforce request with correct format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 2 }),
      });

      await client.reinforce("user-1", ["mem-1", "mem-2"]);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/reinforce",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            ids: ["mem-1", "mem-2"],
            outcome: "positive",
          }),
        })
      );
    });
  });

  describe("rememberBatch", () => {
    it("sends batch remember request with correct format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: 2,
          failed: 0,
          memory_ids: ["mem-1", "mem-2"],
          errors: [],
        }),
      });

      const ids = await client.rememberBatch("user-1", [
        { content: "User prefers 20°C", category: "preference", confidence: 0.9 },
        { content: "User's name is Jure", category: "identity" },
      ]);

      expect(ids).toEqual(["mem-1", "mem-2"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/remember/batch",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            memories: [
              {
                content: "User prefers 20°C",
                memory_type: "Preference",
                importance: 0.9,
                tags: ["preference", "home-mind"],
              },
              {
                content: "User's name is Jure",
                memory_type: "Context",
                importance: 0.8,
                tags: ["identity", "home-mind"],
              },
            ],
          }),
        })
      );
    });

    it("logs warning when some memories fail", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: 1,
          failed: 1,
          memory_ids: ["mem-1"],
          errors: ["duplicate content"],
        }),
      });

      const ids = await client.rememberBatch("user-1", [
        { content: "Fact A", category: "preference" },
        { content: "Fact B", category: "identity" },
      ]);

      expect(ids).toEqual(["mem-1"]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("recallByTags", () => {
    it("calls /api/recall/tags with home-mind tag", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              id: "mem-1",
              experience: { content: "Test fact", memory_type: "Preference", tags: ["preference", "home-mind"] },
              importance: 0.8,
              created_at: "2026-01-25T10:00:00Z",
            },
          ],
          count: 1,
        }),
      });

      const facts = await client.recallByTags("user-1", 25);

      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe("Test fact");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/recall/tags",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            tags: ["home-mind"],
            limit: 25,
          }),
        })
      );
    });

    it("asks for the whole fact set when no limit is given", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], count: 0 }),
      });

      await client.recallByTags("user-1");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBeGreaterThanOrEqual(5000);
    });

    // The endpoint has no pagination and returns facts in arbitrary order, so a
    // full window is not "the first N" — it is N of them at random, with the
    // rest invisible. Nothing in the response says it was cut, which is exactly
    // how this failed before: the assistant forgets, the log stays clean.
    it("warns when the answer comes back the size of the question", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const memories = Array.from({ length: 3 }, (_, i) => ({
        id: `mem-${i}`,
        experience: { content: `Fact ${i}`, memory_type: "Preference", tags: ["home-mind"] },
        importance: 0.8,
        created_at: "2026-01-25T10:00:00Z",
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories, count: memories.length }),
      });

      await client.recallByTags("user-1", 3);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("filled its window"));
      warn.mockRestore();
    });

    it("stays quiet when the fact set fits", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              id: "mem-1",
              experience: { content: "Fact", memory_type: "Preference", tags: ["home-mind"] },
              importance: 0.8,
              created_at: "2026-01-25T10:00:00Z",
            },
          ],
          count: 1,
        }),
      });

      await client.recallByTags("user-1", 3);

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("getProactiveContext", () => {
    it("calls /api/proactive_context and handles flat memory shape", async () => {
      // Proactive context returns flat fields (no experience wrapper)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              id: "mem-1",
              content: "User prefers 20°C",
              memory_type: "Preference",
              tags: ["preference", "home-mind"],
              score: 0.95,
              importance: 0.8,
              created_at: "2026-01-25T10:00:00Z",
            },
          ],
          memory_count: 1,
        }),
      });

      const facts = await client.getProactiveContext("user-1", "bedroom temperature", 10);

      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe("User prefers 20°C");
      expect(facts[0].category).toBe("preference");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/proactive_context",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            user_id: "user-1",
            context: "bedroom temperature",
            limit: 10,
          }),
        })
      );
    });
  });

  describe("forget", () => {
    it("sends forget request with correct format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.forget("user-1", "mem-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/forget/mem-123?user_id=user-1",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });
  });
});

describe("ShodhMemoryStore", () => {
  let store: ShodhMemoryStore;

  beforeEach(() => {
    store = new ShodhMemoryStore({
      baseUrl: "http://localhost:3030",
      apiKey: "test-api-key",
    });
    mockFetch.mockReset();
  });

  describe("getFacts", () => {
    it("retrieves facts for a user", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              id: "mem-1",
              experience: {
                content: "Fact 1",
                memory_type: "Context",
                tags: ["identity"],
              },
              importance: 0.5,
              created_at: "2026-01-25T10:00:00Z",
            },
          ],
          count: 1,
        }),
      });

      const facts = await store.getFacts("user-1");

      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe("Fact 1");
    });
  });

  describe("getFactsWithinTokenLimit", () => {
    it("limits facts to token budget", async () => {
      // Create facts with known content lengths
      const memories = [
        { id: "1", experience: { content: "Short", memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
        { id: "2", experience: { content: "A".repeat(100), memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
        { id: "3", experience: { content: "B".repeat(100), memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories, count: 3 }),
      });

      // Mock the reinforce call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 1 }),
      });

      // 50 tokens * 4 chars = 200 chars max
      // "Short" = 5 chars = ~2 tokens
      // 100 chars = 25 tokens
      // Should fit: Short + first 100-char = ~27 tokens
      const facts = await store.getFactsWithinTokenLimit("user-1", 50);

      expect(facts.length).toBeLessThanOrEqual(2);
    });

    it("reinforces retrieved facts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "mem-1", experience: { content: "Test", memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 1 }),
      });

      await store.getFactsWithinTokenLimit("user-1", 100);

      // Wait for async reinforce
      await new Promise((r) => setTimeout(r, 10));

      // Check that reinforce was called
      const reinforceCall = mockFetch.mock.calls.find(
        (call) => call[0].includes("/api/reinforce")
      );
      expect(reinforceCall).toBeDefined();
    });

    it("puts the tagged facts the query hit ahead of the rest", async () => {
      // First fetch: recallByTags — "wanted" sits last in the arbitrary order
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "other", experience: { content: "Other fact", memory_type: "Context", tags: ["preference"] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
            { id: "wanted", experience: { content: "Wanted fact", memory_type: "Context", tags: ["preference"] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 2,
        }),
      });
      // Second fetch: semantic recall ranks "wanted" first
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "wanted", experience: { content: "Wanted fact", memory_type: "Context", tags: ["preference"] }, importance: 0.7, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });
      // Third fetch: reinforce
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 2 }),
      });

      const facts = await store.getFactsWithinTokenLimit("user-1", 1000, "what's my passkey?");

      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls).toContain("http://localhost:3030/api/recall/tags");
      expect(urls).toContain("http://localhost:3030/api/recall");
      expect(facts.map((f) => f.id)).toEqual(["wanted", "other"]);
    });

    it("drops recall hits that are not tagged facts", async () => {
      // Shodh's index also holds raw conversation turns under the same user_id.
      // They must not reach the prompt dressed as remembered knowledge.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "tag-1", experience: { content: "Tag fact", memory_type: "Context", tags: ["preference"] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "transcript-1", experience: { content: "Zamknij lewą roletę w salonie", memory_type: "Context", tags: [] }, importance: 0.9, created_at: "2026-01-25T10:00:00Z" },
            { id: "tag-1", experience: { content: "Tag fact", memory_type: "Context", tags: ["preference"] }, importance: 0.4, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 2,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 1 }),
      });

      const facts = await store.getFactsWithinTokenLimit("user-1", 1000, "roleta");

      expect(facts.map((f) => f.id)).toEqual(["tag-1"]);
    });

    it("passes the current message to recall as the search query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], count: 0 }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], count: 0 }),
      });

      await store.getFactsWithinTokenLimit("user-1", 1000, "jaką kawę piję?");

      const recallCall = mockFetch.mock.calls.find(
        (c) => c[0] === "http://localhost:3030/api/recall"
      );
      expect(recallCall).toBeDefined();
      expect(JSON.parse((recallCall![1] as { body: string }).body)).toMatchObject({
        user_id: "user-1",
        query: "jaką kawę piję?",
      });
    });

    it("keeps query-relevant facts when the budget cannot hold every tagged fact", async () => {
      // Tag recall returns the relevant fact LAST — arbitrary order is the point.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "filler-1", experience: { content: "x".repeat(400), memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
            { id: "wanted", experience: { content: "User drinks no coffee after 18:00", memory_type: "Context", tags: ["preference"] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 2,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "wanted", experience: { content: "User drinks no coffee after 18:00", memory_type: "Context", tags: ["preference"] }, importance: 0.9, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 1 }),
      });

      // Budget fits one short fact, not the 100-token filler.
      const facts = await store.getFactsWithinTokenLimit("user-1", 20, "coffee in the evening?");

      expect(facts.map((f) => f.id)).toEqual(["wanted"]);
    });

    it("deduplicates facts present in both recall and tag results by id", async () => {
      // recallByTags returns two facts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "dup", experience: { content: "Duplicate", memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
            { id: "tag-only", experience: { content: "Tag only", memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 2,
        }),
      });
      // recall returns one fact also present in tag set
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "dup", experience: { content: "Duplicate", memory_type: "Context", tags: [] }, importance: 0.7, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 2 }),
      });

      const facts = await store.getFactsWithinTokenLimit("user-1", 1000, "query");

      expect(facts.map((f) => f.id)).toEqual(["dup", "tag-only"]);
    });

    it("falls back to tag-recall when semantic recall fails", async () => {
      // recallByTags succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            { id: "tag-1", experience: { content: "Tag fact", memory_type: "Context", tags: [] }, importance: 0.5, created_at: "2026-01-25T10:00:00Z" },
          ],
          count: 1,
        }),
      });
      // recall fails all 3 retries
      mockFetch.mockRejectedValueOnce(new Error("shodh down"));
      mockFetch.mockRejectedValueOnce(new Error("shodh down"));
      mockFetch.mockRejectedValueOnce(new Error("shodh down"));
      // reinforce
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories_processed: 1 }),
      });

      const facts = await store.getFactsWithinTokenLimit("user-1", 1000, "query");

      expect(facts.map((f) => f.id)).toEqual(["tag-1"]);
    });
  });

  describe("addFact", () => {
    it("adds a fact and returns id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "new-mem-id", success: true }),
      });

      const id = await store.addFact("user-1", "New fact", "preference");

      expect(id).toBe("new-mem-id");
    });
  });

  describe("addFacts (batch)", () => {
    it("uses single remember for one fact", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "mem-1", success: true }),
      });

      const ids = await store.addFacts("user-1", [
        { content: "Single fact", category: "preference" },
      ]);

      expect(ids).toEqual(["mem-1"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/remember",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("uses batch remember for multiple facts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: 2,
          failed: 0,
          memory_ids: ["mem-1", "mem-2"],
          errors: [],
        }),
      });

      const ids = await store.addFacts("user-1", [
        { content: "Fact A", category: "preference" },
        { content: "Fact B", category: "identity" },
      ]);

      expect(ids).toEqual(["mem-1", "mem-2"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/remember/batch",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("returns empty array for empty input", async () => {
      const ids = await store.addFacts("user-1", []);
      expect(ids).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("deleteFact", () => {
    it("deletes a fact and returns true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await store.deleteFact("user-1", "mem-to-delete");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3030/api/forget/mem-to-delete?user_id=user-1",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });

    it("returns false when forget fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("API error"));

      const result = await store.deleteFact("user-1", "nonexistent");

      expect(result).toBe(false);
    });
  });

});

describe("Integration tests (requires running Shodh)", () => {
  const SHODH_URL = process.env.SHODH_TEST_URL || "http://localhost:3030";
  const SHODH_API_KEY = process.env.SHODH_TEST_API_KEY || "";

  // Skip if no API key configured
  const describeIfShodh = SHODH_API_KEY ? describe : describe.skip;

  describeIfShodh("ShodhMemoryClient integration", () => {
    let client: ShodhMemoryClient;

    beforeEach(() => {
      // Restore real fetch for integration tests
      vi.unstubAllGlobals();
      client = new ShodhMemoryClient({
        baseUrl: SHODH_URL,
        apiKey: SHODH_API_KEY,
      });
    });

    afterEach(() => {
      // Re-stub fetch for other tests
      vi.stubGlobal("fetch", mockFetch);
    });

    it("can check health", async () => {
      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
    });

    it("can remember and recall", async () => {
      const testUser = `test-user-${Date.now()}`;
      const testContent = `Integration test memory ${Date.now()}`;

      // Remember
      const id = await client.remember(testUser, testContent, "preference");
      expect(id).toBeTruthy();

      // Recall
      const facts = await client.recall(testUser, testContent, 10);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.content === testContent)).toBe(true);

      // Cleanup
      await client.forget(testUser, id);
    });
  });
});

describe("wybierzPoTrafnosci", () => {
  const fakt = (id: string, trafnosc?: number): Fact => ({
    id,
    userId: "lech",
    content: `fakt ${id}`,
    category: "preference",
    confidence: 1,
    createdAt: new Date("2026-08-01"),
    lastUsed: new Date("2026-08-01"),
    useCount: 0,
    trafnosc,
  });

  // Real distribution for "picie kawy": the coffee fact leads at 0.61, the rest
  // trail off. Half of 0.61 is 0.305, so the tail below that goes.
  it("keeps the band below a confident best match", () => {
    const wybrane = wybierzPoTrafnosci([
      fakt("kawa", 0.61),
      fakt("pies", 0.45),
      fakt("muzyka", 0.39),
      fakt("swiatlo", 0.34),
      fakt("imie", 0.29),
      fakt("netflix", 0.1),
    ]);

    expect(wybrane.map((f) => f.id)).toEqual(["kawa", "pies", "muzyka", "swiatlo"]);
  });

  // This is the case the whole shape exists for. "Zrób mi kawę" scores 0.204 at
  // best and does not rank the coffee fact at all. Filtering on that ranking
  // would drop the one fact that matters — so nothing is filtered.
  it("sends everything when the question was not understood", () => {
    const fakty = [fakt("pierogi", 0.204), fakt("muzyka", 0.168), fakt("kawa", undefined)];

    expect(wybierzPoTrafnosci(fakty)).toEqual(fakty);
  });

  // 0.303 is the measured top score for a question about something this house
  // has no memory of. It must land on the "do not filter" side.
  it("treats a noise-level best match as not understood", () => {
    const fakty = [fakt("pies", 0.303), fakt("imie", 0.282), fakt("muzyka", 0.247)];

    expect(wybierzPoTrafnosci(fakty)).toHaveLength(3);
  });

  it("filters nothing when no fact was scored at all", () => {
    const fakty = [fakt("a"), fakt("b"), fakt("c")];

    expect(wybierzPoTrafnosci(fakty)).toEqual(fakty);
  });

  // An unscored fact is only evidence of irrelevance if the scoring worked.
  it("drops unscored facts only once the ranking is credible", () => {
    const wybrane = wybierzPoTrafnosci([
      fakt("trafiony", 0.61),
      fakt("slaby", 0.2),
      fakt("nieoceniony", undefined),
    ]);

    expect(wybrane.map((f) => f.id)).toEqual(["trafiony"]);
  });
});
