import { Effect } from "effect";
import { runDomain } from "../effect";
import { DuplicateWordIdsError } from "../errors";
import type { LearningDeck } from "./types";

export type CurriculumOrderFailure = DuplicateWordIdsError;

/** Small deterministic curriculum constructor for runtime-only synthetic
 * decks (demo, Review presentation decks, and focused tests). Production
 * grade decks always use the committed authored manifest. */
export function curriculumFromWordIds(wordIds: readonly string[], rulesVersion = "synthetic-v1") {
  const lessons: Array<{ id: string; wordIds: string[] }> = [];
  for (let index = 0; index < wordIds.length; index += 20) {
    lessons.push({ id: `lesson-${lessons.length + 1}`, wordIds: wordIds.slice(index, index + 20) });
  }
  return { rulesVersion, lessonSize: 20 as const, lessons };
}

/** Typed variant of {@link curriculumOrder}: fails with a
 * `DuplicateWordIdsError` instead of throwing. */
export function curriculumOrderEffect(deck: LearningDeck): Effect.Effect<string[], CurriculumOrderFailure, never> {
  return Effect.gen(function* () {
    const ids = deck.words.map((word) => word.id);
    if (new Set(ids).size !== ids.length) return yield* Effect.fail(new DuplicateWordIdsError());
    const order = deck.curriculum.lessons.flatMap((lesson) => lesson.wordIds);
    if (new Set(order).size !== order.length || order.length !== ids.length || order.some((id) => !ids.includes(id))) {
      return yield* Effect.fail(new DuplicateWordIdsError());
    }
    return order;
  });
}

export function curriculumOrder(deck: LearningDeck): string[] {
  return runDomain(curriculumOrderEffect(deck));
}
