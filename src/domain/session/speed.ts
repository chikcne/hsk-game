const MIN_WORD_SPEED_MULTIPLIER = 0.9;
const MAX_WORD_SPEED_MULTIPLIER = 1.1;

/** Better-mastered words descend slightly faster. Mastery only nudges speed
 * within a narrow band: the SRS decides which word appears, never how hard
 * the battlefield presses. The global speed setting is applied separately. */
export function wordSpeedMultiplierForMastery(masteryLevel: number): number {
  if (!Number.isFinite(masteryLevel)) throw new RangeError("masteryLevel must be finite");
  const normalized = (Math.min(100, Math.max(0, masteryLevel))) / 100;
  return MIN_WORD_SPEED_MULTIPLIER + normalized * (MAX_WORD_SPEED_MULTIPLIER - MIN_WORD_SPEED_MULTIPLIER);
}
