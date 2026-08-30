import type { LevelProgress, WordProgress } from "../../shared/schemas";
import type { EncounterOutcome } from "../session/types";
import { refillCurriculum } from "./curriculum";
import { isLiveMastered } from "./progress";
import type { LearningDeck, LearningTransition, ProgressUpdate } from "./types";

function finiteDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite nonnegative duration`);
  }
  return value;
}

function outcomeThinkingMs(outcome: EncounterOutcome): number {
  switch (outcome.kind) {
    case "correct":
      return finiteDuration(outcome.pinyinMs, "pinyinMs") + finiteDuration(outcome.meaningMs, "meaningMs");
    case "wrongPinyin":
      return finiteDuration(outcome.pinyinMs, "pinyinMs");
    case "wrongMeaning":
      return finiteDuration(outcome.pinyinMs, "pinyinMs") + finiteDuration(outcome.meaningMs, "meaningMs");
    case "landed":
      return outcome.activeThinkingMs === null
        ? 0
        : finiteDuration(outcome.activeThinkingMs, "activeThinkingMs");
  }
}

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

export function correctWeightDecrease(thinkingMs: number): number {
  finiteDuration(thinkingMs, "thinkingMs");
  const speedScore = Math.min(1, Math.max(0, (12_000 - thinkingMs) / 9_500));
  return 4 + Math.round(12 * speedScore);
}

/** Applies one resolved encounter to a word, without mutating the source record. */
export function applyOutcome(
  progress: WordProgress,
  outcome: EncounterOutcome,
  now: string | Date,
): ProgressUpdate {
  const thinkingMs = outcomeThinkingMs(outcome);
  const oldWeight = progress.appearanceWeight;
  let appearanceWeight: number;
  let reinforcementRemaining: number;

  switch (outcome.kind) {
    case "correct":
      appearanceWeight = Math.max(1, oldWeight - correctWeightDecrease(thinkingMs));
      reinforcementRemaining = Math.max(0, progress.reinforcementRemaining - 1);
      break;
    case "wrongPinyin":
    case "wrongMeaning":
      appearanceWeight = Math.min(100, oldWeight + 30);
      reinforcementRemaining = 3;
      break;
    case "landed":
      appearanceWeight = Math.min(100, oldWeight + 35);
      reinforcementRemaining = 3;
      break;
  }
  if (appearanceWeight === 1) reinforcementRemaining = 0;

  const correct = outcome.kind === "correct";
  const updated: WordProgress = {
    ...progress,
    appearanceWeight,
    attempts: progress.attempts + 1,
    completeCorrect: progress.completeCorrect + (correct ? 1 : 0),
    wrongPinyin: progress.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
    wrongMeaning: progress.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
    landed: progress.landed + (outcome.kind === "landed" ? 1 : 0),
    totalThinkingMs: progress.totalThinkingMs + thinkingMs,
    fastestCorrectMs: correct
      ? progress.fastestCorrectMs === null
        ? thinkingMs
        : Math.min(progress.fastestCorrectMs, thinkingMs)
      : progress.fastestCorrectMs,
    lastOutcome: outcome.kind,
    lastSeenAt: isoTimestamp(now),
    reinforcementRemaining: reinforcementRemaining as 0 | 1 | 2 | 3,
  };

  return {
    progress: updated,
    weightDelta: appearanceWeight - oldWeight,
    becameMastered: oldWeight > 1 && appearanceWeight === 1,
    relapsed: oldWeight === 1 && appearanceWeight > 1,
  };
}

export type LevelOutcomeResult = {
  level: LevelProgress;
  progress: WordProgress;
  transitions: LearningTransition[];
};

/** Applies mastery, curriculum, relapse, and completion semantics as one immutable operation. */
export function applyOutcomeToLevel(
  level: LevelProgress,
  deck: LearningDeck,
  wordId: string,
  outcome: EncounterOutcome,
  now: string | Date,
): LevelOutcomeResult {
  const previous = level.words[wordId];
  if (previous === undefined) throw new Error(`Unknown word ID: ${wordId}`);
  const wasLiveMastered = isLiveMastered(level);
  const update = applyOutcome(previous, outcome, now);

  let active = level.activeLearningWordIds;
  if (update.progress.appearanceWeight === 1) {
    active = active.filter((id) => id !== wordId);
  } else if (!active.includes(wordId)) {
    // A mastered fallback lapse rejoins without evicting one of the 30 weak words.
    active = [...active, wordId];
  }

  let next: LevelProgress = {
    ...level,
    words: { ...level.words, [wordId]: update.progress },
    activeLearningWordIds: active,
  };
  next = refillCurriculum(next, deck);

  const transitions: LearningTransition[] = [];
  const liveMastered = isLiveMastered(next);
  if (liveMastered && !wasLiveMastered) {
    if (next.firstCompletedAt === null) {
      next = { ...next, firstCompletedAt: isoTimestamp(now) };
    }
    transitions.push("levelCompleted");
  } else if (!liveMastered && wasLiveMastered) {
    transitions.push("levelMasteryRegressed");
  }

  return { level: next, progress: update.progress, transitions };
}
