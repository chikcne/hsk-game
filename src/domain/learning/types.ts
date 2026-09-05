import type { LevelProgress, RuntimeDeck } from "../../shared/schemas";
import type { RandomState } from "../random";

export type LearningDeck = Pick<RuntimeDeck, "id" | "fingerprint" | "curriculum"> & {
  words: ReadonlyArray<Pick<RuntimeDeck["words"][number], "id">>;
};

/** Partial because a save may never have touched every grade. */
export type LevelsMap = Partial<Record<string, LevelProgress>>;

/** Global spawn counter + RNG state shared by every mode, stored in the save
 * root. Review battles advance it; Learn sessions record introduction
 * ordinals against it. */
export type SchedulerSnapshot = {
  spawnOrdinal: number;
  schedulerRng: RandomState;
};

export type ReconciliationReport = {
  retained: number;
  added: number;
  removed: number;
};

export type ReconciliationResult = {
  level: LevelProgress;
  report: ReconciliationReport;
};
