import type { RuntimeDeck, WordProgress, LevelProgress } from "../../shared/schemas";

export type LearningDeck = Pick<RuntimeDeck, "id" | "fingerprint"> & {
  words: ReadonlyArray<Pick<RuntimeDeck["words"][number], "id">>;
};

export type SpawnTier = "repair" | "learning" | "checkpoint" | "fallback";

export type SpawnResult =
  | {
      status: "spawned";
      level: LevelProgress;
      wordId: string;
      spawnOrdinal: number;
      cooldown: number;
      tier: SpawnTier;
    }
  | {
      status: "noEligibleWord";
      level: LevelProgress;
      spawnOrdinal: number;
      diagnostics: {
        activeCount: number;
        introducedCount: number;
        coolingCount: number;
      };
    };

export type LearningTransition = "levelCompleted" | "sectorCompleted" | "sectorMasteryRegressed";

export type ReconciliationReport = {
  retained: number;
  added: number;
  removed: number;
};

export type ReconciliationResult = {
  level: LevelProgress;
  report: ReconciliationReport;
};

export type ProgressUpdate = {
  progress: WordProgress;
  weightDelta: number;
  becameMastered: boolean;
  relapsed: boolean;
  struggled: boolean;
  repeatAfterPhrases: number;
};
