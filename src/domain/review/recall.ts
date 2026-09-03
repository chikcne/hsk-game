import type { ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import {
  EASY_DIFFICULTY_RELIEF,
  EASY_GROWTH_DIFFICULTY_SLOPE,
  EASY_INTERVAL_MULTIPLIER,
  EASY_STABILITY_GROWTH,
  GOOD_DIFFICULTY_RELIEF,
  GOOD_GROWTH_DIFFICULTY_SLOPE,
  GOOD_STABILITY_GROWTH,
  HARD_GROWTH_DIFFICULTY_SLOPE,
  HARD_INTERVAL_MULTIPLIER,
  HARD_MIN_INTERVENING_WORDS,
  HARD_STABILITY_GROWTH,
  LAPSE_DIFFICULTY_PENALTY,
  LAPSE_STABILITY_FACTOR,
  MAX_STABILITY_DAYS,
  MIN_STABILITY_DAYS,
  RELEARNING_STEPS,
} from "../learning/constants";
import { inferRecallGrade, outcomePinyinMs } from "../learning/mastery";
import type { EncounterOutcome } from "../session/types";
import { RECALL_SCORE_SMOOTHING } from "./constants";

const DAY_MS = 86_400_000;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

function dueAtFrom(now: string | Date, stabilityDays: number): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return new Date(date.getTime() + Math.max(1, Math.round(stabilityDays)) * DAY_MS).toISOString();
}

function clampDifficulty(value: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, value));
}

export type RecallUpdateResult = {
  review: ReviewProgress;
  progress: ReviewWordProgress;
  recallScoreMsPerChar: number | null;
  struggled: boolean;
  /** Words until the relearning card is due again. */
  dueInWords: number | null;
  /** Days until the graduated card's next long-term review. */
  dueInDays: number | null;
};

/** Applies one review result. Scheduling is wall-clock for graduated cards
 * and ordinal-based only for the short intra-session relearning steps. */
export function applyReviewOutcome(
  review: ReviewProgress,
  wordKey: string,
  outcome: EncounterOutcome,
  pinyinCharLength: number,
  now: string | Date,
): RecallUpdateResult {
  const previous = review.words[wordKey];
  if (!previous) throw new Error(`Unknown review word: ${wordKey}`);
  const rawPinyinMs = outcomePinyinMs(outcome);
  const normalized = rawPinyinMs === null ? null : rawPinyinMs / Math.max(1, pinyinCharLength);
  const recallScoreMsPerChar = normalized === null
    ? previous.recallScoreMsPerChar
    : previous.recallScoreMsPerChar === null
      ? normalized
      : previous.recallScoreMsPerChar * (1 - RECALL_SCORE_SMOOTHING) + normalized * RECALL_SCORE_SMOOTHING;
  const correct = outcome.kind === "correct";
  const grade = inferRecallGrade(outcome, pinyinCharLength);
  const struggled = grade === "again" || grade === "hard";
  const origin = review.nextSpawnOrdinal;

  let progress: ReviewWordProgress = {
    ...previous,
    recallScoreMsPerChar,
    attempts: previous.attempts + 1,
    completeCorrect: previous.completeCorrect + (correct ? 1 : 0),
    wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
    wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
    landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
    struggles: previous.struggles + (struggled ? 1 : 0),
    totalPinyinMs: previous.totalPinyinMs + (rawPinyinMs ?? 0),
    lastOutcome: outcome.kind,
    lastReviewedAt: isoTimestamp(now),
    lastGrade: grade,
  };

  let dueInWords: number | null = null;
  let dueInDays: number | null = null;

  if (grade === "again") {
    const stability = Math.max(MIN_STABILITY_DAYS, progress.stability * LAPSE_STABILITY_FACTOR);
    progress = {
      ...progress,
      phase: "relearning",
      stepIndex: 0,
      dueOrdinal: origin + RELEARNING_STEPS[0]!,
      dueAt: null,
      stability,
      lapses: progress.lapses + 1,
      difficulty: clampDifficulty(progress.difficulty + LAPSE_DIFFICULTY_PENALTY),
    };
    dueInWords = RELEARNING_STEPS[0]!;
  } else if (progress.phase === "relearning") {
    const steps = RELEARNING_STEPS;
    if (grade === "hard") {
      const interval = Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[progress.stepIndex]! * HARD_INTERVAL_MULTIPLIER));
      progress = { ...progress, dueOrdinal: origin + interval };
      dueInWords = interval;
    } else if (progress.stepIndex + 1 < steps.length) {
      const advanced = progress.stepIndex + 1;
      const interval = grade === "easy"
        ? Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[advanced]! * EASY_INTERVAL_MULTIPLIER))
        : steps[advanced]!;
      progress = { ...progress, stepIndex: advanced, dueOrdinal: origin + interval };
      dueInWords = interval;
    } else {
      // Relearning complete: back to long-term review.
      progress = {
        ...progress,
        phase: "review",
        stepIndex: 0,
        dueOrdinal: null,
        difficulty: clampDifficulty(progress.difficulty - (grade === "easy" ? EASY_DIFFICULTY_RELIEF : GOOD_DIFFICULTY_RELIEF)),
        dueAt: dueAtFrom(now, progress.stability),
      };
      dueInDays = Math.max(1, Math.round(progress.stability));
    }
  } else {
    const difficulty = progress.difficulty;
    const growth = grade === "hard"
      ? HARD_STABILITY_GROWTH - HARD_GROWTH_DIFFICULTY_SLOPE * difficulty
      : grade === "easy"
        ? EASY_STABILITY_GROWTH - EASY_GROWTH_DIFFICULTY_SLOPE * difficulty
        : GOOD_STABILITY_GROWTH - GOOD_GROWTH_DIFFICULTY_SLOPE * difficulty;
    const stability = Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, progress.stability * growth));
    progress = {
      ...progress,
      stability,
      difficulty: clampDifficulty(difficulty - (grade === "easy" ? EASY_DIFFICULTY_RELIEF : grade === "hard" ? 0 : GOOD_DIFFICULTY_RELIEF)),
      dueAt: dueAtFrom(now, stability),
    };
    dueInDays = Math.max(1, Math.round(stability));
  }

  const active = new Set(review.activePoolWordKeys);
  if (progress.phase === "relearning") active.add(wordKey); else active.delete(wordKey);
  return {
    review: { ...review, activePoolWordKeys: [...active], words: { ...review.words, [wordKey]: progress } },
    progress,
    recallScoreMsPerChar,
    struggled,
    dueInWords,
    dueInDays,
  };
}
