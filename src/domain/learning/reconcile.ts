import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { refillCurriculum } from "./curriculum";
import { createWordProgress } from "./progress";
import type { LearningDeck, ReconciliationResult } from "./types";

/** Reconciles stable IDs after a deck fingerprint change. Newly added words join
 * the current level so a previously cleared grade cannot silently skip them. */
export function reconcileLevelProgress(source: LevelProgress, deck: LearningDeck): ReconciliationResult {
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
      words[id] = { ...createWordProgress(), introducedAtOrdinal: source.nextSpawnOrdinal };
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

  const currentLevelWordIds = [...new Set([
    ...source.currentLevelWordIds.filter((id) => currentIds.has(id)),
    ...addedIds,
  ])];
  const activeLearningWordIds = [...new Set([
    ...source.activeLearningWordIds.filter((id) => currentIds.has(id) && words[id]?.phase !== "review"),
    ...addedIds,
  ])];
  const reconciled: LevelProgress = {
    ...source,
    deckFingerprint: deck.fingerprint,
    curriculumCursor: Object.values(words).filter((word) => word.introducedAtOrdinal !== null).length,
    currentLevelWordIds,
    activeLearningWordIds,
    reviewedOlderWordIds: source.reviewedOlderWordIds.filter((id) => currentIds.has(id)),
    words,
    orphanedProgress,
  };

  return {
    level: refillCurriculum(reconciled, deck),
    report: { retained, added: addedIds.length, removed },
  };
}
