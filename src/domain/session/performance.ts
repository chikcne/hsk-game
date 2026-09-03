const MIN_PERFORMANCE_MULTIPLIER = 0.7;
const MAX_PERFORMANCE_MULTIPLIER = 1.5;
const PERFORMANCE_SMOOTHING = 0.3;

export const EMPTY_BATTLEFIELD_SPAWN_DELAY_MS = 500;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Updates arcade pressure from the latest result. Fast correct answers push
 * toward 1.5x, an answer at the recall window is neutral, and mistakes or
 * very slow answers push toward 0.7x. Smoothing keeps one result from causing
 * a jarring speed change. Player performance — never word mastery — drives
 * spawn pacing.
 */
export function nextPerformanceMultiplier(
  current: number,
  correct: boolean,
  thinkingMs: number,
  recallWindowMs: number,
): number {
  const safeCurrent = clamp(Number.isFinite(current) ? current : 1, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
  const threshold = Math.max(1, recallWindowMs);
  const target = correct
    ? clamp(1.5 - 0.5 * (Math.max(0, thinkingMs) / threshold), MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER)
    : MIN_PERFORMANCE_MULTIPLIER;
  return clamp(safeCurrent + (target - safeCurrent) * PERFORMANCE_SMOOTHING, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
}

/** Strong performance shortens the spawn timer; weak performance extends it. */
export function performanceAdjustedSpawnDelayMs(
  configuredIntervalMs: number,
  performanceMultiplier: number,
  hasActiveEnemies: boolean,
): number {
  const multiplier = clamp(performanceMultiplier, MIN_PERFORMANCE_MULTIPLIER, MAX_PERFORMANCE_MULTIPLIER);
  const adjusted = configuredIntervalMs / multiplier;
  return hasActiveEnemies ? adjusted : Math.min(adjusted, EMPTY_BATTLEFIELD_SPAWN_DELAY_MS);
}
