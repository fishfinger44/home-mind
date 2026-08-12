import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  speakerSection,
  buildSystemPrompt,
  buildSystemPromptText,
  buildVolatileBlock,
} from "./prompts.js";

type TextBlock = Anthropic.TextBlockParam;

describe("buildSystemPrompt (Anthropic)", () => {
  it("returns one fully cacheable block with default identity", () => {
    const blocks = buildSystemPrompt() as TextBlock[];

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[0].text).toContain("You are a helpful smart home assistant");
    expect(blocks[0].text).toContain("## WHEN TO USE TOOLS");
  });

  it("replaces default identity with custom prompt", () => {
    const blocks = buildSystemPrompt(false, "You are Ava.") as TextBlock[];

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toMatch(/^You are Ava\./);
    expect(blocks[0].text).toContain("## WHEN TO USE TOOLS");
    expect(blocks[0].text).not.toContain("You are a helpful smart home assistant");
    expect(blocks[0]).toHaveProperty("cache_control", { type: "ephemeral" });
  });

  it("uses voice instructions when isVoice is true", () => {
    const blocks = buildSystemPrompt(true) as TextBlock[];

    expect(blocks[0].text).toContain("You are a helpful smart home voice assistant");
    expect(blocks[0].text).toContain("Keep responses under 2-3 sentences");
  });

  it("uses voice instructions with custom prompt", () => {
    const blocks = buildSystemPrompt(true, "You are Ava.") as TextBlock[];

    expect(blocks[0].text).toMatch(/^You are Ava\./);
    expect(blocks[0].text).toContain("Keep responses under 2-3 sentences");
    expect(blocks[0].text).not.toContain("You are a helpful smart home voice assistant");
  });

  // The whole point of the split: nothing that changes between turns may sit in
  // the cached block, or the cache is busted on every request.
  it("keeps volatile content out of the cached block", () => {
    const blocks = buildSystemPrompt(false, undefined, undefined, undefined, 1) as TextBlock[];

    expect(blocks[0].text).not.toContain("## Current Context:");
    expect(blocks[0].text).not.toContain("## What You Remember:");
    expect(blocks[0].text).not.toContain("## Who You Are Talking To:");
  });
});

describe("buildSystemPromptText (OpenAI/Gemini)", () => {
  it("returns text with default identity when no custom prompt", () => {
    const text = buildSystemPromptText();

    expect(text).toContain("You are a helpful smart home assistant");
    expect(text).toContain("## WHEN TO USE TOOLS");
  });

  it("replaces default identity with custom prompt", () => {
    const text = buildSystemPromptText(false, "You are Ava, sarcastic and sharp.");

    expect(text).toMatch(/^You are Ava, sarcastic and sharp\./);
    expect(text).not.toContain("You are a helpful smart home assistant");
    expect(text).toContain("## WHEN TO USE TOOLS");

    // Custom prompt still comes before the instructions it is meant to govern
    expect(text.indexOf("You are Ava")).toBeLessThan(text.indexOf("## WHEN TO USE TOOLS"));
  });

  it("uses voice identity and instructions when isVoice is true", () => {
    const text = buildSystemPromptText(true);

    expect(text).toContain("You are a helpful smart home voice assistant");
    expect(text).toContain("Keep responses under 2-3 sentences");
  });

  it("keeps volatile content out", () => {
    const text = buildSystemPromptText();

    expect(text).not.toContain("## Current Context:");
    expect(text).not.toContain("## What You Remember:");
  });
});

describe("buildVolatileBlock", () => {
  it("carries the facts, the clock and who is speaking", () => {
    const block = buildVolatileBlock(["my fact"], "Lech", true);

    expect(block).toContain("my fact");
    expect(block).toContain("## Current Context:");
    expect(block).toContain("ISO Timestamp");
    expect(block).toContain("Lech");
  });

  it("shows 'No memories yet.' when facts are empty", () => {
    expect(buildVolatileBlock([])).toContain("No memories yet.");
  });

  it("withholds memories from a speaker we are not sure of", () => {
    const block = buildVolatileBlock([], "Lech", false);

    expect(block).toContain("not an identification");
  });
});

describe("speakerSection", () => {
  it("names a trusted speaker", () => {
    expect(speakerSection("Lech", true)).toContain("Lech");
  });

  it("refuses to guess when nobody is identified", () => {
    expect(speakerSection(undefined)).toContain("Unknown");
  });
});
