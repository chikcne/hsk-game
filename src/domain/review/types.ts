import { isGraduated, isMemoryDue, isRelearning } from "../memory";
import type { LevelsMap, SchedulerSnapshot } from "../learning";

export type { LevelsMap, SchedulerSnapshot };

export type ReviewSpawnResult =
  | {
      status: "spawned";
      levels: LevelsMap;
      snapshot: SchedulerSnapshot;
      wordKey: string;
      spawnOrdinal: number;
      tier: "relearning" | "review";
      cooldownPhrases: number;
      familiarity: number;
    }
  | { status: "complete"; levels: LevelsMap; snapshot: SchedulerSnapshot };

/** Cross-grade identity: review keys scope a word ID by its grade deck so
 * identical source IDs cannot collide. */
export function reviewWordKey(deckId: string, wordId: string): string { return `${deckId}:${wordId}`; }

export function reviewWordIdOf(key: string): { deckId: string; wordId: string } {
  const separator = key.indexOf(":");
  if (separator <= 0) throw new Error(`Invalid review word key: ${key}`);
  return { deckId: key.slice(0, separator), wordId: key.slice(separator + 1) };
}

/** Counts introduced graduated-or-relearning words that are due right now —
 * the honest size of a review session. */
export function countDueReviewWords(levels: LevelsMap, now: string | Date): number {
  let count = 0;
  for (const level of Object.values(levels)) {
    if (!level) continue;
    for (const progress of Object.values(level.words)) {
      if (progress.introducedAtOrdinal === null) continue;
      const repairable = isRelearning(progress.pinyin) || isRelearning(progress.meaning) || isGraduated(progress);
      if (repairable && isMemoryDue(progress, now)) count += 1;
    }
  }
  return count;
}
