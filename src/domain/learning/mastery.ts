import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, RecallGrade, WordProgress } from "../../shared/schemas";
import type { EncounterOutcome } from "../session/types";
import { refillCurriculum } from "./curriculum";
import {
  EASY_DIFFICULTY_RELIEF,
  EASY_GROWTH_DIFFICULTY_SLOPE,
  EASY_GRADUATION_STABILITY_DAYS,
  EASY_INTERVAL_MULTIPLIER,
  EASY_MS_PER_CHAR,
  EASY_STABILITY_GROWTH,
  GOOD_DIFFICULTY_RELIEF,
  GOOD_GROWTH_DIFFICULTY_SLOPE,
  GOOD_STABILITY_GROWTH,
  HARD_GROWTH_DIFFICULTY_SLOPE,
  HARD_INTERVAL_MULTIPLIER,
  HARD_MIN_INTERVENING_WORDS,
  HARD_STABILITY_GROWTH,
  INITIAL_STABILITY_DAYS,
  LAPSE_DIFFICULTY_PENALTY,
  LAPSE_STABILITY_FACTOR,
  LEARNING_STEPS,
  MASTERY_BY_STEP,
  MASTERY_SATURATION_DAYS,
  MAX_DIFFICULTY,
  MAX_STABILITY_DAYS,
  MIN_DIFFICULTY,
  MIN_STABILITY_DAYS,
  RELEARNING_STEPS,
  STRUGGLE_MS_PER_CHAR,
} from "./constants";
import { isLiveMastered } from "./progress";
import type { LearningDeck, LearningTransition, OutcomeOptions, ProgressUpdate } from "./types";

const DAY_MS = 86_400_000;

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

function dueAtFrom(now: string | Date, stabilityDays: number): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  return new Date(date.getTime() + Math.max(1, Math.round(stabilityDays)) * DAY_MS).toISOString();
}

function clampDifficulty(value: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, value));
}

/** Infers one of four continuous grades from an encounter. Wrong pinyin,
 * wrong meaning, landing, and pinyin autocomplete all grade as Again. Correct
 * answers are graded by pinyin latency normalised per canonical character, so
 * a response just past the struggle boundary changes almost nothing. */
export function inferRecallGrade(outcome: EncounterOutcome, pinyinCharLength = 1): RecallGrade {
  if (outcome.kind !== "correct" || outcome.autocompleted === true) return "again";
  const normalized = finiteDuration(outcome.pinyinMs, "pinyinMs") / Math.max(1, pinyinCharLength);
  if (normalized <= EASY_MS_PER_CHAR) return "easy";
  if (normalized <= STRUGGLE_MS_PER_CHAR) return "good";
  return "hard";
}

/** Smooth player-facing mastery derived from the learning stage and long-term
 * stability. New words read 0%, learning steps 25/50/75%, and graduated words
 * 80-100% saturating with stability. */
export function displayedMastery(progress: Pick<WordProgress, "phase" | "stepIndex" | "stability">): number {
  switch (progress.phase) {
    case "new": return 0;
    case "learning":
    case "relearning":
      return MASTERY_BY_STEP[Math.min(progress.stepIndex, MASTERY_BY_STEP.length - 1)]!;
    case "review": {
      const stability = Math.max(0, progress.stability);
      return Math.min(100, Math.round(80 + 20 * stability / (stability + MASTERY_SATURATION_DAYS)));
    }
  }
}

function stepsFor(phase: WordProgress["phase"]): readonly number[] {
  return phase === "relearning" ? RELEARNING_STEPS : LEARNING_STEPS;
}

/** Applies one regular-level result as a spaced-repetition grade. Meaning
 * response time is recorded for score/statistics, but never enters grading:
 * pinyin latency decides Easy/Good/Hard, and everything wrong autocompleted,
 * missed, or landed grades as Again.
 *
 * `dueOriginOrdinal` must be the level's next spawn ordinal at outcome time;
 * step due points are expressed as that ordinal plus the step interval, so a
 * word tested at ordinal `s` with interval `n` is next due at `s + n + 1`
 * after exactly `n` intervening words. */
export function applyOutcome(
  progress: WordProgress,
  outcome: EncounterOutcome,
  now: string | Date,
  dueOriginOrdinal: number,
  options: OutcomeOptions = {},
): ProgressUpdate {
  const { graded = true, pinyinCharLength = 1 } = options;
  const grade = inferRecallGrade(outcome, pinyinCharLength);
  const thinkingMs = outcomeThinkingMs(outcome);
  const pinyinMs = outcomePinyinMs(outcome);
  const correct = outcome.kind === "correct";
  const masteryBefore = displayedMastery(progress);

  const counters = {
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
  };

  let next: WordProgress = { ...progress, ...counters };
  let becameMastered = false;
  let relapsed = false;
  let dueInWords: number | null = null;
  let dueInDays: number | null = null;

  if (graded) {
    const steps = stepsFor(progress.phase);
    const origin = Math.max(0, Math.trunc(dueOriginOrdinal));
    switch (progress.phase) {
      case "new": {
        // The first test starts the learning steps: Good begins the 3-word
        // stage, Easy skips ahead to the stretched second stage.
        if (grade === "again") {
          next = {
            ...next, phase: "learning", stepIndex: 0, dueOrdinal: origin + steps[0]!, dueAt: null,
            lapses: progress.lapses + 1, lastGrade: grade,
          };
          dueInWords = steps[0]!;
        } else if (grade === "hard") {
          const interval = Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[0]! * HARD_INTERVAL_MULTIPLIER));
          next = { ...next, phase: "learning", stepIndex: 0, dueOrdinal: origin + interval, dueAt: null, lastGrade: grade };
          dueInWords = interval;
        } else if (grade === "easy") {
          const interval = Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[1]! * EASY_INTERVAL_MULTIPLIER));
          next = { ...next, phase: "learning", stepIndex: 1, dueOrdinal: origin + interval, dueAt: null, lastGrade: grade };
          dueInWords = interval;
        } else {
          next = { ...next, phase: "learning", stepIndex: 0, dueOrdinal: origin + steps[0]!, dueAt: null, lastGrade: grade };
          dueInWords = steps[0]!;
        }
        break;
      }
      case "learning":
      case "relearning": {
        if (grade === "again") {
          // Restart the phase's steps from the beginning.
          next = {
            ...next, stepIndex: 0, dueOrdinal: origin + steps[0]!, dueAt: null,
            lapses: progress.lapses + 1,
            difficulty: clampDifficulty(progress.difficulty + LAPSE_DIFFICULTY_PENALTY),
            lastGrade: grade,
          };
          dueInWords = steps[0]!;
        } else if (grade === "hard") {
          // Stay at the current stage with a shortened interval.
          const interval = Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[progress.stepIndex]! * HARD_INTERVAL_MULTIPLIER));
          next = { ...next, dueOrdinal: origin + interval, lastGrade: grade };
          dueInWords = interval;
        } else if (progress.stepIndex + 1 < steps.length) {
          const advanced = progress.stepIndex + 1;
          const interval = grade === "easy"
            ? Math.max(HARD_MIN_INTERVENING_WORDS, Math.round(steps[advanced]! * EASY_INTERVAL_MULTIPLIER))
            : steps[advanced]!;
          next = { ...next, stepIndex: advanced, dueOrdinal: origin + interval, lastGrade: grade };
          dueInWords = interval;
        } else {
          // Passing the final step graduates (or re-graduates) the word.
          const stability = progress.phase === "relearning"
            ? progress.stability
            : grade === "easy" ? EASY_GRADUATION_STABILITY_DAYS : INITIAL_STABILITY_DAYS;
          next = {
            ...next, phase: "review", stepIndex: 0, dueOrdinal: null,
            stability: Math.min(MAX_STABILITY_DAYS, stability),
            difficulty: clampDifficulty(progress.difficulty - (grade === "easy" ? EASY_DIFFICULTY_RELIEF : GOOD_DIFFICULTY_RELIEF)),
            lastGrade: grade,
            dueAt: dueAtFrom(now, stability),
          };
          becameMastered = true;
          dueInDays = Math.max(1, Math.round(stability));
        }
        break;
      }
      case "review": {
        if (grade === "again") {
          // A lapse sends the graduated word through the relearning steps.
          const stability = Math.max(MIN_STABILITY_DAYS, progress.stability * LAPSE_STABILITY_FACTOR);
          next = {
            ...next, phase: "relearning", stepIndex: 0, dueOrdinal: origin + RELEARNING_STEPS[0]!, dueAt: null,
            stability, lapses: progress.lapses + 1,
            difficulty: clampDifficulty(progress.difficulty + LAPSE_DIFFICULTY_PENALTY),
            lastGrade: grade,
          };
          relapsed = true;
          dueInWords = RELEARNING_STEPS[0]!;
        } else {
          const difficulty = progress.difficulty;
          const growth = grade === "hard"
            ? HARD_STABILITY_GROWTH - HARD_GROWTH_DIFFICULTY_SLOPE * difficulty
            : grade === "easy"
              ? EASY_STABILITY_GROWTH - EASY_GROWTH_DIFFICULTY_SLOPE * difficulty
              : GOOD_STABILITY_GROWTH - GOOD_GROWTH_DIFFICULTY_SLOPE * difficulty;
          const stability = Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, progress.stability * growth));
          next = {
            ...next,
            stability,
            difficulty: clampDifficulty(difficulty - (grade === "easy" ? EASY_DIFFICULTY_RELIEF : grade === "hard" ? 0 : GOOD_DIFFICULTY_RELIEF)),
            lastGrade: grade,
            dueAt: dueAtFrom(now, stability),
          };
          dueInDays = Math.max(1, Math.round(stability));
        }
        break;
      }
    }
  }

  const masteryAfter = displayedMastery(next);
  return {
    progress: next,
    grade,
    graded,
    masteryBefore,
    masteryAfter,
    becameMastered,
    relapsed,
    struggled: grade === "again" || grade === "hard",
    dueInWords,
    dueInDays,
  };
}

export type LevelOutcomeResult = {
  level: LevelProgress;
  progress: WordProgress;
  transitions: LearningTransition[];
  grade: RecallGrade;
  struggled: boolean;
  dueInWords: number | null;
  dueInDays: number | null;
};

/** Applies mastery, rolling curriculum refill, and grade completion as one
 * immutable operation. The word's hard spacing floor is owned by its spawn
 * reservation and is intentionally left untouched here. */
export function applyOutcomeToLevel(
  level: LevelProgress,
  deck: LearningDeck,
  wordId: string,
  outcome: EncounterOutcome,
  now: string | Date,
  settings: Pick<DifficultySettings, "levelSize"> = DEFAULT_SETTINGS,
  options: OutcomeOptions = {},
): LevelOutcomeResult {
  const previous = level.words[wordId];
  if (previous === undefined) throw new Error(`Unknown word ID: ${wordId}`);
  const wasLiveMastered = isLiveMastered(level);
  const update = applyOutcome(previous, outcome, now, level.nextSpawnOrdinal, options);
  const progress = update.progress;

  const active = new Set(level.activeLearningWordIds);
  if (progress.phase === "review") active.delete(wordId);
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
  return {
    level: next,
    progress,
    transitions,
    grade: update.grade,
    struggled: update.struggled,
    dueInWords: update.dueInWords,
    dueInDays: update.dueInDays,
  };
}
