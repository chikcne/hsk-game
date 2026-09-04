import { Effect } from "effect";
import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { runDomain } from "../effect";
import { DeckMismatchError, DuplicateWordIdsError } from "../errors";
import { createWordProgress } from "./progress";
import type { LearningDeck, ReconciliationResult } from "./types";

export type ReconcileLevelProgressFailure = DeckMismatchError | DuplicateWordIdsError;

function reconcileLevelProgressUnchecked(source: LevelProgress, deck: LearningDeck, ids: string[]): ReconciliationResult {
  const currentIds = new Set(ids);
  const words: Record<string, WordProgress> = {};
  const orphanedProgress: Record<string, WordProgress> = {};
  const addedIds: string[] = [];
  let retained = 0;

  for (const id of ids) {
    const existing = source.words[id] ?? source.orphanedProgress[id];
    if (existing === undefined) {
      // Deliberately unintroduced: introduction stays a Learn-session act,
      // capped by levelSize per session, keeping the lesson pace intact
      // after a deck update.
      words[id] = createWordProgress();
      addedIds.push(id);
    } else {
      words[id] = existing;
      retained += 1;
    }
  }
  for (const [id, progress] of Object.entries(source.orphanedProgress)) if (!currentIds.has(id)) orphanedProgress[id] = progress;
  let removed = 0;
  for (const [id, progress] of Object.entries(source.words)) {
    if (!currentIds.has(id)) { orphanedProgress[id] = progress; removed += 1; }
  }

  const reconciled: LevelProgress = {
    ...source,
    deckFingerprint: deck.fingerprint,
    curriculumCursor: Object.values(words).filter((word) => word.introducedAtOrdinal !== null).length,
    firstCompletedAt: source.firstCompletedAt,
    words,
    orphanedProgress,
  };

  return {
    level: reconciled,
    report: { retained, added: addedIds.length, removed },
  };
}

/** Typed variant of {@link reconcileLevelProgress}: fails with a
 * `DeckMismatchError` or a `DuplicateWordIdsError` instead of throwing. */
export function reconcileLevelProgressEffect(
  source: LevelProgress,
  deck: LearningDeck,
  spawnOrdinal: number,
): Effect.Effect<ReconciliationResult, ReconcileLevelProgressFailure, never> {
  return Effect.gen(function* () {
    if (source.deckId !== deck.id) return yield* Effect.fail(new DeckMismatchError({ sourceDeckId: source.deckId, deckId: deck.id }));
    // Retained in the signature as the save's reference counter (validation
    // caps persisted ordinals against it); reconciliation itself no longer
    // assigns introductions.
    void spawnOrdinal;
    const ids = deck.words.map((word) => word.id);
    if (new Set(ids).size !== ids.length) return yield* Effect.fail(new DuplicateWordIdsError());
    return yield* Effect.sync(() => reconcileLevelProgressUnchecked(source, deck, ids));
  });
}

/** Reconciles stable IDs after a deck fingerprint change. Newly added words
 * join the grade as fully UNINTRODUCED cards (`introducedAtOrdinal: null`),
 * so the next Learn sessions pick them up through the normal
 * `settings.levelSize` gate instead of dumping the whole deck diff into one
 * session; removed words are preserved as orphans. Memory states ride along
 * with their word ID, so no recall history is lost.
 *
 * Legacy throwing adapter: raises the same `Error` as before on a deck
 * mismatch or duplicate word IDs. */
export function reconcileLevelProgress(
  source: LevelProgress,
  deck: LearningDeck,
  spawnOrdinal: number,
): ReconciliationResult {
  return runDomain(reconcileLevelProgressEffect(source, deck, spawnOrdinal));
}
