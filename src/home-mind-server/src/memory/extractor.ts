import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedFact, Fact } from "./types.js";
import type { IFactExtractor } from "../llm/interface.js";
import {
  VALID_CATEGORIES,
  fillExtractionPrompt,
  formatExistingFacts,
  resolveReplaces,
} from "./extraction-prompt.js";

export class FactExtractor implements IFactExtractor {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async extract(
    userMessage: string,
    assistantResponse: string,
    existingFacts: Fact[] = []
  ): Promise<ExtractedFact[]> {
    try {
      const { section, ids } = formatExistingFacts(existingFacts);
      const prompt = fillExtractionPrompt({
        existingFactsSection: section,
        userMessage,
        assistantResponse,
      });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";

      // Strip markdown code fences if present (LLMs sometimes wrap JSON in ```json ... ```)
      const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

      // Parse JSON response
      const facts = JSON.parse(cleaned);

      if (!Array.isArray(facts)) {
        return [];
      }

      // Validate structure
      return facts
        .filter(
          (f: any) =>
            typeof f.content === "string" &&
            typeof f.category === "string" &&
            (VALID_CATEGORIES as readonly string[]).includes(f.category)
        )
        .map((f: any) => ({
          content: f.content,
          category: f.category,
          confidence: typeof f.confidence === "number" ? f.confidence : undefined,
          replaces: resolveReplaces(f.replaces, ids),
        }));
    } catch (error) {
      // Log but don't fail - extraction is best-effort
      console.error("Fact extraction failed:", error);
      return [];
    }
  }
}
