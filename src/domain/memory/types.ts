import { Effect } from "effect";
import type { ComponentMemory } from "../../shared/schemas";
import { runDomain, validTimestamp } from "../effect";
import type { InvalidTimestampError } from "../errors";

/** An explicit self-rating for the word's single card, applied in Learn Mode.
 * Mirrors the FSRS grade scale. */
export type MemoryRating = "again" | "hard" | "good" | "easy";

/** The card currently sits in its review stage (graduated from the learning
 * steps). This is the product's "mastered/acquired" milestone: the first time
 * a Learn rating lands here, the word enters the `acquired_words` table. */
export function isCardAcquired(card: ComponentMemory): boolean {
  return card.state === "review" || card.state === "relearning";
}

/** A card is due when its FSRS due date has passed; never-reviewed (new)
 * cards carry epoch dues and are therefore immediately due. */
export function cardDueAtMs(card: ComponentMemory): number {
  return Date.parse(card.due);
}

/** A card is due when its FSRS due date has passed; never-reviewed (new)
 * cards carry epoch dues and are therefore immediately due. */
export function isCardDueEffect(card: ComponentMemory, now: string | number | Date): Effect.Effect<boolean, InvalidTimestampError, never> {
  return Effect.map(validTimestamp(now), (nowMs) => cardDueAtMs(card) <= nowMs);
}

export function isCardDue(card: ComponentMemory, now: string | number | Date): boolean {
  return runDomain(isCardDueEffect(card, now));
}

/** Never-reviewed words are immediately due; a real review is always late or on time. */
export function hasBeenSeen(card: ComponentMemory): boolean {
  return card.reps > 0;
}
