const MIN_WORD_SPEED_MULTIPLIER = 0.65;
const MAX_WORD_SPEED_MULTIPLIER = 1.5;

/** Converts a 0..1 pressure value (review recency pressure) to player-facing
 * enemy speed. 0 (newest words) is gentlest; 1 is fastest. Review planning
 * scales the pressure range for eligible acquired-word pools below 100. */
export function wordSpeedMultiplierForFamiliarity(familiarity: number): number {
  if (!Number.isFinite(familiarity)) throw new RangeError("familiarity must be finite");
  const normalized = Math.min(1, Math.max(0, familiarity));
  return MIN_WORD_SPEED_MULTIPLIER + normalized * (MAX_WORD_SPEED_MULTIPLIER - MIN_WORD_SPEED_MULTIPLIER);
}
