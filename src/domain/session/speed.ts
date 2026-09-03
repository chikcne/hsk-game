import { wordFamiliarity } from "../memory";
import type { WordProgress } from "../../shared/schemas";

const MIN_WORD_SPEED_MULTIPLIER = 0.65;
const MAX_WORD_SPEED_MULTIPLIER = 1.5;

/** Converts FSRS-derived familiarity (0..1) to player-facing speed. */
export function wordSpeedMultiplierForFamiliarity(familiarity: number): number {
  if (!Number.isFinite(familiarity)) throw new RangeError("familiarity must be finite");
  const normalized = Math.min(1, Math.max(0, familiarity));
  return MIN_WORD_SPEED_MULTIPLIER + normalized * (MAX_WORD_SPEED_MULTIPLIER - MIN_WORD_SPEED_MULTIPLIER);
}

/** Better-known words descend faster. The global speed setting is applied
 * separately, so it can still speed up or slow down the entire session. */
export function wordSpeedMultiplier(progress: Pick<WordProgress, "pinyin" | "meaning">): number {
  return wordSpeedMultiplierForFamiliarity(wordFamiliarity(progress));
}
