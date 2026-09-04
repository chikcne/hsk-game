import {
  REVIEW_NEW_TIER_RANK_LIMIT,
  REVIEW_RECENT_TIER_RANK_LIMIT,
} from "../../shared/constants";
import type { SchedulerSnapshot } from "../learning";
import { Xoshiro128StarStar, type RandomSource, type RandomState } from "../random";

/** Recency tier of an acquired word, judged purely by its position in the
 * `acquired_words` log at session start (rank 0 = newest acquisition):
 * "new" ranks 0–19, "recent" ranks 20–99, "old" ranks 100+. FSRS state,
 * due dates, and retrievability play no part in review selection. */
export type RecencyLabel = "new" | "recent" | "old";

export function recencyLabelOfRank(rank: number): RecencyLabel {
  if (!Number.isInteger(rank) || rank < 0) throw new RangeError("rank must be a nonnegative integer");
  if (rank < REVIEW_NEW_TIER_RANK_LIMIT) return "new";
  if (rank < REVIEW_RECENT_TIER_RANK_LIMIT) return "recent";
  return "old";
}

/** Spawn pressure in 0..1 derived from the recency rank: New words are the
 * gentlest (0), pressure interpolates linearly and reaches its maximum (1)
 * by rank 100 — every "Old" word presses equally. Drives enemy speed and
 * the mastery-adjusted spawn delay; never FSRS memory. */
export function recencyPressureOfRank(rank: number): number {
  if (!Number.isInteger(rank) || rank < 0) throw new RangeError("rank must be a nonnegative integer");
  return Math.min(1, rank / REVIEW_RECENT_TIER_RANK_LIMIT);
}

/** The deterministic, nonpersisted Review battle plan.
 *
 * - `spawns`: exactly `targetLength` word keys (see buildReviewPlan), in
 *   serving order. Duplicate keys are intentional: tier-quota occurrences
 *   repeat sequentially at runtime, never concurrently.
 * - `recency`: per unique key, the label captured at session start (summary
 *   chips). Never recomputed mid-session, even if the save's ordering moves.
 * - `pressure`: per unique key, 0..1 recency pressure at session start
 *   (enemy speed + spawn-delay adjustment).
 * - `snapshot`: the scheduler snapshot after the plan consumed the persisted
 *   RNG. `spawnOrdinal` is untouched here — the runtime advances it once per
 *   actual spawn. The plan itself is never persisted; only this advanced
 *   snapshot is, so replays and restarted sessions differ deterministically.
 */
export type ReviewPlan = {
  spawns: string[];
  recency: Map<string, RecencyLabel>;
  pressure: Map<string, number>;
  snapshot: SchedulerSnapshot;
};

function fisherYates<T>(items: T[], rng: RandomSource): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng.nextUnit() * (index + 1));
    const temp = items[index]!;
    items[index] = items[swap]!;
    items[swap] = temp;
  }
}

/**
 * Builds the base spawn plan for one Review battle from the ordered
 * `acquired_words` log (newest first) and the persisted RNG.
 *
 * Guaranteed tier quotas (ranks are positions in `acquiredWords`):
 * - ranks 0–19 ("New"): exactly 2 occurrences each;
 * - ranks 20–99 ("Recent"): exactly 1 occurrence each;
 * - ranks 100+ ("Old"): 0 guaranteed occurrences.
 *
 * Every remaining slot is filled by a uniform random draw from the "Old"
 * pool (rank ≥ 100). When that pool is empty the fallback is a uniform draw
 * from "Recent", then "New", then all available — so small pools still
 * reach the exact target length. A empty log yields an empty plan.
 *
 * The guaranteed quota entries and the filler draws are shuffled together
 * (Fisher–Yates over the whole list), so tiers interleave instead of
 * arriving in blocks, while every guaranteed count is preserved exactly.
 * The same inputs always produce the same plan (deterministic RNG).
 *
 * If the guaranteed quota ever exceeded `targetLength` (impossible with the
 * settings bounds: the maximum quota is 2×20 + 80 = 120 < 200), the plan is
 * extended to fit the quota rather than dropping guaranteed occurrences.
 */
export function buildReviewPlan(
  acquiredWords: readonly string[],
  targetLength: number,
  rngState: RandomState,
): ReviewPlan {
  if (!Number.isInteger(targetLength) || targetLength < 0) {
    throw new RangeError("targetLength must be a nonnegative integer");
  }
  const rng = new Xoshiro128StarStar(rngState);

  // Recency bookkeeping at session start.
  const recency = new Map<string, RecencyLabel>();
  const pressure = new Map<string, number>();
  const newPool: string[] = [];
  const recentPool: string[] = [];
  const oldPool: string[] = [];
  const quotaEntries: string[] = [];
  const seen = new Set<string>();
  for (const [rank, key] of acquiredWords.entries()) {
    if (seen.has(key)) continue; // defensive: tolerate duplicate keys, first occurrence wins
    seen.add(key);
    recency.set(key, recencyLabelOfRank(rank));
    pressure.set(key, recencyPressureOfRank(rank));
    if (rank < REVIEW_NEW_TIER_RANK_LIMIT) {
      newPool.push(key);
      quotaEntries.push(key, key); // exactly two guaranteed occurrences
    } else if (rank < REVIEW_RECENT_TIER_RANK_LIMIT) {
      recentPool.push(key);
      quotaEntries.push(key); // exactly one guaranteed occurrence
    } else {
      oldPool.push(key); // no guaranteed occurrence
    }
  }

  const guaranteedCount = quotaEntries.length;
  const length = Math.max(targetLength, guaranteedCount);
  const fillerCount = Math.max(0, length - guaranteedCount);

  // Filler draws: uniform from Old, falling back to Recent, then New.
  const fillerPool = oldPool.length > 0 ? oldPool : recentPool.length > 0 ? recentPool : newPool;
  const fillerEntries: string[] = [];
  for (let index = 0; index < fillerCount; index += 1) {
    if (fillerPool.length === 0) break; // acquiredWords was empty
    fillerEntries.push(fillerPool[Math.floor(rng.nextUnit() * fillerPool.length)]!);
  }

  const spawns = [...quotaEntries, ...fillerEntries];
  fisherYates(spawns, rng);

  return {
    spawns,
    recency,
    pressure,
    snapshot: { spawnOrdinal: 0, schedulerRng: rng.state() },
  };
}

/** Convenience for callers that already hold a snapshot: builds the plan and
 * returns it with the ORIGINAL spawn ordinal preserved (the plan builder
 * never allocates ordinals; the runtime does, one per served spawn). */
export function buildReviewPlanFromSnapshot(
  acquiredWords: readonly string[],
  targetLength: number,
  snapshot: SchedulerSnapshot,
): ReviewPlan {
  const plan = buildReviewPlan(acquiredWords, targetLength, snapshot.schedulerRng);
  return { ...plan, snapshot: { spawnOrdinal: snapshot.spawnOrdinal, schedulerRng: plan.snapshot.schedulerRng } };
}
