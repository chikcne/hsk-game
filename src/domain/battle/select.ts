import type { BattleConfig, VocabRow } from "../../shared/battle";
import type { RandomSource } from "../random";
import { battlePools, type MasteryCategory } from "./pool";
import { categoryShares } from "./weights";

/** The card chosen for one live spawn, with the category it was drawn from. */
export type BattleSpawnSelection = {
  row: VocabRow;
  category: MasteryCategory;
};

/** Draws the next spawn LIVE from one vocab snapshot — there is no plan, no
 * cursor, and no persisted scheduler state.
 *
 * - Category weights come from `categoryShares` over the FULL pools (the
 *   strategic mix uses every mature row, not just idle ones).
 * - Categories whose every member is excluded (active or preparing on the
 *   battlefield) drop out and their weight renormalizes over the remaining
 *   available categories, so a word is never selected twice concurrently.
 * - Within the selected category the member is drawn uniformly.
 * - Exactly two RNG draws are consumed per call (category, then member),
 *   making the stream deterministic under an injected seeded RNG.
 *
 * Returns null only when every pool member is excluded (or the pools are
 * empty); the caller waits for the battlefield to drain. */
export function selectBattleSpawn(
  vocab: readonly VocabRow[],
  config: BattleConfig,
  rng: RandomSource,
  activeCardIds: ReadonlySet<string>,
): BattleSpawnSelection | null {
  const pools = battlePools(vocab, config);
  const idleByCategory: Readonly<Record<MasteryCategory, readonly VocabRow[]>> = {
    low: pools.low.filter((row) => !activeCardIds.has(row.cardId)),
    developing: pools.developing.filter((row) => !activeCardIds.has(row.cardId)),
    mastered: pools.mastered.filter((row) => !activeCardIds.has(row.cardId)),
  };
  const candidates = (Object.keys(idleByCategory) as MasteryCategory[])
    .filter((category) => idleByCategory[category].length > 0)
    .map((category) => ({ category, rows: idleByCategory[category] }));
  if (candidates.length === 0) return null;

  const shares = categoryShares(pools, config);
  const shareOf = (category: MasteryCategory): number => shares[category];
  const totalShare = candidates.reduce((sum, candidate) => sum + shareOf(candidate.category), 0);

  let pick = rng.nextUnit() * totalShare;
  let chosen = candidates[0]!;
  for (const candidate of candidates) {
    pick -= shareOf(candidate.category);
    if (pick < 0) { chosen = candidate; break; }
  }

  // nextUnit() is < 1, but a hostile/floating-point edge could round the
  // floor onto the length; clamp so the draw can never read out of bounds.
  const index = Math.min(chosen.rows.length - 1, Math.floor(rng.nextUnit() * chosen.rows.length));
  return { row: chosen.rows[index]!, category: chosen.category };
}
