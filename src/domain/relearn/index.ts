import type { ComponentMemory, RelearnSession, SaveFile } from "../../shared/schemas";
import { createCardMemory, reviewCardMemory, type MemoryRating } from "../memory";

export type { RelearnSession };

export type { MemoryRating as RelearnRating };

/** Creates THE one active Relearn session from selected acquired word keys.
 * Every member receives a fresh, fully independent FSRS card (state New,
 * due epoch, zero counters) stored inside the session — deliberately not
 * the word's main Learn card, which relearn ratings never touch. */
export function createRelearnSession(wordKeys: readonly string[], now: string | Date): RelearnSession {
  if (wordKeys.length === 0) throw new RangeError("A relearn session needs at least one word");
  if (new Set(wordKeys).size !== wordKeys.length) throw new RangeError("Relearn session word keys must be unique");
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  const cards: RelearnSession["cards"] = {};
  for (const key of wordKeys) cards[key] = { card: createCardMemory(), reviews: 0 };
  return { startedAt: date.toISOString(), wordKeys: [...wordKeys], cards };
}

export type NextRelearnCard =
  | { status: "card"; wordKey: string; /** True when the independent card is due right now (false = learn-ahead). */ dueNow: boolean }
  | { status: "complete" };

/** Picks the next member to serve: the earliest due independent card, ties
 * broken by selection order (wordKeys order) for determinism. When nothing
 * is currently due the earliest future card is served anyway — Anki-style
 * learn-ahead, exactly like Learn Mode. */
export function nextRelearnKey(session: RelearnSession, now: string | Date): NextRelearnCard {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid timestamp");
  let best: { key: string; dueMs: number } | null = null;
  for (const key of session.wordKeys) {
    const state = session.cards[key];
    if (!state) continue; // defensive against a corrupted/partial session
    const dueMs = Date.parse(state.card.due);
    if (best === null || dueMs < best.dueMs) best = { key, dueMs };
  }
  if (best === null) return { status: "complete" };
  return { status: "card", wordKey: best.key, dueNow: best.dueMs <= nowMs };
}

export type RelearnRatingApplication = {
  /** The full next save snapshot: relearnSession + acquiredWords updated.
   * `levels` (the main Learn cards) is carried over untouched. */
  save: SaveFile;
  /** The independent card state after the rating. */
  card: ComponentMemory;
  /** True when this rating moved the independent card into FSRS `review`:
   * the key now leaves the session and moves to the front of
   * `acquired_words`. */
  keyFinished: boolean;
  /** True when the key moved to (or stayed at, deduped) the front of
   * `acquired_words` this rating. */
  reacquired: boolean;
  /** True when the last member finished and the session was cleared. */
  sessionCompleted: boolean;
};

/**
 * Applies one explicit rating to a member's INDEPENDENT card inside the
 * active Relearn session. One pure, immutable step:
 *
 * 1. the session card advances with FSRS and its `reviews` counter bumps —
 *    main Learn cards in `save.levels` are never read or written here;
 * 2. when the post-rating card reaches FSRS state `review` the word has
 *    re-finished: its key is removed from the session and prepended to
 *    `acquired_words` (moved to newest/front, deduped);
 * 3. when no members remain the session clears to null.
 *
 * Persistence is the caller's job (the atomic save queue); save after every
 * rating so exiting mid-session preserves exact state.
 */
export function applyRelearnRating(
  save: SaveFile,
  wordKey: string,
  rating: MemoryRating,
  now: string | Date = new Date(),
): RelearnRatingApplication {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  const session = save.relearnSession;
  if (!session) throw new Error("No active relearn session");
  const state = session.cards[wordKey];
  if (!state || !session.wordKeys.includes(wordKey)) {
    throw new Error(`Word key is not a member of the active relearn session: ${wordKey}`);
  }

  const card = reviewCardMemory(state.card, rating, date);
  const keyFinished = card.state === "review";

  let nextSession: RelearnSession | null = {
    ...session,
    cards: { ...session.cards, [wordKey]: { card, reviews: state.reviews + 1 } },
  };
  let acquiredWords = save.acquiredWords;
  let reacquired = false;
  if (keyFinished) {
    const remainingKeys = session.wordKeys.filter((key) => key !== wordKey);
    const nextCards = { ...session.cards };
    delete nextCards[wordKey];
    nextSession = { ...session, wordKeys: remainingKeys, cards: nextCards };
    // Move to newest/front, exactly once (dedupe).
    reacquired = true;
    acquiredWords = [wordKey, ...save.acquiredWords.filter((key) => key !== wordKey)];
    if (remainingKeys.length === 0) nextSession = null;
  }

  return {
    save: { ...save, acquiredWords, relearnSession: nextSession },
    card,
    keyFinished,
    reacquired,
    sessionCompleted: nextSession === null,
  };
}
