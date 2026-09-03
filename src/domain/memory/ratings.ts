import type { MemoryRating } from "./types";

/**
 * Latency boundaries for automatic FSRS grading. Values are hardcoded (not
 * settings) so the rating contract cannot drift from the scheduler: latency is
 * normalized per pinyin character, correcting the old model's bias against
 * longer multi-syllable answers.
 */
export const EASY_PINYIN_MS_PER_CHAR = 800;
export const HARD_PINYIN_MS_PER_CHAR = 2500;
/** Meaning selection is multiple-choice recognition, so only an uncertain
 * (slow) pick demotes a correct answer; recognition is never credited Easy. */
export const HARD_MEANING_MS = 5000;

/**
 * Maps a typed-pinyin result onto the pinyin memory component.
 * A reveal (autocomplete) is a failed recall: pinyin Again, even though the
 * following meaning choice may still succeed.
 */
export function ratePinyinRecall(pinyinMs: number, pinyinLength: number, revealed: boolean): MemoryRating {
  if (revealed) return "again";
  const safeMs = Number.isFinite(pinyinMs) ? Math.max(0, pinyinMs) : 0;
  const perChar = safeMs / Math.max(1, pinyinLength);
  if (perChar <= EASY_PINYIN_MS_PER_CHAR) return "easy";
  if (perChar > HARD_PINYIN_MS_PER_CHAR) return "hard";
  return "good";
}

/** Maps the meaning-choice result onto the meaning memory component. */
export function rateMeaningRecall(meaningMs: number, correct: boolean): MemoryRating {
  if (!correct) return "again";
  return Number.isFinite(meaningMs) && meaningMs > HARD_MEANING_MS ? "hard" : "good";
}
