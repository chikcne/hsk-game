import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { createWordProgress } from "./progress";
import type { LearningDeck, ReconciliationResult } from "./types";

/** Reconciles stable IDs after a deck fingerprint change. Newly added words
 * join the grade as fully UNINTRODUCED cards (`introducedAtOrdinal: null`),
 * so the next Learn sessions pick them up through the normal
 * `settings.levelSize` gate instead of dumping the whole deck diff into one
 * session; removed words are preserved as orphans. Memory states ride along
 * with their word ID, so no recall history is lost. */
export function reconcileLevelProgress(
  source: LevelProgress,
  deck: LearningDeck,
  spawnOrdinal: number,
): ReconciliationResult {
  if (source.deckId !== deck.id) throw new Error(`Cannot reconcile ${source.deckId} progress with ${deck.id}`);
  // Retained in the signature as the save's reference counter (validation
  // caps persisted ordinals against it); reconciliation itself no longer
  // assigns introductions.
  void spawnOrdinal;
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
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
