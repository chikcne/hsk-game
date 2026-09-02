import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, WordProgress } from "../../shared/schemas";
import type { EncounterOutcome } from "../session/types";
import { refillCurriculum } from "./curriculum";
import { FIRST_CORRECT_APPEARANCE_WEIGHT, ZERO_MASTERY_APPEARANCE_WEIGHT } from "./constants";
import { isLiveMastered } from "./progress";
import type { LearningDeck, LearningTransition, ProgressUpdate } from "./types";

function finiteDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative duration`);
  return value;
}

function outcomeThinkingMs(outcome: EncounterOutcome): number {
  switch (outcome.kind) {
    case "correct": return finiteDuration(outcome.pinyinMs, "pinyinMs") + finiteDuration(outcome.meaningMs, "meaningMs");
    case "wrongPinyin": return finiteDuration(outcome.pinyinMs, "pinyinMs");
    case "wrongMeaning": return finiteDuration(outcome.pinyinMs, "pinyinMs") + finiteDuration(outcome.meaningMs, "meaningMs");
    case "landed": return outcome.activeThinkingMs === null ? 0 : finiteDuration(outcome.activeThinkingMs, "activeThinkingMs");
  }
}

export function outcomePinyinMs(outcome: EncounterOutcome): number | null {
  return outcome.kind === "landed" ? null : finiteDuration(outcome.pinyinMs, "pinyinMs");
}

function isoTimestamp(now: string | Date): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return date.toISOString();
}

/** Kept as a small public helper: mastery now uses pinyin time only. */
export function correctWeightDecrease(
  pinyinMs: number,
  settings: Pick<DifficultySettings, "struggleThresholdMs" | "masteryCorrectDecrease"> = DEFAULT_SETTINGS,
): number {
  finiteDuration(pinyinMs, "pinyinMs");
  return pinyinMs <= settings.struggleThresholdMs ? settings.masteryCorrectDecrease : 0;
}

/** Number of intervening phrases before a correct card is due. With defaults a
 * ten-second pinyin response is due ten phrases later. */
export function correctRepeatInterval(
  pinyinMs: number,
  settings: Pick<DifficultySettings, "correctRepeatBasePhrases" | "pinyinSecondsPerPhrase" | "minimumCorrectRepeatPhrases"> = DEFAULT_SETTINGS,
): number {
  finiteDuration(pinyinMs, "pinyinMs");
  return Math.max(
    settings.minimumCorrectRepeatPhrases,
    Math.round(settings.correctRepeatBasePhrases - (pinyinMs / 1000) * settings.pinyinSecondsPerPhrase),
  );
}

/** Applies one regular-level result. Meaning response time is recorded for
 * score/statistics, but never enters mastery or repeat timing. */
export function applyOutcome(
  progress: WordProgress,
  outcome: EncounterOutcome,
  now: string | Date,
  settings: DifficultySettings = DEFAULT_SETTINGS,
): ProgressUpdate {
  const thinkingMs = outcomeThinkingMs(outcome);
  const pinyinMs = outcomePinyinMs(outcome);
  const oldWeight = progress.appearanceWeight;
  const slowCorrect = outcome.kind === "correct" && pinyinMs !== null && pinyinMs > settings.struggleThresholdMs;
  let appearanceWeight: number;
  let reinforcementRemaining: number;

  if (outcome.kind === "correct" && oldWeight === ZERO_MASTERY_APPEARANCE_WEIGHT) {
    // A new word graduates immediately to 80%, even when recall was slow.
    appearanceWeight = FIRST_CORRECT_APPEARANCE_WEIGHT;
    reinforcementRemaining = slowCorrect
      ? settings.repairRepetitions
      : Math.max(0, progress.reinforcementRemaining - 1);
  } else if (outcome.kind === "correct" && !slowCorrect) {
    appearanceWeight = Math.max(1, oldWeight - settings.masteryCorrectDecrease);
    reinforcementRemaining = Math.max(0, progress.reinforcementRemaining - 1);
  } else if (outcome.kind === "correct") {
    appearanceWeight = Math.min(100, oldWeight + settings.masteryStruggleIncrease);
    reinforcementRemaining = settings.repairRepetitions;
  } else {
    appearanceWeight = Math.min(100, oldWeight + settings.masteryMistakeIncrease);
    reinforcementRemaining = settings.repairRepetitions;
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
      ? progress.fastestCorrectMs === null ? thinkingMs : Math.min(progress.fastestCorrectMs, thinkingMs)
      : progress.fastestCorrectMs,
    totalPinyinMs: progress.totalPinyinMs + (pinyinMs ?? 0),
    fastestPinyinMs: pinyinMs === null
      ? progress.fastestPinyinMs
      : progress.fastestPinyinMs === null ? pinyinMs : Math.min(progress.fastestPinyinMs, pinyinMs),
    lastPinyinMs: pinyinMs,
    lastOutcome: outcome.kind,
    lastSeenAt: isoTimestamp(now),
    reinforcementRemaining,
  };
  const repeatAfterPhrases = outcome.kind === "correct"
    ? correctRepeatInterval(outcome.pinyinMs, settings)
    : settings.mistakeRepeatPhrases;

  return {
    progress: updated,
    weightDelta: appearanceWeight - oldWeight,
    becameMastered: oldWeight > 1 && appearanceWeight === 1,
    relapsed: oldWeight === 1 && appearanceWeight > 1,
    struggled: slowCorrect || outcome.kind !== "correct",
    repeatAfterPhrases,
  };
}

export type LevelOutcomeResult = {
  level: LevelProgress;
  progress: WordProgress;
  transitions: LearningTransition[];
  struggled: boolean;
  repeatAfterPhrases: number;
};

/** Applies mastery, rolling curriculum refill, and grade completion as one
 * immutable operation. */
export function applyOutcomeToLevel(
  level: LevelProgress,
  deck: LearningDeck,
  wordId: string,
  outcome: EncounterOutcome,
  now: string | Date,
  settings: DifficultySettings = DEFAULT_SETTINGS,
): LevelOutcomeResult {
  const previous = level.words[wordId];
  if (previous === undefined) throw new Error(`Unknown word ID: ${wordId}`);
  const wasLiveMastered = isLiveMastered(level);
  const update = applyOutcome(previous, outcome, now, settings);
  const progress = {
    ...update.progress,
    nextEligibleSpawn: level.nextSpawnOrdinal + update.repeatAfterPhrases,
  };

  const active = new Set(level.activeLearningWordIds);
  if (progress.appearanceWeight === 1) active.delete(wordId);
  else if (previous.introducedAtOrdinal !== null) active.add(wordId);

  let next: LevelProgress = refillCurriculum({
    ...level,
    words: { ...level.words, [wordId]: progress },
    activeLearningWordIds: [...active],
    reviewedOlderWordIds: [],
  }, deck);

  const transitions: LearningTransition[] = [];
  const nextLevelIndex = Math.max(0, Math.floor(next.curriculumCursor / settings.levelSize) - 1);
  if (nextLevelIndex > level.currentLevelIndex) {
    next = { ...next, currentLevelIndex: nextLevelIndex };
    transitions.push("levelCompleted");
  }

  if (isLiveMastered(next) && !wasLiveMastered) {
    if (next.firstCompletedAt === null) next = { ...next, firstCompletedAt: isoTimestamp(now) };
    transitions.push("gradeCompleted");
  }
  if (level.firstCompletedAt !== null && wasLiveMastered && !isLiveMastered(next)) transitions.push("gradeMasteryRegressed");
  return { level: next, progress, transitions, struggled: update.struggled, repeatAfterPhrases: update.repeatAfterPhrases };
}
