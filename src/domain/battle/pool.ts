import type { BattleConfig, VocabRow } from "../../shared/battle";

/** Mastery category of one vocab row. Boundaries are inclusive: low is
 * 0..lowMax, developing is lowMax+1..developingMax, mastered is
 * developingMax+1..100 (with the approved tuning: 0..50, 51..99, 100). */
export type MasteryCategory = "low" | "developing" | "mastered";

export function masteryCategory(mastery: number, config: BattleConfig): MasteryCategory {
  if (mastery <= config.boundaries.lowMax) return "low";
  if (mastery <= config.boundaries.developingMax) return "developing";
  return "mastered";
}

/** The live battle pools, computed from one vocab snapshot.
 *
 * - `low`: EXACTLY the `learningSlots` lowest-`id` rows with low mastery
 *   (mastery <= lowMax), in ascending id order. The server keeps this set
 *   refilled by appending unseen curriculum entries strictly in curriculum
 *   order, so at rest it holds `learningSlots` rows until the curriculum is
 *   exhausted; any further low rows (a graduated word that dropped back)
 *   stay benched until they are again among the lowest ids.
 * - `developing` / `mastered`: every row above the low boundary, ascending
 *   id. Together they form the "mature" pool and drive the Hill curve.
 *
 * Rows are bucketed by id order, matching the server's insertion-ordered
 * curriculum positions. */
export type BattlePools = {
  low: readonly VocabRow[];
  developing: readonly VocabRow[];
  mastered: readonly VocabRow[];
};

export function battlePools(vocab: readonly VocabRow[], config: BattleConfig): BattlePools {
  const ordered = [...vocab].sort((left, right) => left.id - right.id);
  const low: VocabRow[] = [];
  const developing: VocabRow[] = [];
  const mastered: VocabRow[] = [];
  for (const row of ordered) {
    if (masteryCategory(row.mastery, config) === "low") {
      if (low.length < config.learningSlots) low.push(row);
      // A low row beyond the slot count is benched: it is in NO pool.
    } else if (masteryCategory(row.mastery, config) === "developing") {
      developing.push(row);
    } else {
      mastered.push(row);
    }
  }
  return { low, developing, mastered };
}

/** n in the Hill curve: the count of vocab rows with mastery above the low
 * boundary (developing + mastered). */
export function matureCount(pools: BattlePools): number {
  return pools.developing.length + pools.mastered.length;
}

/** True when the card belongs to the spawnable pool (mature, or one of the
 * learning-slot low rows). Benched low rows are deliberately excluded. */
export function isInPool(row: VocabRow, pools: BattlePools, config: BattleConfig): boolean {
  if (masteryCategory(row.mastery, config) !== "low") return true;
  return pools.low.some((low) => low.cardId === row.cardId);
}
