import { Effect } from "effect";
import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { runDomain } from "../effect";
import { DuplicateWordIdsError, EmptyWordSetError } from "../errors";
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

export type CreateLevelProgressFailure = DuplicateWordIdsError | EmptyWordSetError;

/** Typed variant of {@link createLevelProgress}: fails with a
 * `DuplicateWordIdsError` or an `EmptyWordSetError` instead of throwing. */
export function createLevelProgressEffect(
  deck: LearningDeck,
  options: CreateLevelOptions,
): Effect.Effect<LevelProgress, CreateLevelProgressFailure, never> {
  return Effect.gen(function* () {
    const ids = deck.words.map((word) => word.id);
    if (new Set(ids).size !== ids.length) return yield* Effect.fail(new DuplicateWordIdsError());
    if (ids.length === 0) return yield* Effect.fail(new EmptyWordSetError({ subject: "learning grade" }));
    return yield* Effect.sync(() => {
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
    });
  });
}

/** A fresh grade record: every curriculum word present and untouched. Words
 * are introduced exclusively by Learn sessions (or reconciliation), never at
 * creation time.
 *
 * Legacy throwing adapter: raises the same `Error`/`RangeError` as before
 * for duplicate or empty decks. */
export function createLevelProgress(
  deck: LearningDeck,
  options: CreateLevelOptions,
): LevelProgress {
  return runDomain(createLevelProgressEffect(deck, options));
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
