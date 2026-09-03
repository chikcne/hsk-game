import type { WordProgress } from "../../shared/schemas";
import type { EncounterOutcome } from "../session/types";
import { reviewComponentMemory } from "./card";
import { rateMeaningRecall, ratePinyinRecall } from "./ratings";
import { isGraduated, type WordRatings } from "./types";

/**
 * Microspacing floor, in spawn ordinals, before the same word may appear
 * again. These are hard arcade-safety constraints, fully independent of the
 * FSRS due date: a word spawns only when it is due AND cooled down.
 */
export const AGAIN_COOLDOWN_PHRASES = 3;
export const PASS_COOLDOWN_PHRASES = 8;

/** Cooldown placed on a reserved (in-flight) word in case its session ends
 * before the outcome is recorded; outcomes overwrite it. */
export const RESERVED_COOLDOWN_PHRASES = PASS_COOLDOWN_PHRASES;

export type WordOutcomeOptions = {
  /** True when the pinyin was revealed by the recall-window timeout. */
  pinyinAutocompleted?: boolean;
  /** Canonical pinyin character count used to normalize latency. */
  pinyinLength: number;
};

export type WordOutcomeResult = {
  progress: WordProgress;
  ratings: WordRatings;
  graduatedBefore: boolean;
  graduatedAfter: boolean;
  struggled: boolean;
  cooldownPhrases: number;
};

function finiteDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative duration`);
  return value;
}

/**
 * Applies one arcade encounter to both memory components.
 *
 * - Wrong or revealed pinyin grades pinyin Again.
 * - Successful pinyin is Easy (fast), Good (normal), or Hard (effortful but
 *   unaided — still a pass, never a lapse).
 * - The meaning component is graded only when the encounter reaches the
 *   meaning phase: Again on a wrong choice, otherwise Good/Hard.
 */
export function applyWordOutcome(
  progress: WordProgress,
  outcome: EncounterOutcome,
  now: string | Date,
  options: WordOutcomeOptions,
): WordOutcomeResult {
  const pinyinMs = outcome.kind === "landed" ? null : finiteDuration(outcome.pinyinMs, "pinyinMs");
  const revealed = options.pinyinAutocompleted === true;
  const graduatedBefore = isGraduated(progress);
  // Easy is used conservatively: a first exposure never skips the learning
  // steps, no matter how fast the answer was.
  const capForFirstExposure = (memory: { reps: number }, rating: WordRatings["pinyin"]): WordRatings["pinyin"] =>
    rating === "easy" && memory.reps === 0 ? "good" : rating;

  let pinyinRating: WordRatings["pinyin"];
  let meaningRating: WordRatings["meaning"];
  if (outcome.kind === "wrongPinyin") {
    pinyinRating = "again";
    meaningRating = null;
  } else if (outcome.kind === "landed") {
    // Unreachable since autocomplete replaced natural landings; graded as a
    // total miss for safety.
    pinyinRating = "again";
    meaningRating = "again";
  } else {
    pinyinRating = capForFirstExposure(progress.pinyin, ratePinyinRecall(pinyinMs!, options.pinyinLength, revealed));
    meaningRating = outcome.kind === "correct"
      ? capForFirstExposure(progress.meaning, rateMeaningRecall(finiteDuration(outcome.meaningMs, "meaningMs"), true))
      : "again";
  }

  const thinkingMs = outcome.kind === "correct" || outcome.kind === "wrongMeaning"
    ? finiteDuration(outcome.pinyinMs, "pinyinMs") + finiteDuration(outcome.meaningMs, "meaningMs")
    : outcome.kind === "wrongPinyin" ? finiteDuration(outcome.pinyinMs, "pinyinMs")
    : outcome.activeThinkingMs === null ? 0 : finiteDuration(outcome.activeThinkingMs, "activeThinkingMs");
  // Aggregate outcomes are mutually exclusive. A revealed pinyin is a pinyin
  // miss even when the subsequent meaning recognition succeeds (or also
  // fails), so it must not inflate complete-correct counts or accuracy.
  const recordedOutcome: WordProgress["lastOutcome"] = revealed &&
    (outcome.kind === "correct" || outcome.kind === "wrongMeaning")
    ? "wrongPinyin"
    : outcome.kind;
  const completedWithoutReveal = outcome.kind === "correct" && !revealed;

  const updated: WordProgress = {
    ...progress,
    pinyin: reviewComponentMemory(progress.pinyin, pinyinRating, now),
    meaning: meaningRating === null ? progress.meaning : reviewComponentMemory(progress.meaning, meaningRating, now),
    attempts: progress.attempts + 1,
    completeCorrect: progress.completeCorrect + (completedWithoutReveal ? 1 : 0),
    wrongPinyin: progress.wrongPinyin + (recordedOutcome === "wrongPinyin" ? 1 : 0),
    wrongMeaning: progress.wrongMeaning + (recordedOutcome === "wrongMeaning" ? 1 : 0),
    landed: progress.landed + (recordedOutcome === "landed" ? 1 : 0),
    totalThinkingMs: progress.totalThinkingMs + thinkingMs,
    fastestCorrectMs: completedWithoutReveal
      ? progress.fastestCorrectMs === null ? thinkingMs : Math.min(progress.fastestCorrectMs, thinkingMs)
      : progress.fastestCorrectMs,
    totalPinyinMs: progress.totalPinyinMs + (pinyinMs ?? 0),
    fastestPinyinMs: pinyinMs === null
      ? progress.fastestPinyinMs
      : progress.fastestPinyinMs === null ? pinyinMs : Math.min(progress.fastestPinyinMs, pinyinMs),
    lastPinyinMs: pinyinMs,
    lastOutcome: recordedOutcome,
    lastSeenAt: new Date(now).toISOString(),
  };

  const graduatedAfter = isGraduated(updated);
  const ratings: WordRatings = { pinyin: pinyinRating, meaning: meaningRating };
  const lapsed = pinyinRating === "again" || meaningRating === "again";
  return {
    progress: updated,
    ratings,
    graduatedBefore,
    graduatedAfter,
    struggled: lapsed || pinyinRating === "hard" || meaningRating === "hard",
    cooldownPhrases: lapsed ? AGAIN_COOLDOWN_PHRASES : PASS_COOLDOWN_PHRASES,
  };
}
