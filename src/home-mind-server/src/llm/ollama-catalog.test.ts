import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchOllamaStatus,
  ollamaRootUrl,
  estimateRequiredVramGb,
} from "./ollama-catalog.js";

const GB = 1024 ** 3;

function mockFetch(routes: Record<string, unknown | Error>) {
  return vi.fn(async (url: string | URL) => {
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => value } as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollamaRootUrl", () => {
  it("strips the OpenAI-compatible /v1 suffix the chat engine needs", () => {
    expect(ollamaRootUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
  });

  it("tolerates a trailing slash and a root URL", () => {
    expect(ollamaRootUrl("http://box:11434/v1/")).toBe("http://box:11434");
    expect(ollamaRootUrl("http://box:11434")).toBe("http://box:11434");
  });

  it("falls back to localhost when nothing is configured", () => {
    expect(ollamaRootUrl(undefined)).toBe("http://localhost:11434");
  });
});

describe("estimateRequiredVramGb", () => {
  it("adds runtime overhead to the weights", () => {
    expect(estimateRequiredVramGb(2.5 * GB)).toBe(3.7);
  });
});

describe("fetchOllamaStatus", () => {
  it("lists installed models smallest first with their requirements", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/tags": {
          models: [
            {
              name: "qwen3:14b",
              size: 9 * GB,
              details: { parameter_size: "14.8B", quantization_level: "Q4_K_M" },
            },
            {
              name: "qwen3:4b",
              size: 2.5 * GB,
              capabilities: ["completion", "tools", "thinking"],
              details: { parameter_size: "4.0B", quantization_level: "Q4_K_M" },
            },
          ],
        },
        "/api/ps": { models: [] },
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1", 8);

    expect(status.reachable).toBe(true);
    expect(status.models.map((m) => m.name)).toEqual(["qwen3:4b", "qwen3:14b"]);
    expect(status.models[0].parameterSize).toBe("4.0B");
    expect(status.models[0].quantization).toBe("Q4_K_M");
    expect(status.models[0].requiredVramGb).toBe(3.7);
    // The point of the whole block: on an 8 GB card the 14B does not fit.
    expect(status.models[0].fitsVram).toBe(true);
    expect(status.models[1].fitsVram).toBe(false);
    expect(status.models[0].supportsTools).toBe(true);
  });

  it("judges the fit against usable VRAM, not the number on the box", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        // The case measured on a 4 GB T600: 2.3 GB of weights, needs 3.5 GB by
        // the estimate, and Ollama still pushed 15% of it onto the CPU.
        "/api/tags": { models: [{ name: "qwen3:4b", size: 2.3 * GB }] },
        "/api/ps": { models: [] },
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1", 4);

    expect(status.usableVramGb).toBe(3.4);
    expect(status.models[0].requiredVramGb).toBe(3.5);
    expect(status.models[0].fitsVram).toBe(false);
  });

  it("flags a model that cannot call tools, and admits when it cannot tell", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/tags": {
          models: [
            { name: "writer:7b", size: 4 * GB, capabilities: ["completion"] },
            { name: "old-server:7b", size: 4 * GB },
          ],
        },
        "/api/ps": { models: [] },
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1");

    expect(status.models[0].supportsTools).toBe(false);
    expect(status.models[1].supportsTools).toBeNull();
  });

  it("does not guess whether a model fits when the card size is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/tags": { models: [{ name: "qwen3:4b", size: 2.5 * GB }] },
        "/api/ps": { models: [] },
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1");

    expect(status.vramTotalGb).toBeNull();
    expect(status.models[0].fitsVram).toBeNull();
  });

  it("reports a partly offloaded model, which is the slow-but-working trap", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/tags": { models: [{ name: "qwen3:14b", size: 9 * GB }] },
        "/api/ps": { models: [{ name: "qwen3:14b", size: 10 * GB, size_vram: 4 * GB }] },
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1", 4);

    expect(status.loaded).toEqual([{ name: "qwen3:14b", onGpuPercent: 40 }]);
  });

  it("keeps the inventory when /api/ps is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/tags": { models: [{ name: "qwen3:4b", size: 2.5 * GB }] },
        "/api/ps": new Error("404"),
      })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1");

    expect(status.reachable).toBe(true);
    expect(status.models).toHaveLength(1);
    expect(status.loaded).toEqual([]);
  });

  it("reports unreachable instead of throwing, so the options form still opens", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "/api/tags": new Error("connect ECONNREFUSED") })
    );

    const status = await fetchOllamaStatus("http://127.0.0.1:11434/v1", 4);

    expect(status.reachable).toBe(false);
    expect(status.error).toContain("ECONNREFUSED");
    expect(status.models).toEqual([]);
    expect(status.baseUrl).toBe("http://127.0.0.1:11434");
  });
});
