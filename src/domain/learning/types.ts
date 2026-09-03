import type { LevelProgress, RecallGrade, RuntimeDeck, WordProgress } from "../../shared/schemas";

export type LearningDeck = Pick<RuntimeDeck, "id" | "fingerprint"> & {
  words: ReadonlyArray<Pick<RuntimeDeck["words"][number], "id">>;
};

export type SpawnTier = "due" | "learning" | "new" | "practice";

export type SpawnResult =
  | {
      status: "spawned";
      level: LevelProgress;
      wordId: string;
      spawnOrdinal: number;
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

export type LearningTransition = "levelCompleted" | "gradeCompleted" | "gradeMasteryRegressed";

export type ReconciliationReport = {
  retained: number;
  added: number;
  removed: number;
};

export type ReconciliationResult = {
  level: LevelProgress;
  report: ReconciliationReport;
};

export type OutcomeOptions = {
  /** Ungraded practice never changes the schedule; counters only. */
  graded?: boolean;
  /** Canonical pinyin character count used to normalise answer latency. */
  pinyinCharLength?: number;
};

export type ProgressUpdate = {
  progress: WordProgress;
  grade: RecallGrade;
  graded: boolean;
  masteryBefore: number;
  masteryAfter: number;
  /** The word entered long-term review (graduated or re-graduated). */
  becameMastered: boolean;
  /** A graduated word lapsed into relearning. */
  relapsed: boolean;
  struggled: boolean;
  /** Words until the next scheduled test, for step-based phases. */
  dueInWords: number | null;
  /** Days until the next long-term review, for graduated words. */
  dueInDays: number | null;
};
