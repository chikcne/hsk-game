import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { createCardMemory } from "../memory";
import { curriculumOrder } from "./curriculum";
import type { LearningDeck } from "./types";

export function createWordProgress(): WordProgress {
  return {
    card: createCardMemory(),
    learnReviews: 0,
    lastSeenAt: null,
    introducedAtOrdinal: null,
  };
}

export type CreateLevelOptions = {
  curriculumSeed: string;
};

/** A fresh grade record: every curriculum word present and untouched. Words
 * are introduced exclusively by Learn sessions (or reconciliation), never at
 * creation time. */
export function createLevelProgress(
  deck: LearningDeck,
  options: CreateLevelOptions,
): LevelProgress {
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
  if (ids.length === 0) throw new RangeError("A learning grade must contain at least one word");

  const words: Record<string, WordProgress> = {};
  for (const id of ids) words[id] = createWordProgress();
  return {
    deckId: deck.id,
    deckFingerprint: deck.fingerprint,
    curriculumSeed: options.curriculumSeed,
    curriculumCursor: 0,
    firstCompletedAt: null,
    words,
    orphanedProgress: {},
  };
}

/** Words whose card sits in the review stage (the product's "mastered" count
 * on the grade screen). Lapsed cards sit in `relearning` and dip out of this
 * derived count until repaired — while staying in the acquired_words table. */
export function countGraduated(level: LevelProgress): number {
  return Object.values(level.words).reduce((count, word) => count + (word.card.state === "review" ? 1 : 0), 0);
}

/** 1-based lesson label derived from how far the curriculum has advanced. */
export function curriculumLessonNumber(level: LevelProgress, levelSize: number): number {
  return Math.max(1, Math.floor(level.curriculumCursor / Math.max(1, levelSize)));
}

/** Stable FNV-based curriculum ordering (see curriculum.ts) exposed for
 * callers that need the full order, e.g. audio preloading. */
export { curriculumOrder };
