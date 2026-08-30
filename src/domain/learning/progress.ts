import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { createSecureRandomState, type RandomState } from "../random";
import { refillCurriculum } from "./curriculum";
import type { LearningDeck } from "./types";
import {
  INITIAL_APPEARANCE_WEIGHT,
  MIN_ARCADE_WORDS,
} from "./constants";

export function createWordProgress(): WordProgress {
  return {
    appearanceWeight: INITIAL_APPEARANCE_WEIGHT,
    attempts: 0,
    completeCorrect: 0,
    wrongPinyin: 0,
    wrongMeaning: 0,
    landed: 0,
    totalThinkingMs: 0,
    fastestCorrectMs: null,
    lastOutcome: null,
    lastSeenAt: null,
    introducedAtOrdinal: null,
    lastSpawnOrdinal: null,
    nextEligibleSpawn: 0,
    reinforcementRemaining: 0,
  };
}

export type CreateLevelOptions = {
  schedulerRng: RandomState;
  curriculumSeed: string;
};

export function createLevelProgress(
  deck: LearningDeck,
  options: CreateLevelOptions,
): LevelProgress {
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
  if (ids.length < MIN_ARCADE_WORDS) {
    throw new RangeError(`Arcade scheduling requires at least ${MIN_ARCADE_WORDS} logical words`);
  }

  const words: Record<string, WordProgress> = {};
  for (const id of ids) words[id] = createWordProgress();

  const level: LevelProgress = {
    deckId: deck.id,
    deckFingerprint: deck.fingerprint,
    nextSpawnOrdinal: 0,
    schedulerRng: [...options.schedulerRng],
    curriculumSeed: options.curriculumSeed,
    curriculumCursor: 0,
    activeLearningWordIds: [],
    firstCompletedAt: null,
    words,
    orphanedProgress: {},
  };
  return refillCurriculum(level, deck);
}

/** First-run factory using independent cryptographic seeds for schedule and curriculum. */
export function createSecureLevelProgress(deck: LearningDeck): LevelProgress {
  const schedulerRng = createSecureRandomState();
  const curriculumWords = createSecureRandomState();
  const curriculumSeed = curriculumWords
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
  return createLevelProgress(deck, { schedulerRng, curriculumSeed });
}

export function countMastered(level: LevelProgress): number {
  return Object.values(level.words).reduce(
    (count, word) => count + (word.appearanceWeight === 1 ? 1 : 0),
    0,
  );
}

export function isLiveMastered(level: LevelProgress): boolean {
  const records = Object.values(level.words);
  return records.length > 0 && records.every((word) => word.appearanceWeight === 1);
}
