import { Effect } from "effect";
import type { LearnSession, LevelProgress, SaveFile } from "../../shared/schemas";
import { runDomain } from "../effect";
import type {
  DeckMismatchError,
  DuplicateWordIdsError,
  EmptyWordSetError,
  InvalidTimestampError,
  NegativeLimitError,
  NoLearnCandidatesError,
} from "../errors";
import { createLevelProgressEffect, reconcileLevelProgressEffect, type LearningDeck } from "../learning";
import { createLearnSessionEffect } from "./session";

/** Everything `App.deployLearn` must persist before opening the Learn
 * screen. `levels` and `session` are BOTH produced here so a newly created
 * session's introduced words and advanced `curriculumCursor` are never
 * lost — the original bug was queueing a snapshot that contained the new
 * session but the OLD level record, which re-introduced the same words on
 * every subsequent launch. */
export type LearnLaunch = {
  /** The full levels map to persist (same object when nothing changed). */
  levels: SaveFile["levels"];
  /** The session to persist for the grade (resumed or freshly created). */
  session: LearnSession;
  /** True when `levels` or the session differ from the save — the caller
   * must queue a snapshot. */
  changed: boolean;
};

export type PrepareLearnLaunchOptions = {
  /** settings.levelSize: the per-session cap on brand-new curriculum words. */
  levelSize: number;
  /** Per-profile curriculum seed used ONLY when the grade has no level
   * record yet (callers pass a secure random seed; tests pass a fixed one). */
  newLevelSeed: string;
};

export type PrepareLearnLaunchFailure =
  | DeckMismatchError
  | DuplicateWordIdsError
  | EmptyWordSetError
  | InvalidTimestampError
  | NegativeLimitError
  | NoLearnCandidatesError;

/** Pure deployment plan for one Learn Mode launch of `deck`:
 *
 * 1. a level whose deck fingerprint changed is reconciled; the grade's
 *    stale active session (if any) is invalidated in the same step;
 * 2. a missing level is created (fully unintroduced);
 * 3. without a resumable session, `createLearnSessionEffect` runs and —
 *    crucially — the returned level (with `introducedAtOrdinal` and
 *    `curriculumCursor` advanced) is written back into `levels`.
 *
 * Fails with `NoLearnCandidatesError` when the grade is all caught up:
 * nothing due and no new curriculum words remain. */
export function prepareLearnLaunchEffect(
  current: Pick<SaveFile, "levels" | "learnSessions" | "spawnOrdinal">,
  deck: LearningDeck,
  now: string | Date,
  options: PrepareLearnLaunchOptions,
): Effect.Effect<LearnLaunch, PrepareLearnLaunchFailure, never> {
  return Effect.gen(function* () {
    let levels = current.levels;
    let level: LevelProgress | undefined = levels[deck.id];
    let session = current.learnSessions[deck.id] ?? null;

    if (level && level.deckFingerprint !== deck.fingerprint) {
      level = (yield* reconcileLevelProgressEffect(level, deck, current.spawnOrdinal)).level;
      levels = { ...levels, [deck.id]: level };
      session = null; // a stale session cannot survive a deck update
    }
    if (!level) {
      level = yield* createLevelProgressEffect(deck, { curriculumSeed: options.newLevelSeed });
      levels = { ...levels, [deck.id]: level };
      session = null;
    }
    if (!session) {
      const created = yield* createLearnSessionEffect(deck, level, now, {
        newCardLimit: options.levelSize,
        spawnOrdinal: current.spawnOrdinal,
      });
      // THE critical write-back: the created level carries the new words'
      // introductions and the advanced curriculum cursor; forgetting to
      // persist it made every launch re-introduce the same first batch.
      level = created.level;
      session = created.session;
      levels = { ...levels, [deck.id]: level };
    }

    return {
      levels,
      session,
      changed: levels !== current.levels || current.learnSessions[deck.id] !== session,
    };
  });
}

/** Legacy throwing adapter for {@link prepareLearnLaunchEffect}: raises the
 * same `RangeError` (via `createLearnSession`) when the grade is all caught
 * up. */
export function prepareLearnLaunch(
  current: Pick<SaveFile, "levels" | "learnSessions" | "spawnOrdinal">,
  deck: LearningDeck,
  now: string | Date,
  options: PrepareLearnLaunchOptions,
): LearnLaunch {
  return runDomain(prepareLearnLaunchEffect(current, deck, now, options));
}
