import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { createComponentMemory, isGraduated } from "../memory";
import { curriculumOrder, introduceNewWords } from "./curriculum";
import type { LearningDeck } from "./types";

export function createWordProgress(): WordProgress {
  return {
    pinyin: createComponentMemory(),
    meaning: createComponentMemory(),
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
  curriculumSeed: string;
  levelSize: number;
  /** Global spawn ordinal at creation; introduced words join immediately. */
  spawnOrdinal: number;
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
  const level: LevelProgress = {
    deckId: deck.id,
    deckFingerprint: deck.fingerprint,
    curriculumSeed: options.curriculumSeed,
    curriculumCursor: 0,
    firstCompletedAt: null,
    words,
    orphanedProgress: {},
  };
  return introduceNewWords(level, deck, Math.max(1, options.levelSize), options.spawnOrdinal).level;
}

/** Introduced words that have not yet graduated in both components: the
 * arcade's working pool. Derived, never stored, so lapses rejoin it and
 * graduations leave it without any bookkeeping. */
export function acquisitionWordIds(level: LevelProgress): string[] {
  return Object.entries(level.words)
    .filter(([, progress]) => progress.introducedAtOrdinal !== null && !isGraduated(progress))
    .map(([id]) => id);
}

export function countGraduated(level: LevelProgress): number {
  return Object.values(level.words).reduce((count, word) => count + (isGraduated(word) ? 1 : 0), 0);
}

/** 1-based lesson label derived from how far the curriculum has advanced. */
export function curriculumLessonNumber(level: LevelProgress, levelSize: number): number {
  return Math.max(1, Math.floor(level.curriculumCursor / Math.max(1, levelSize)));
}

/** Stable FNV-based curriculum ordering (see curriculum.ts) exposed for
 * callers that need the full order, e.g. audio preloading. */
export { curriculumOrder };
