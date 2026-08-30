const MIN_WORD_SPEED_MULTIPLIER = 0.65;
const MAX_WORD_SPEED_MULTIPLIER = 1.5;

/** Converts the stored inverse appearance weight (1 = mastered) to the
 * player-facing mastery level (1..100). */
export function masteryLevelFromAppearanceWeight(appearanceWeight: number): number {
  if (!Number.isFinite(appearanceWeight)) throw new RangeError("appearanceWeight must be finite");
  return 101 - Math.min(100, Math.max(1, appearanceWeight));
}

/** Better-mastered words descend faster. The global speed setting is applied
 * separately, so it can still speed up or slow down the entire invasion. */
export function wordSpeedMultiplierForMastery(masteryLevel: number): number {
  if (!Number.isFinite(masteryLevel)) throw new RangeError("masteryLevel must be finite");
  const normalized = (Math.min(100, Math.max(1, masteryLevel)) - 1) / 99;
  return MIN_WORD_SPEED_MULTIPLIER + normalized * (MAX_WORD_SPEED_MULTIPLIER - MIN_WORD_SPEED_MULTIPLIER);
}

export function wordSpeedMultiplierFromAppearanceWeight(appearanceWeight: number): number {
  return wordSpeedMultiplierForMastery(masteryLevelFromAppearanceWeight(appearanceWeight));
}
