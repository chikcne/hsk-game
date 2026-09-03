import type { ComponentMemory } from "../../shared/schemas";

/** How strongly a single component (pinyin/meaning) was recalled. Mirrors the
 * FSRS grade scale minus the manual rating. */
export type MemoryRating = "again" | "hard" | "good" | "easy";

export type WordRatings = {
  pinyin: MemoryRating;
  /** Null when the encounter never reached the meaning phase. */
  meaning: MemoryRating | null;
};

export function isRelearning(memory: ComponentMemory): boolean {
  return memory.state === "relearning";
}

/** A word counts as graduated (the product's "mastered" milestone) only when
 * both tested components have passed their learning steps into review. */
export function isGraduated(progress: { pinyin: ComponentMemory; meaning: ComponentMemory }): boolean {
  return progress.pinyin.state === "review" && progress.meaning.state === "review";
}

/** A word is due when its weakest component is due. */
export function nextDueAtMs(progress: { pinyin: ComponentMemory; meaning: ComponentMemory }): number {
  return Math.min(Date.parse(progress.pinyin.due), Date.parse(progress.meaning.due));
}

export function isMemoryDue(progress: { pinyin: ComponentMemory; meaning: ComponentMemory }, now: string | number | Date): boolean {
  return nextDueAtMs(progress) <= isoTime(now);
}

/** Never-spotted words are immediately due; a real review is always late or on time. */
export function hasBeenSeen(memory: ComponentMemory): boolean {
  return memory.reps > 0;
}

function isoTime(value: string | number | Date): number {
  const time = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : value.getTime();
  if (!Number.isFinite(time)) throw new RangeError("now must be a valid timestamp");
  return time;
}
