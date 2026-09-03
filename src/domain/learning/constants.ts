/** Hard minimum number of other words that must spawn between two encounters
 * of the same word. Every spawn reserves this spacing up front and no due
 * point may land earlier, so cooldowns are always actually guaranteed. */
export const HARD_MIN_INTERVENING_WORDS = 2;

/** Graded learning steps, measured in intervening words. A Good answer
 * advances one step; passing the final step graduates the word into
 * long-term review. A word therefore needs at least four spaced successful
 * recalls before it is mastered. */
export const LEARNING_STEPS: readonly number[] = [3, 10, 30];

/** Steps a graduated word repeats after a lapse (Again) before it returns to
 * long-term review. */
export const RELEARNING_STEPS: readonly number[] = [2, 6, 18];

/** Easy answers advance a stage and stretch the next interval; Hard answers
 * stay at the current stage with a shortened interval. */
export const EASY_INTERVAL_MULTIPLIER = 1.5;
export const HARD_INTERVAL_MULTIPLIER = 0.5;

/** Grade latency boundaries, in milliseconds per canonical pinyin character.
 * Normalising by length removes the behavioural cliff of a single absolute
 * threshold: 8,001 ms is no longer punished where 8,000 ms was rewarded. */
export const EASY_MS_PER_CHAR = 1600;
export const STRUGGLE_MS_PER_CHAR = 4000;

/** Stability (in days) when a word first graduates, and its bounds. */
export const INITIAL_STABILITY_DAYS = 1;
export const EASY_GRADUATION_STABILITY_DAYS = 1.5;
export const MIN_STABILITY_DAYS = 0.3;
export const MAX_STABILITY_DAYS = 365;
export const INITIAL_DIFFICULTY = 5;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;

/** A lapse (Again) collapses stability and raises difficulty. */
export const LAPSE_STABILITY_FACTOR = 0.25;
export const LAPSE_DIFFICULTY_PENALTY = 1;

/** Stability growth for graduated correct answers, reduced by difficulty:
 * Good:   stability *= 2.5 - 0.15 * difficulty
 * Hard:   stability *= 1.2 - 0.05 * difficulty (roughly flat or shorter)
 * Easy:   stability *= 3.0 - 0.15 * difficulty */
export const GOOD_STABILITY_GROWTH = 2.5;
export const HARD_STABILITY_GROWTH = 1.2;
export const EASY_STABILITY_GROWTH = 3.0;
export const GOOD_GROWTH_DIFFICULTY_SLOPE = 0.15;
export const HARD_GROWTH_DIFFICULTY_SLOPE = 0.05;
export const EASY_GROWTH_DIFFICULTY_SLOPE = 0.15;
export const GOOD_DIFFICULTY_RELIEF = 0.1;
export const EASY_DIFFICULTY_RELIEF = 0.3;

/** Displayed mastery of graduated words saturates toward 100% as stability
 * grows: mastery = 80 + 20 * stability / (stability + MASTERY_SATURATION_DAYS). */
export const MASTERY_SATURATION_DAYS = 7;

/** Player-facing mastery for step-based phases, by step index. */
export const MASTERY_BY_STEP: readonly number[] = [25, 50, 75];

/** Target shares of graded spawns: due review/relearning, learning steps, and
 * brand-new words. Empty buckets redistribute their share. */
export const SPAWN_MIX = { due: 0.5, learning: 0.3, new: 0.2 } as const;

export const MAX_ELIGIBLE_AGE_BOOST = 1.5;
export const ANTI_STARVATION_AGE = 150;
