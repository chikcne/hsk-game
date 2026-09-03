import type { LevelProgress, RuntimeDeck } from "../../shared/schemas";
import type { RandomState } from "../random";

export type LearningDeck = Pick<RuntimeDeck, "id" | "fingerprint"> & {
  words: ReadonlyArray<Pick<RuntimeDeck["words"][number], "id">>;
};

/** Partial because a save may never have touched every grade. */
export type LevelsMap = Partial<Record<string, LevelProgress>>;

/** Global spawn counter + RNG state shared by every mode, stored in the save
 * root so a word's microspacing survives crossings between sessions. */
export type SchedulerSnapshot = {
  spawnOrdinal: number;
  schedulerRng: RandomState;
};

/** Priority tiers for regular-mode selection. Graduated words fall into the
 * lowest tier, where they appear only when their FSRS due date has passed. */
export type SpawnTier = "relearning" | "learning" | "new" | "review";

export type RegularSpawnResult =
  | {
      status: "spawned";
      level: LevelProgress;
      snapshot: SchedulerSnapshot;
      wordId: string;
      spawnOrdinal: number;
      tier: SpawnTier;
      cooldownPhrases: number;
      familiarity: number;
      unseen: boolean;
    }
  | {
      /** Nothing eligible right now. `coolingOnly` means at least one word is
       * due but still ordinal-blocked, so the caller should keep the session
       * alive and advance ordinals on its empty-field clock. */
      status: "empty";
      level: LevelProgress;
      snapshot: SchedulerSnapshot;
      coolingOnly: boolean;
      /** When `coolingOnly`, the smallest `nextEligibleSpawn` among due-but-
       * blocked words: the ordinal at which the next spawn becomes possible.
       * Callers may fast-forward the empty-field clock straight here instead
       * of ticking one ordinal at a time. */
      blockedUntilOrdinal?: number;
    }
  | { status: "complete"; level: LevelProgress; snapshot: SchedulerSnapshot };

export type LearningTransition = "gradeCompleted" | "gradeMasteryRegressed";

export type ReconciliationReport = {
  retained: number;
  added: number;
  removed: number;
};

export type ReconciliationResult = {
  level: LevelProgress;
  report: ReconciliationReport;
};
