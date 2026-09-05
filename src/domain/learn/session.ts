import { Effect } from "effect";
import type { LearnSession, LevelProgress } from "../../shared/schemas";
import { runDomain, validTimestamp } from "../effect";
import { DuplicateWordIdsError, InvalidTimestampError, NegativeLimitError, NoLearnCandidatesError } from "../errors";
import { curriculumOrderEffect, type LearningDeck } from "../learning";
import { cardDueAtMs, isCardDue } from "../memory";
import type { CreateLearnSessionOptions, CreateLearnSessionResult, NextLearnCard } from "./types";

function isoTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export type CreateLearnSessionFailure =
  | DuplicateWordIdsError
  | InvalidTimestampError
  | NegativeLimitError
  | NoLearnCandidatesError;

export type NextLearnCardFailure = InvalidTimestampError;

/** Membership selection shared by the typed and legacy session builders:
 * every currently due introduced word (in curriculum order) plus up to
 * `options.newCardLimit` brand-new curriculum words. */
function selectLearnCandidates(
  deck: LearningDeck,
  level: LevelProgress,
  nowMs: number,
  options: CreateLearnSessionOptions,
): { dueIds: string[]; newIds: string[] } {
  const order = deck.curriculum.lessons.flatMap((lesson) => lesson.wordIds);
  const dueIds: string[] = [];
  const currentLesson = deck.curriculum.lessons.find((lesson) =>
    lesson.wordIds.some((id) => level.words[id]?.introducedAtOrdinal === null));
  for (const id of order) {
    const progress = level.words[id];
    if (!progress) continue; // reconciled decks can lag their level record
    if (progress.introducedAtOrdinal !== null) {
      if (isCardDue(progress.card, nowMs)) dueIds.push(id);
    }
  }
  const newIds = (currentLesson?.wordIds ?? [])
    .filter((id) => level.words[id]?.introducedAtOrdinal === null)
    .slice(0, Math.min(options.newCardLimit, deck.curriculum.lessonSize));
  return { dueIds, newIds };
}

/**
 * Creates one active Learn session for a grade, introducing new words.
 *
 * Membership (frozen at creation, persisted verbatim in the save):
 * 1. every currently **due introduced** word of the grade (a card is due when
 *    its FSRS due date has passed — never-reviewed cards are always due), in
 *    stable curriculum order;
 * 2. plus up to the configured new-card limit **brand-new curriculum
 *    words**, pulled only from the current fixed 20-card lesson and
 *    introduced immediately.
 *
 * Fails with `NoLearnCandidatesError` when both sets are empty: a grade whose
 * every word is introduced, healthy (review), and not due has nothing to
 * learn — the caller should show the "all caught up" state instead of
 * opening an empty session. */
export function createLearnSessionEffect(
  deck: LearningDeck,
  level: LevelProgress,
  now: string | Date,
  options: CreateLearnSessionOptions,
): Effect.Effect<CreateLearnSessionResult, CreateLearnSessionFailure, never> {
  return Effect.gen(function* () {
    const nowMs = yield* validTimestamp(now);
    if (options.newCardLimit < 0) return yield* Effect.fail(new NegativeLimitError({ param: "newCardLimit" }));

    yield* curriculumOrderEffect(deck);
    const { dueIds, newIds } = selectLearnCandidates(deck, level, nowMs, options);
    if (dueIds.length === 0 && newIds.length === 0) {
      return yield* Effect.fail(new NoLearnCandidatesError());
    }
    return yield* Effect.sync(() => createLearnSessionUnchecked(deck, level, nowMs, options, dueIds, newIds));
  });
}

function createLearnSessionUnchecked(
  deck: LearningDeck,
  level: LevelProgress,
  nowMs: number,
  options: CreateLearnSessionOptions,
  dueIds: string[],
  newIds: string[],
): CreateLearnSessionResult {
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
    startedAt: isoTimestamp(nowMs),
    wordIds,
    completedWordIds: [],
    currentWordId: wordIds[0]!,
  };
  const first = nextLearnCardIdUnchecked(initialSession, nextLevel, nowMs);
  // Impossible after the candidate check above; surfaces as a defect.
  if (first.status !== "card") throw new Error("A newly created Learn session must contain a displayable word");
  return { level: nextLevel, session: { ...initialSession, currentWordId: first.wordId } };
}

/**
 * Creates one active Learn session for a grade (see
 * {@link createLearnSessionEffect}).
 *
 * Legacy throwing adapter: raises the same `RangeError`s as before —
 * including for the all-caught-up grade — and the same `Error` for duplicate
 * deck word IDs. */
export function createLearnSession(
  deck: LearningDeck,
  level: LevelProgress,
  now: string | Date,
  options: CreateLearnSessionOptions,
): CreateLearnSessionResult {
  return runDomain(createLearnSessionEffect(deck, level, now, options));
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
 * Ties break on stable word ID for determinism. */
export function nextLearnCardIdEffect(session: LearnSession, level: LevelProgress, now: string | Date): Effect.Effect<NextLearnCard, NextLearnCardFailure, never> {
  return Effect.map(validTimestamp(now), (nowMs) => nextLearnCardIdUnchecked(session, level, nowMs));
}

export function nextLearnCardIdUnchecked(session: LearnSession, level: LevelProgress, nowMs: number): NextLearnCard {
  const remaining = remainingLearnWordIds(session, level);
  if (remaining.length === 0) return { status: "complete" };
  let best: { id: string; dueMs: number } | null = null;
  for (const id of remaining) {
    const dueMs = cardDueAtMs(level.words[id]!.card);
    if (best === null || dueMs < best.dueMs || (dueMs === best.dueMs && id < best.id)) best = { id, dueMs };
  }
  return { status: "card", wordId: best!.id, dueNow: best!.dueMs <= nowMs };
}

export function nextLearnCardId(session: LearnSession, level: LevelProgress, now: string | Date): NextLearnCard {
  return runDomain(nextLearnCardIdEffect(session, level, now));
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
