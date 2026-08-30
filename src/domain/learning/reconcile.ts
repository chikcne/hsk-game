import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { refillCurriculum } from "./curriculum";
import { createWordProgress } from "./progress";
import type { LearningDeck, ReconciliationResult } from "./types";

/** Reconciles stable IDs after a deck fingerprint change, preserving permanent milestones. */
export function reconcileLevelProgress(
  source: LevelProgress,
  deck: LearningDeck,
): ReconciliationResult {
  if (source.deckId !== deck.id) {
    throw new Error(`Cannot reconcile ${source.deckId} progress with ${deck.id}`);
  }
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
  const currentIds = new Set(ids);
  const words: Record<string, WordProgress> = {};
  const orphanedProgress: Record<string, WordProgress> = {};
  let retained = 0;
  let added = 0;

  for (const id of ids) {
    const existing = source.words[id] ?? source.orphanedProgress[id];
    if (existing === undefined) {
      words[id] = createWordProgress();
      added += 1;
    } else {
      words[id] = existing;
      retained += 1;
    }
  }

  for (const [id, progress] of Object.entries(source.orphanedProgress)) {
    if (!currentIds.has(id)) orphanedProgress[id] = progress;
  }
  let removed = 0;
  for (const [id, progress] of Object.entries(source.words)) {
    if (!currentIds.has(id)) {
      orphanedProgress[id] = progress;
      removed += 1;
    }
  }

  const activeLearningWordIds = source.activeLearningWordIds.filter(
    (id) => currentIds.has(id) && words[id]?.appearanceWeight !== 1,
  );
  // Restarting the cursor is intentional: refill skips records with introducedAtOrdinal,
  // so changed hash order cannot reintroduce retained words or strand newly added IDs.
  const reconciled: LevelProgress = {
    ...source,
    deckFingerprint: deck.fingerprint,
    curriculumCursor: 0,
    activeLearningWordIds: [...new Set(activeLearningWordIds)],
    words,
    orphanedProgress,
  };

  return {
    level: refillCurriculum(reconciled, deck),
    report: { retained, added, removed },
  };
}
