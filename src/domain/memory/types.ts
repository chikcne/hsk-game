import type { ComponentMemory } from "../../shared/schemas";

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

export function isCardDue(card: ComponentMemory, now: string | number | Date): boolean {
  return cardDueAtMs(card) <= isoTime(now);
}

/** Never-reviewed words are immediately due; a real review is always late or on time. */
export function hasBeenSeen(card: ComponentMemory): boolean {
  return card.reps > 0;
}

function isoTime(value: string | number | Date): number {
  const time = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : value.getTime();
  if (!Number.isFinite(time)) throw new RangeError("now must be a valid timestamp");
  return time;
}
