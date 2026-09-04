import type { DeckId } from "../../shared/constants";
import type { SaveFile } from "../../shared/schemas";
import { reviewCardMemory } from "../memory";
import { reviewWordKey } from "../review";
import { nextLearnCardId, remainingLearnWordIds } from "./session";
import type { LearnRating, LearnRatingApplication } from "./types";

/** Prepends a key to the ordered `acquired_words` table unless already
 * present. Exactly-once acquisition: later ratings never reorder or
 * duplicate. */
export function acquireWordKey(acquiredWords: readonly string[], key: string): { next: string[]; added: boolean } {
  if (acquiredWords.includes(key)) return { next: [...acquiredWords], added: false };
  return { next: [key, ...acquiredWords], added: true };
}

/**
 * Applies one explicit Learn self-rating to a word's card and threads every
 * derived bookkeeping through the save in one immutable step:
 *
 * 1. FSRS: the card advances (`reviewCardMemory`); `learnReviews` and
 *    `lastSeenAt` update. This is the ONLY path that ever mutates the card —
 *    review battles never do.
 * 2. Acquisition: when the post-rating card first reaches the review state,
 *    its cross-grade key enters `acquired_words` at the front, exactly once.
 * 3. Completion milestone: `firstCompletedAt` is stamped exactly once, at
 *    the rating that leaves EVERY grade word in FSRS review; later lapses
 *    (and their repairs) preserve the original stamp.
 * 4. Session: the word leaves the active session when its card is in review;
 *    when no members remain the session completes and is cleared, so the
 *    grade's next launch starts fresh.
 *
 * Persistence is the caller's job (the existing atomic save queue); this
 * function only produces the next snapshot.
 */
export function applyLearnRating(
  save: SaveFile,
  deckId: DeckId,
  wordId: string,
  rating: LearnRating,
  now: string | Date = new Date(),
): LearnRatingApplication {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  const level = save.levels[deckId];
  if (!level) throw new Error(`Missing level progress for ${deckId}`);
  const word = level.words[wordId];
  if (!word) throw new Error(`Unknown word ID: ${wordId}`);

  const card = reviewCardMemory(word.card, rating, date);
  const updatedWord = {
    ...word,
    card,
    learnReviews: word.learnReviews + 1,
    lastSeenAt: date.toISOString(),
  };

  const key = reviewWordKey(deckId, wordId);
  const reachedReview = card.state === "review";
  const { next: acquiredWords, added } = reachedReview
    ? acquireWordKey(save.acquiredWords, key)
    : { next: save.acquiredWords, added: false };

  // Grade-completion milestone: stamped EXACTLY ONCE, at the rating that
  // leaves every word of the grade in FSRS review. Later lapses (and their
  // repairs) preserve the original stamp — it records the first completion.
  const gradeComplete = Object.values({ ...level.words, [wordId]: updatedWord })
    .every((progress) => progress.card.state === "review");
  const firstCompletedAt = gradeComplete ? level.firstCompletedAt ?? date.toISOString() : level.firstCompletedAt;

  const nextLevel = { ...level, firstCompletedAt, words: { ...level.words, [wordId]: updatedWord } };

  const session = save.learnSessions[deckId as DeckId] ?? null;
  let learnSessions = save.learnSessions;
  let wordCompleted = false;
  let sessionCompleted = false;
  if (session) {
    let updated = session;
    // Rating-time removal: a member whose post-rating card sits in review is
    // done with this session (recorded explicitly so the session resumes
    // exactly, even across app restarts).
    if (reachedReview && session.wordIds.includes(wordId) && !session.completedWordIds.includes(wordId)) {
      updated = { ...session, completedWordIds: [...session.completedWordIds, wordId] };
      wordCompleted = true;
    }
    const remaining = remainingLearnWordIds(updated, nextLevel);
    sessionCompleted = remaining.length === 0;
    if (!sessionCompleted) {
      const next = nextLearnCardId(updated, nextLevel, date);
      if (next.status !== "card") throw new Error("An active Learn session must have a next word");
      // Persist the next presentation in the same snapshot as this rating.
      // A refresh can now resume the exact displayed card without rerunning
      // scheduler selection against a later clock.
      updated = { ...updated, currentWordId: next.wordId };
    }
    learnSessions = { ...learnSessions, [deckId]: sessionCompleted ? null : updated };
  }

  return {
    save: {
      ...save,
      levels: { ...save.levels, [deckId]: nextLevel },
      acquiredWords,
      learnSessions,
    },
    card,
    newlyAcquired: added,
    wordCompleted,
    sessionCompleted,
  };
}
