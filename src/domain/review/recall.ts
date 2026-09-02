import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { DifficultySettings, ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import type { EncounterOutcome } from "../session/types";
import { outcomePinyinMs } from "../learning/mastery";

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

export type RecallUpdateResult = {
  review: ReviewProgress;
  progress: ReviewWordProgress;
  recallScoreMsPerChar: number | null;
  struggled: boolean;
  interval: number;
};

/** SM-2-style review update. It is intentionally independent of regular
 * appearanceWeight: reviews can never master or unmaster a grade word. */
export function applyReviewOutcome(
  review: ReviewProgress,
  wordKey: string,
  outcome: EncounterOutcome,
  pinyinLength: number,
  now: string | Date,
  settings: DifficultySettings = DEFAULT_SETTINGS,
): RecallUpdateResult {
  const previous = review.words[wordKey];
  if (!previous) throw new Error(`Unknown review word: ${wordKey}`);
  const rawPinyinMs = outcomePinyinMs(outcome);
  const normalized = rawPinyinMs === null ? null : rawPinyinMs / Math.max(1, pinyinLength);
  const recallScoreMsPerChar = normalized === null
    ? previous.recallScoreMsPerChar
    : previous.recallScoreMsPerChar === null
      ? normalized
      : previous.recallScoreMsPerChar * (1 - settings.recallScoreSmoothing) + normalized * settings.recallScoreSmoothing;
  const correct = outcome.kind === "correct";
  const slow = correct && outcome.pinyinMs > settings.struggleThresholdMs;
  const struggled = !correct || slow;

  let quality = 0;
  if (correct && !slow) {
    const ratio = outcome.pinyinMs / settings.struggleThresholdMs;
    quality = ratio <= 0.4 ? 5 : ratio <= 0.7 ? 4 : 3;
  } else if (correct) quality = 2;

  let easeFactor = previous.easeFactor;
  let repetitions: number;
  let interval: number;
  if (quality < 3) {
    easeFactor = Math.max(1.3, easeFactor - 0.2);
    repetitions = 0;
    interval = settings.reviewLapseInterval;
  } else {
    easeFactor = Math.max(1.3, Math.min(4, easeFactor + (quality === 5 ? 0.1 : quality === 3 ? -0.14 : 0)));
    repetitions = previous.repetitions + 1;
    if (previous.repetitions === 0) interval = settings.reviewInitialInterval;
    else if (previous.repetitions === 1) interval = settings.reviewGraduatingInterval;
    else {
      const qualityMultiplier = quality === 3
        ? settings.reviewHardMultiplier
        : quality === 5 ? settings.reviewEasyMultiplier / 2.5 : 1;
      interval = Math.max(1, Math.round(Math.max(1, previous.interval) * easeFactor * qualityMultiplier));
    }
  }

  const progress: ReviewWordProgress = {
    ...previous,
    recallScoreMsPerChar,
    easeFactor,
    interval,
    dueOrdinal: review.nextSpawnOrdinal + interval,
    repetitions,
    attempts: previous.attempts + 1,
    completeCorrect: previous.completeCorrect + (correct ? 1 : 0),
    wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
    wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
    landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
    struggles: previous.struggles + (struggled ? 1 : 0),
    totalPinyinMs: previous.totalPinyinMs + (rawPinyinMs ?? 0),
    lastOutcome: outcome.kind,
    lastReviewedAt: isoTimestamp(now),
  };
  const active = new Set(review.activePoolWordKeys);
  if (struggled) active.add(wordKey); else active.delete(wordKey);
  return {
    review: { ...review, activePoolWordKeys: [...active], words: { ...review.words, [wordKey]: progress } },
    progress,
    recallScoreMsPerChar,
    struggled,
    interval,
  };
}
