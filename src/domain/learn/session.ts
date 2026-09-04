import type { LearnSession, LevelProgress } from "../../shared/schemas";
import { cardDueAtMs, isCardDue } from "../memory";
import { curriculumOrder } from "../learning";
import type { LearningDeck } from "../learning";
import type { CreateLearnSessionOptions, CreateLearnSessionResult, NextLearnCard } from "./types";

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

/**
 * Creates one active Learn session for a grade, introducing new words.
 *
 * Membership (frozen at creation, persisted verbatim in the save):
 * 1. every currently **due introduced** word of the grade (a card is due when
 *    its FSRS due date has passed — never-reviewed cards are always due), in
 *    stable curriculum order;
 * 2. plus up to `settings.levelSize` **brand-new curriculum words**, pulled
 *    in curriculum order and introduced immediately.
 *
 * Throws when both sets are empty: a grade whose every word is introduced,
 * healthy (review), and not due has nothing to learn — the caller should show
 * the "all caught up" state instead of opening an empty session.
 */
export function createLearnSession(
  deck: LearningDeck,
  level: LevelProgress,
  now: string | Date,
  options: CreateLearnSessionOptions,
): CreateLearnSessionResult {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid timestamp");
  if (options.newCardLimit < 0) throw new RangeError("newCardLimit must be nonnegative");

  const order = curriculumOrder(deck, level.curriculumSeed);
  const dueIds: string[] = [];
  const newIds: string[] = [];
  for (const id of order) {
    const progress = level.words[id];
    if (!progress) continue; // reconciled decks can lag their level record
    if (progress.introducedAtOrdinal !== null) {
      if (isCardDue(progress.card, nowMs)) dueIds.push(id);
    } else if (newIds.length < options.newCardLimit) {
      newIds.push(id);
    }
  }
  if (dueIds.length === 0 && newIds.length === 0) {
    throw new RangeError("No learn candidates: nothing is due and no new curriculum words remain");
  }

  // Introduce the new words right away so a resumed session never re-picks
  // different words, and so the curriculum cursor reflects the introduction.
  let words = level.words;
  for (const id of newIds) {
    words = { ...words, [id]: { ...words[id]!, introducedAtOrdinal: options.spawnOrdinal } };
  }
  const introducedCount = Object.values(words).filter((progress) => progress.introducedAtOrdinal !== null).length;
  const nextLevel: LevelProgress = {
    ...level,
    words,
    curriculumCursor: Math.min(introducedCount, deck.words.length),
  };

  const wordIds = [...dueIds, ...newIds];
  const initialSession: LearnSession = {
    deckId: deck.id,
    deckFingerprint: deck.fingerprint,
    startedAt: isoTimestamp(now),
    wordIds,
    completedWordIds: [],
    currentWordId: wordIds[0]!,
  };
  const first = nextLearnCardId(initialSession, nextLevel, now);
  if (first.status !== "card") throw new Error("A newly created Learn session must contain a displayable word");
  return { level: nextLevel, session: { ...initialSession, currentWordId: first.wordId } };
}

/** Members still owed work: membership minus rating-time completions. A card
 * leaves the session only when a rating lands it in `review` — recorded in
 * `completedWordIds` — so a due maintenance card that already sat in review
 * is still served. A member rated Again stays (its card lapses to
 * `relearning`) and recurs until it passes. Unknown IDs (defensive against a
 * mid-session deck update) drop out. */
export function remainingLearnWordIds(session: LearnSession, level: LevelProgress): string[] {
  const completed = new Set(session.completedWordIds);
  return session.wordIds.filter((id) => !completed.has(id) && level.words[id] !== undefined);
}

/**
 * Picks the next card to serve: the **earliest due remaining member**.
 * Currently-due cards sort before future cards by definition, and when every
 * remaining card is in the future the earliest one is served anyway —
 * Anki-style learn-ahead, so the player never stares at a waiting screen.
 * Ties break on stable word ID for determinism.
 */
export function nextLearnCardId(session: LearnSession, level: LevelProgress, now: string | Date): NextLearnCard {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid timestamp");
  const remaining = remainingLearnWordIds(session, level);
  if (remaining.length === 0) return { status: "complete" };
  let best: { id: string; dueMs: number } | null = null;
  for (const id of remaining) {
    const dueMs = cardDueAtMs(level.words[id]!.card);
    if (best === null || dueMs < best.dueMs || (dueMs === best.dueMs && id < best.id)) best = { id, dueMs };
  }
  return { status: "card", wordId: best!.id, dueNow: best!.dueMs <= nowMs };
}

/** The earliest moment any introduced card of the grade becomes due, for the
 * "all caught up until …" message. Null when nothing is trackable. */
export function nextLearnDueAtMs(level: LevelProgress, now: string | Date): number | null {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  let earliest: number | null = null;
  for (const progress of Object.values(level.words)) {
    if (progress.introducedAtOrdinal === null) continue;
    const dueMs = cardDueAtMs(progress.card);
    if (dueMs <= nowMs) continue;
    if (earliest === null || dueMs < earliest) earliest = dueMs;
  }
  return earliest;
}
