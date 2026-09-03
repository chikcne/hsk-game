import type { ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import { INITIAL_DIFFICULTY, INITIAL_STABILITY_DAYS } from "../learning/constants";
import { randomStateFromSeed, type RandomState } from "../random";

const DAY_MS = 86_400_000;

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

export function reviewWordKey(deckId: string, wordId: string): string { return `${deckId}:${wordId}`; }

/** A freshly mastered card enters long-term review due immediately. */
export function createReviewWordProgress(now: string | Date): ReviewWordProgress {
  return {
    phase: "review",
    stepIndex: 0,
    dueOrdinal: null,
    dueAt: isoTimestamp(now),
    stability: INITIAL_STABILITY_DAYS,
    difficulty: INITIAL_DIFFICULTY,
    lapses: 0,
    lastGrade: null,
    recallScoreMsPerChar: null,
    attempts: 0,
    completeCorrect: 0,
    wrongPinyin: 0,
    wrongMeaning: 0,
    landed: 0,
    struggles: 0,
    totalPinyinMs: 0,
    lastOutcome: null,
    lastReviewedAt: null,
    lastSpawnOrdinal: null,
  };
}

export function createReviewProgress(
  schedulerRng: RandomState = randomStateFromSeed("ziduoduo-review"),
): ReviewProgress {
  return { nextSpawnOrdinal: 0, schedulerRng: [...schedulerRng], activePoolWordKeys: [], words: {} };
}

/** Adds newly mastered words without removing historical recall records. */
export function syncReviewProgress(
  source: ReviewProgress,
  masteredWordKeys: Iterable<string>,
  now: string | Date,
): ReviewProgress {
  let words = source.words;
  for (const key of masteredWordKeys) {
    if (words[key]) continue;
    if (words === source.words) words = { ...source.words };
    words[key] = createReviewWordProgress(now);
  }
  const activePoolWordKeys = [...new Set(source.activePoolWordKeys)].filter((key) => words[key] !== undefined);
  return words === source.words && activePoolWordKeys.length === source.activePoolWordKeys.length
    ? source
    : { ...source, words, activePoolWordKeys };
}

/** Prepares a review round. Wall-clock due points are authoritative: unlike
 * the old ordinal advance, starting a new round can never fast-forward a
 * card toward its due date. Repair-pool keys that no longer belong to a
 * currently mastered card are dropped. */
export function prepareReviewRound(
  source: ReviewProgress,
  masteredWordKeys: ReadonlySet<string>,
  now: string | Date,
): ReviewProgress {
  const synced = syncReviewProgress(source, masteredWordKeys, now);
  const activePoolWordKeys = synced.activePoolWordKeys.filter((key) => masteredWordKeys.has(key) && synced.words[key] !== undefined);
  return activePoolWordKeys.length === synced.activePoolWordKeys.length
    ? synced
    : { ...synced, activePoolWordKeys };
}

/** Days until a wall-clock due point, for diagnostics and UI. */
export function daysUntil(dueAt: string, now: string | Date): number {
  const date = typeof now === "string" ? new Date(now) : now;
  return Math.max(0, (Date.parse(dueAt) - date.getTime()) / DAY_MS);
}
