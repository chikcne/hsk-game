import type { DifficultySettings, LevelProgress, WordProgress } from "../../shared/schemas";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import { createSecureRandomState, type RandomState } from "../random";
import { curriculumOrder } from "./curriculum";
import type { LearningDeck } from "./types";
import { INITIAL_DIFFICULTY } from "./constants";

export function createWordProgress(): WordProgress {
  return {
    phase: "new",
    stepIndex: 0,
    dueOrdinal: null,
    dueAt: null,
    stability: 0,
    difficulty: INITIAL_DIFFICULTY,
    lapses: 0,
    lastGrade: null,
    attempts: 0,
    completeCorrect: 0,
    wrongPinyin: 0,
    wrongMeaning: 0,
    landed: 0,
    totalThinkingMs: 0,
    fastestCorrectMs: null,
    totalPinyinMs: 0,
    fastestPinyinMs: null,
    lastPinyinMs: null,
    lastOutcome: null,
    lastSeenAt: null,
    introducedAtOrdinal: null,
    lastSpawnOrdinal: null,
    nextEligibleSpawn: 0,
  };
}

export type CreateLevelOptions = {
  schedulerRng: RandomState;
  curriculumSeed: string;
  levelSize?: number;
};

export function createLevelProgress(
  deck: LearningDeck,
  options: CreateLevelOptions,
): LevelProgress {
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
  if (ids.length === 0) throw new RangeError("A learning grade must contain at least one word");

  const words: Record<string, WordProgress> = {};
  for (const id of ids) words[id] = createWordProgress();
  const levelSize = Math.max(1, Math.min(options.levelSize ?? DEFAULT_SETTINGS.levelSize, ids.length));
  const firstIds = curriculumOrder(deck, options.curriculumSeed).slice(0, levelSize);
  for (const id of firstIds) words[id] = { ...words[id]!, introducedAtOrdinal: 0 };

  return {
    deckId: deck.id,
    deckFingerprint: deck.fingerprint,
    nextSpawnOrdinal: 0,
    schedulerRng: [...options.schedulerRng],
    curriculumSeed: options.curriculumSeed,
    curriculumCursor: firstIds.length,
    currentLevelIndex: 0,
    currentLevelWordIds: firstIds,
    activeLearningWordIds: [...firstIds],
    reviewedOlderWordIds: [],
    firstCompletedAt: null,
    words,
    orphanedProgress: {},
  };
}

/** First-run factory using independent cryptographic seeds for schedule and curriculum. */
export function createSecureLevelProgress(
  deck: LearningDeck,
  settings: Pick<DifficultySettings, "levelSize"> = DEFAULT_SETTINGS,
): LevelProgress {
  const schedulerRng = createSecureRandomState();
  const curriculumWords = createSecureRandomState();
  const curriculumSeed = curriculumWords.map((word) => word.toString(16).padStart(8, "0")).join("");
  return createLevelProgress(deck, { schedulerRng, curriculumSeed, levelSize: settings.levelSize });
}

/** A word is mastered once it has graduated into long-term review and has
 * not lapsed back into relearning. */
export function countMastered(level: LevelProgress): number {
  return Object.values(level.words).reduce((count, word) => count + (word.phase === "review" ? 1 : 0), 0);
}

export function isLiveMastered(level: LevelProgress): boolean {
  const records = Object.values(level.words);
  return records.length > 0 && records.every((word) => word.phase === "review");
}
