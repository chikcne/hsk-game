import { Effect } from "effect";
import { runDomain } from "../effect";
import { InvalidReviewKeyError } from "../errors";

/** Cross-grade identity: review keys scope a word ID by its grade so
 * identical source IDs cannot collide. The same key format identifies words
 * in the `acquired_words` table and in the active Relearn session. */
export function reviewWordKey(deckId: string, wordId: string): string {
  return `${deckId}:${wordId}`;
}

/** Typed variant of {@link reviewWordIdOf}: fails with an
 * `InvalidReviewKeyError` instead of throwing. */
export function reviewWordIdOfEffect(key: string): Effect.Effect<{ deckId: string; wordId: string }, InvalidReviewKeyError, never> {
  return Effect.suspend(() => {
    const separator = key.indexOf(":");
    if (separator <= 0) return Effect.fail(new InvalidReviewKeyError({ key }));
    return Effect.succeed({ deckId: key.slice(0, separator), wordId: key.slice(separator + 1) });
  });
}

export function reviewWordIdOf(key: string): { deckId: string; wordId: string } {
  return runDomain(reviewWordIdOfEffect(key));
}
