const MIN_PERFORMANCE_MULTIPLIER = 0.7;
const MAX_PERFORMANCE_MULTIPLIER = 1.5;
const PERFORMANCE_SMOOTHING = 0.3;
/** Total thinking time measured against this reference: at it, pressure is
 * neutral; half of it pushes toward fast; misses always push toward slow. */
const PERFORMANCE_REFERENCE_MS = 10_000;
const MAX_NEW_WORD_SPAWN_DELAY_PERCENT = 160;
const MIN_MASTERED_WORD_SPAWN_DELAY_PERCENT = 40;

export const EMPTY_BATTLEFIELD_SPAWN_DELAY_MS = 500;
/** Pre-write budget on an empty battlefield: the next word must become
 * playable within two seconds of the board clearing, so a longer phrase
 * writes faster rather than delaying gameplay past natural pacing. */
export const EMPTY_FIELD_MAX_WRITE_MS = 2_000;
const MAX_WRITE_SPEEDUP = 8;

/** Schedules a pre-spawn write for a word prepared onto an empty battlefield.
 * Short phrases keep their natural cadence; long ones compress their stroke
 * animation (bounded by MAX_WRITE_SPEEDUP) so spawn never waits out the full
 * unadjusted lead. The caller still enforces `spawnDueMs` as the floor. */
export function emptyFieldWriteSchedule(
  preparedAtMs: number,
  spawnDueMs: number,
  fullLeadMs: number,
): { spawnAtMs: number; writeMs: number; writeSpeed: number } {
  const writeMs = Math.max(1, Math.min(fullLeadMs, EMPTY_FIELD_MAX_WRITE_MS));
  const writeSpeed = fullLeadMs > 0
    ? Math.min(MAX_WRITE_SPEEDUP, Math.max(1, fullLeadMs / writeMs))
    : 1;
  return { spawnAtMs: Math.max(spawnDueMs, preparedAtMs + writeMs), writeMs, writeSpeed };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Updates arcade pressure from the latest result. Fast correct answers push
 * toward 1.5x, an answer at the reference duration is neutral, and mistakes or
 * very slow answers push toward 0.7x. Smoothing keeps one result from causing a
 * jarring speed change.
 */
export function nextPerformanceMultiplier(
  current: number,
  correct: boolean,
  thinkingMs: number,
): number {
  const safeCurrent = clamp(Number.isFinite(current) ? current : 1, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
  const target = correct
    ? clamp(1.5 - 0.5 * (Math.max(0, thinkingMs) / PERFORMANCE_REFERENCE_MS), MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER)
    : MIN_PERFORMANCE_MULTIPLIER;
  return clamp(safeCurrent + (target - safeCurrent) * PERFORMANCE_SMOOTHING, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
}

/**
 * Scales the base spawn timer according to the mastery of the word that just
 * spawned. New words leave 160% of the base interval before the next word,
 * 50%-mastered words leave 100%, and mastered words leave 40%.
 */
export function masteryAdjustedSpawnDelayMs(configuredIntervalMs: number, masteryLevel: number): number {
  if (!Number.isFinite(masteryLevel)) throw new RangeError("masteryLevel must be finite");
  const normalizedMastery = clamp(masteryLevel, 0, 100) / 100;
  const delayPercent = MAX_NEW_WORD_SPAWN_DELAY_PERCENT
    + normalizedMastery * (MIN_MASTERED_WORD_SPAWN_DELAY_PERCENT - MAX_NEW_WORD_SPAWN_DELAY_PERCENT);
  return configuredIntervalMs * delayPercent / 100;
}

/** Strong performance shortens the mastery-adjusted timer; weak performance extends it. */
export function performanceAdjustedSpawnDelayMs(
  configuredIntervalMs: number,
  performanceMultiplier: number,
  hasActiveEnemies: boolean,
  previousWordMastery = 50,
): number {
  const multiplier = clamp(performanceMultiplier, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
  const adjusted = masteryAdjustedSpawnDelayMs(configuredIntervalMs, previousWordMastery) / multiplier;
  return hasActiveEnemies ? adjusted : Math.min(adjusted, EMPTY_BATTLEFIELD_SPAWN_DELAY_MS);
}

/** Natural cadence for a pre-spawn write of `fullLeadMs` when the battlefield
 * is not empty: gameplay pacing never compresses the animation. */
export function gameplayWriteSchedule(
  preparedAtMs: number,
  spawnDueMs: number,
  fullLeadMs: number,
): { spawnAtMs: number; writeMs: number; writeSpeed: number } {
  return { spawnAtMs: Math.max(spawnDueMs, preparedAtMs + fullLeadMs), writeMs: fullLeadMs, writeSpeed: 1 };
}
