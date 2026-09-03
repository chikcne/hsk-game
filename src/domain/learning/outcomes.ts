import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { applyWordOutcome, isGraduated, type WordOutcomeOptions, type WordRatings } from "../memory";
import type { EncounterOutcome } from "../session/types";
import type { LearningTransition, LevelsMap } from "./types";

export type LevelsOutcomeResult = {
  levels: LevelsMap;
  progress: WordProgress;
  transitions: LearningTransition[];
  ratings: WordRatings;
  struggled: boolean;
  cooldownPhrases: number;
  newlyGraduated: boolean;
};

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

/**
 * Applies one encounter to the word's memory and grade bookkeeping in one
 * immutable step. The word's microspacing cooldown restarts from the current
 * global ordinal, and grade completion/regression transitions derive from
 * both-component graduation across the level's complete word record.
 *
 * Works for both regular play and cross-grade review: the only geometry
 * needed is which grade owns the word, which the caller supplies.
 */
export function applyOutcomeToLevels(
  levels: LevelsMap,
  deckId: string,
  wordId: string,
  outcome: EncounterOutcome,
  now: string | Date,
  currentOrdinal: number,
  options: WordOutcomeOptions,
): LevelsOutcomeResult {
  const level = levels[deckId];
  if (!level) throw new Error(`Missing level progress for ${deckId}`);
  const previous = level.words[wordId];
  if (!previous) throw new Error(`Unknown word ID: ${wordId}`);

  const result = applyWordOutcome(previous, outcome, now, options);
  const progress: WordProgress = { ...result.progress, nextEligibleSpawn: currentOrdinal + result.cooldownPhrases };
  let nextLevel: LevelProgress = { ...level, words: { ...level.words, [wordId]: progress } };

  const allGraduated = (active: WordProgress) =>
    Object.entries(nextLevel.words).every(([id, word]) => isGraduated(id === wordId ? active : word));
  const wasGradeComplete = allGraduated(previous);
  const isGradeComplete = allGraduated(progress);

  const transitions: LearningTransition[] = [];
  if (isGradeComplete && !wasGradeComplete) {
    if (nextLevel.firstCompletedAt === null) nextLevel = { ...nextLevel, firstCompletedAt: isoTimestamp(now) };
    transitions.push("gradeCompleted");
  }
  if (wasGradeComplete && !isGradeComplete && level.firstCompletedAt !== null) transitions.push("gradeMasteryRegressed");

  return {
    levels: { ...levels, [deckId]: nextLevel },
    progress,
    transitions,
    ratings: result.ratings,
    struggled: result.struggled,
    cooldownPhrases: result.cooldownPhrases,
    newlyGraduated: result.graduatedAfter && !result.graduatedBefore,
  };
}
