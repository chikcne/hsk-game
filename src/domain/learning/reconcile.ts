import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { createWordProgress } from "./progress";
import type { LearningDeck, ReconciliationResult } from "./types";

/** Reconciles stable IDs after a deck fingerprint change. Newly added words
 * join the current pool so a previously cleared grade cannot silently skip
 * them; removed words are preserved as orphans. Memory states ride along with
 * their word ID, so no recall history is lost. */
export function reconcileLevelProgress(
  source: LevelProgress,
  deck: LearningDeck,
  spawnOrdinal: number,
): ReconciliationResult {
  if (source.deckId !== deck.id) throw new Error(`Cannot reconcile ${source.deckId} progress with ${deck.id}`);
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
      words[id] = { ...createWordProgress(), introducedAtOrdinal: spawnOrdinal };
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
