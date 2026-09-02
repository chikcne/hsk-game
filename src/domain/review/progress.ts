import type { ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import { randomStateFromSeed, type RandomState } from "../random";

export function reviewWordKey(deckId: string, wordId: string): string { return `${deckId}:${wordId}`; }

export function createReviewWordProgress(dueOrdinal = 0): ReviewWordProgress {
  return {
    recallScoreMsPerChar: null,
    easeFactor: 2.5,
    interval: 0,
    dueOrdinal,
    repetitions: 0,
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
export function syncReviewProgress(source: ReviewProgress, masteredWordKeys: Iterable<string>): ReviewProgress {
  let words = source.words;
  for (const key of masteredWordKeys) {
    if (words[key]) continue;
    if (words === source.words) words = { ...source.words };
    words[key] = createReviewWordProgress(source.nextSpawnOrdinal);
  }
  const activePoolWordKeys = [...new Set(source.activePoolWordKeys)].filter((key) => words[key] !== undefined);
  return words === source.words && activePoolWordKeys.length === source.activePoolWordKeys.length
    ? source
    : { ...source, words, activePoolWordKeys };
}

/** Anki advances by time between sessions. Encounter ordinals are our local
 * equivalent, so a fresh round advances to the earliest scheduled card. */
export function prepareReviewRound(source: ReviewProgress, masteredWordKeys: ReadonlySet<string>): ReviewProgress {
  const synced = syncReviewProgress(source, masteredWordKeys);
  const due = [...masteredWordKeys].flatMap((key) => synced.words[key] ? [synced.words[key]!.dueOrdinal] : []);
  if (due.length === 0 || due.some((ordinal) => ordinal <= synced.nextSpawnOrdinal)) return synced;
  return { ...synced, nextSpawnOrdinal: Math.min(...due) };
}
