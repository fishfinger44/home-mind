export type FactCategory =
  | "baseline" // Sensor normal values ("NOx 100ppm is normal")
  | "preference" // User preferences ("prefers 22°C")
  | "identity" // User info ("name is Jure")
  | "device" // Device nicknames ("main light = light.wled_kitchen")
  | "pattern" // Routines ("usually home by 6pm")
  | "correction"; // Corrections ("actually X, not Y")

/**
 * Categories that describe the house rather than a person.
 *
 * A shared device — the speaker in the living room, a satellite anyone can
 * talk to — cannot know who is speaking, so nothing it learns may be filed as
 * somebody's personal memory. But most of what it hears is not personal at
 * all: which entity the "main light" is, what starts a film on the Apple TV,
 * what a sensor reads normally. That knowledge is about the home, it is the
 * same for everyone in it, and it is exactly what makes the assistant faster
 * next time.
 *
 * So the shared profile keeps these three and drops `preference`, `identity`
 * and `pattern`, which are all statements about a particular person.
 */
export const IMPERSONAL_FACT_CATEGORIES: readonly FactCategory[] = [
  "device",
  "baseline",
  "correction",
];

/**
 * The profile that holds what everyone in the house shares.
 *
 * Before anyone could be identified, this was simply the id every voice
 * request carried. It keeps that name so nothing already learned is orphaned,
 * but it now has a second job: once a speaker *is* identified, their personal
 * facts go to their own profile while the impersonal ones keep landing here.
 * Otherwise the first person to be recognised would quietly take the house's
 * knowledge with them, and whatever the others taught the satellite would end
 * up in a profile no one reads.
 */
export const SHARED_PROFILE_ID = "default";

export function isImpersonal(category: FactCategory): boolean {
  return IMPERSONAL_FACT_CATEGORIES.includes(category);
}

export interface Fact {
  id: string;
  userId: string;
  content: string;
  category: FactCategory;
  confidence: number;
  createdAt: Date;
  lastUsed: Date;
  useCount: number;
}

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence?: number; // 0.0–1.0, how confident the LLM is this is a lasting fact
  replaces?: string[]; // IDs of existing facts this one supersedes
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface ConversationSummary {
  conversationId: string;
  lastMessage: string;
  lastMessageAt: Date;
  messageCount: number;
}

export interface IConversationStore {
  storeMessage(
    conversationId: string,
    userId: string,
    role: "user" | "assistant",
    content: string
  ): string;
  getConversationHistory(
    conversationId: string,
    limit?: number
  ): ConversationMessage[] | Promise<ConversationMessage[]>;
  listConversations(
    userId: string
  ): ConversationSummary[] | Promise<ConversationSummary[]>;
  deleteConversation(conversationId: string): number | Promise<number>;
  getKnownUsers(): string[];
  cleanupOldConversations(hoursOld?: number): number | Promise<number>;
  close(): void;
}
