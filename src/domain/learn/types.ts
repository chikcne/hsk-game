import type { ComponentMemory, LearnSession, LevelProgress, SaveFile } from "../../shared/schemas";
import type { MemoryRating } from "../memory";

export type { LearnSession };

/** Explicit self-rating applied to a word's single card in Learn Mode. */
export type LearnRating = MemoryRating;

export type NextLearnCard =
  | { status: "card"; wordId: string; /** True when the card is due right now (false = learn-ahead). */ dueNow: boolean }
  | { status: "complete" };

export type CreateLearnSessionOptions = {
  /** settings.levelSize: the per-session cap on brand-new curriculum words. */
  newCardLimit: number;
  /** Global spawn ordinal recorded on newly introduced words. */
  spawnOrdinal: number;
};

export type CreateLearnSessionResult = {
  level: LevelProgress;
  session: LearnSession;
};

export type LearnRatingApplication = {
  /** The full next save snapshot (levels, acquiredWords, learnSessions). */
  save: SaveFile;
  /** The card state after the rating. */
  card: ComponentMemory;
  /** True when this rating moved the word into `acquired_words` for the
   * first time (card reached Review and the key was not present). */
  newlyAcquired: boolean;
  /** True when the rated word leaves the active session (card in Review). */
  wordCompleted: boolean;
  /** True when the last remaining member completed and the active session
   * was cleared for this grade. */
  sessionCompleted: boolean;
};
