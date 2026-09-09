import type { BattleConfig } from "../../shared/battle";
import { matureCount, type BattlePools } from "./pool";

/** The Hill ratio over the mature-word count n:
 * r = n^shape / (n^shape + midpoint^shape). r rises from 0 (n = 0) toward 1
 * as n grows, reaching exactly 1/2 at n = midpoint. */
export function hillMatureRatio(n: number, config: BattleConfig): number {
  const maturePower = Math.pow(n, config.curve.shape);
  const midpointPower = Math.pow(config.curve.midpoint, config.curve.shape);
  return maturePower / (maturePower + midpointPower);
}

/** Category draw shares summing to 1 over the AVAILABLE categories.
 *
 * With every category populated the contract is:
 * - low = 1 - r * (1 - asymptotes.low)   (approved tuning: 1 - 0.9r);
 * - the remaining r * (1 - asymptotes.low) splits developing:mastered
 *   proportionally to their asymptotes (approved tuning .50:.40).
 *
 * Renormalization rules:
 * - an absent mature category cedes its share to the other mature category
 *   (the mature total r * (1 - aLow) is preserved);
 * - an empty low pool cedes everything to the mature categories;
 * - n = 0 makes r = 0, so low is exactly 100%.
 */
export type CategoryShares = {
  low: number;
  developing: number;
  mastered: number;
};

export function categoryShares(pools: BattlePools, config: BattleConfig): CategoryShares {
  const lowAvailable = pools.low.length > 0;
  const developingAvailable = pools.developing.length > 0;
  const masteredAvailable = pools.mastered.length > 0;
  const shares: CategoryShares = { low: 0, developing: 0, mastered: 0 };
  if (!lowAvailable && !developingAvailable && !masteredAvailable) return shares;

  const r = hillMatureRatio(matureCount(pools), config);
  const matureTotal = r * (1 - config.asymptotes.low);

  if (!lowAvailable) {
    // Mature categories renormalize over the whole draw.
    splitMature(shares, 1, developingAvailable, masteredAvailable, config);
    return shares;
  }

  shares.low = 1 - matureTotal;
  splitMature(shares, matureTotal, developingAvailable, masteredAvailable, config);
  return shares;
}

/** Splits `total` between the available mature categories proportionally to
 * their asymptotes (.50:.40 with the approved tuning; a lone category takes
 * everything). */
function splitMature(
  shares: CategoryShares,
  total: number,
  developingAvailable: boolean,
  masteredAvailable: boolean,
  config: BattleConfig,
): void {
  if (!developingAvailable && !masteredAvailable) return;
  if (developingAvailable && masteredAvailable) {
    const denominator = config.asymptotes.developing + config.asymptotes.mastered;
    shares.developing = total * config.asymptotes.developing / denominator;
    shares.mastered = total * config.asymptotes.mastered / denominator;
    return;
  }
  if (developingAvailable) shares.developing = total;
  else shares.mastered = total;
}
