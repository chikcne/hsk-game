const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function calculatePoints(thinkingMs: number, streakBeforeHit: number, spawnIntervalMs: number, enemySpeedMultiplier: number): number {
  const speedScore = clamp((12_000 - thinkingMs) / 9_500, 0, 1);
  const pressureFactor = clamp(Math.sqrt(3_000 / spawnIntervalMs), 0.75, 1.42);
  const difficultyFactor = clamp(pressureFactor * enemySpeedMultiplier, 0.5, 2);
  const streakFactor = 1 + Math.min(streakBeforeHit, 20) * 0.05;
  return Math.max(0, Math.round(((200 + 200 * speedScore) * streakFactor * difficultyFactor) / 10) * 10);
}
