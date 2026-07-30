import { describe, it, expect } from "vitest";
import { retryDelayMs, parseRetryDelay } from "./gemini-client.js";

describe("retryDelayMs", () => {
  it("backs off 2s, 6s, 15s when the API gives no hint", () => {
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(2)).toBe(6000);
    expect(retryDelayMs(3)).toBe(15000);
  });

  it("clamps further attempts to the longest step", () => {
    expect(retryDelayMs(9)).toBe(15000);
  });

  it("honours the API's own retryDelay over our guess", () => {
    expect(retryDelayMs(1, 27)).toBe(27000);
  });

  it("caps a nonsense retryDelay so a turn cannot hang past the HA timeout", () => {
    expect(retryDelayMs(1, 600)).toBe(30000);
  });
});

describe("parseRetryDelay", () => {
  it("reads RetryInfo out of a Gemini 429 body", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
        ],
      },
    });
    expect(parseRetryDelay(body)).toBe(27);
  });

  it("returns undefined when the body has no RetryInfo", () => {
    expect(parseRetryDelay('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBeUndefined();
  });
});
