import { Effect } from "effect";
import {
  REVIEW_FULL_SCALE_WORD_COUNT,
  REVIEW_MIN_ACQUIRED_WORDS,
  REVIEW_NEW_TIER_RANK_LIMIT,
  REVIEW_RECENT_TIER_RANK_LIMIT,
} from "../../shared/constants";
import type { SchedulerSnapshot } from "../learning";
import { runDomain } from "../effect";
import { NonNegativeIntegerError, PositiveIntegerError } from "../errors";
import { Xoshiro128StarStar, type RandomSource, type RandomState } from "../random";

/** Recency tier of an acquired word, judged purely by its position in the
 * `acquired_words` log at session start (rank 0 = newest acquisition).
 * At 100+ acquired words, "new" is ranks 0–19, "recent" is 20–99, and
 * "old" is 100+. For eligible pools below 100, both boundaries scale by
 * acquiredWordCount / 100 (for example, 50 words means 10 New + 40 Recent).
 * FSRS state, due dates, and retrievability play no part in selection. */
export type RecencyLabel = "new" | "recent" | "old";

export type RecencyOfRankFailure = NonNegativeIntegerError | PositiveIntegerError;

export type BuildReviewPlanFailure = NonNegativeIntegerError;

function reviewScale(acquiredWordCount: number): number {
  // Validated by every typed entry point below; kept as a defect guard.
  if (!Number.isInteger(acquiredWordCount) || acquiredWordCount <= 0) {
    throw new PositiveIntegerError({ param: "acquiredWordCount" });
  }
  return Math.min(1, acquiredWordCount / REVIEW_FULL_SCALE_WORD_COUNT);
}

function tierRankLimits(acquiredWordCount: number): { newLimit: number; recentLimit: number } {
  const scale = reviewScale(acquiredWordCount);
  return {
    newLimit: Math.max(1, Math.round(REVIEW_NEW_TIER_RANK_LIMIT * scale)),
    recentLimit: Math.max(1, Math.round(REVIEW_RECENT_TIER_RANK_LIMIT * scale)),
  };
}

/** Typed variant of {@link recencyLabelOfRank}: fails with a
 * `NonNegativeIntegerError` or a `PositiveIntegerError` instead of throwing
 * `RangeError`s. */
export function recencyLabelOfRankEffect(rank: number, acquiredWordCount = REVIEW_FULL_SCALE_WORD_COUNT): Effect.Effect<RecencyLabel, RecencyOfRankFailure, never> {
  return Effect.gen(function* () {
    if (!Number.isInteger(rank) || rank < 0) return yield* Effect.fail(new NonNegativeIntegerError({ param: "rank" }));
    if (!Number.isInteger(acquiredWordCount) || acquiredWordCount <= 0) return yield* Effect.fail(new PositiveIntegerError({ param: "acquiredWordCount" }));
    const { newLimit, recentLimit } = tierRankLimits(acquiredWordCount);
    if (rank < newLimit) return "new";
    if (rank < recentLimit) return "recent";
    return "old";
  });
}

export function recencyLabelOfRank(
  rank: number,
  acquiredWordCount = REVIEW_FULL_SCALE_WORD_COUNT,
): RecencyLabel {
  return runDomain(recencyLabelOfRankEffect(rank, acquiredWordCount));
}

/** Spawn pressure in 0..1 derived from the recency rank. Pressure normally
 * reaches its maximum by rank 100; for eligible pools below 100, that range
 * scales with the pool (rank / acquiredWordCount). Drives enemy speed and
 * spawn delay; never FSRS memory. */
export function recencyPressureOfRankEffect(rank: number, acquiredWordCount = REVIEW_FULL_SCALE_WORD_COUNT): Effect.Effect<number, RecencyOfRankFailure, never> {
  return Effect.gen(function* () {
    if (!Number.isInteger(rank) || rank < 0) return yield* Effect.fail(new NonNegativeIntegerError({ param: "rank" }));
    if (!Number.isInteger(acquiredWordCount) || acquiredWordCount <= 0) return yield* Effect.fail(new PositiveIntegerError({ param: "acquiredWordCount" }));
    const { recentLimit } = tierRankLimits(acquiredWordCount);
    return Math.min(1, rank / recentLimit);
  });
}

export function recencyPressureOfRank(
  rank: number,
  acquiredWordCount = REVIEW_FULL_SCALE_WORD_COUNT,
): number {
  return runDomain(recencyPressureOfRankEffect(rank, acquiredWordCount));
}

/** The deterministic, nonpersisted Review battle plan.
 *
 * - `spawns`: the scaled target number of word keys (see buildReviewPlan),
 *   in serving order. Duplicate keys are intentional: tier-quota occurrences
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
 * Review is unavailable with fewer than 20 unique acquired words, yielding
 * an empty plan. From 20–99 words, the New/Recent boundaries, pressure, and
 * target length all scale by acquiredWordCount / 100. Thus a 50-word pool
 * has 10 New + 40 Recent words and a configured 200-spawn target becomes
 * 100 spawns. At 100+ words the full-size contract applies:
 * - ranks 0–19 ("New"): exactly 2 occurrences each;
 * - ranks 20–99 ("Recent"): exactly 1 occurrence each;
 * - ranks 100+ ("Old"): 0 guaranteed occurrences.
 *
 * Every remaining slot is filled by a uniform random draw from the "Old"
 * pool. When that pool is empty the fallback is a uniform draw from
 * "Recent", then "New". Quotas and scaled target lengths are integer-rounded.
 *
 * The guaranteed quota entries and the filler draws are shuffled together
 * (Fisher–Yates over the whole list), so tiers interleave instead of
 * arriving in blocks, while every guaranteed count is preserved exactly.
 * The same inputs always produce the same plan (deterministic RNG).
 *
 * If the guaranteed quota ever exceeded the scaled target (only possible
 * when called outside the settings bounds), the plan extends to fit the
 * quota rather than dropping guaranteed occurrences.
 */
export function buildReviewPlanEffect(
  acquiredWords: readonly string[],
  targetLength: number,
  rngState: RandomState,
): Effect.Effect<ReviewPlan, BuildReviewPlanFailure, never> {
  return Effect.gen(function* () {
    if (!Number.isInteger(targetLength) || targetLength < 0) {
      return yield* Effect.fail(new NonNegativeIntegerError({ param: "targetLength" }));
    }
    return yield* Effect.sync(() => buildReviewPlanUnchecked(acquiredWords, targetLength, rngState));
  });
}

function buildReviewPlanUnchecked(
  acquiredWords: readonly string[],
  targetLength: number,
  rngState: RandomState,
): ReviewPlan {
  const rng = new Xoshiro128StarStar(rngState);
  const uniqueWords = [...new Set(acquiredWords)];

  // Review cannot start below the minimum; consuming no random draws keeps
  // the scheduler state unchanged when callers probe an ineligible pool.
  if (uniqueWords.length < REVIEW_MIN_ACQUIRED_WORDS) {
    return {
      spawns: [],
      recency: new Map(),
      pressure: new Map(),
      snapshot: { spawnOrdinal: 0, schedulerRng: rng.state() },
    };
  }

  const acquiredWordCount = uniqueWords.length;
  const scale = reviewScale(acquiredWordCount);
  const { newLimit, recentLimit } = tierRankLimits(acquiredWordCount);

  // Recency bookkeeping at session start.
  const recency = new Map<string, RecencyLabel>();
  const pressure = new Map<string, number>();
  const newPool: string[] = [];
  const recentPool: string[] = [];
  const oldPool: string[] = [];
  const quotaEntries: string[] = [];
  for (const [rank, key] of uniqueWords.entries()) {
    recency.set(key, recencyLabelOfRank(rank, acquiredWordCount));
    pressure.set(key, recencyPressureOfRank(rank, acquiredWordCount));
    if (rank < newLimit) {
      newPool.push(key);
      quotaEntries.push(key, key); // exactly two guaranteed occurrences
    } else if (rank < recentLimit) {
      recentPool.push(key);
      quotaEntries.push(key); // exactly one guaranteed occurrence
    } else {
      oldPool.push(key); // no guaranteed occurrence
    }
  }

  const guaranteedCount = quotaEntries.length;
  const scaledTargetLength = Math.round(targetLength * scale);
  const length = Math.max(scaledTargetLength, guaranteedCount);
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

export function buildReviewPlan(
  acquiredWords: readonly string[],
  targetLength: number,
  rngState: RandomState,
): ReviewPlan {
  return runDomain(buildReviewPlanEffect(acquiredWords, targetLength, rngState));
}

/** Typed variant of {@link buildReviewPlanFromSnapshot}. */
export function buildReviewPlanFromSnapshotEffect(
  acquiredWords: readonly string[],
  targetLength: number,
  snapshot: SchedulerSnapshot,
): Effect.Effect<ReviewPlan, BuildReviewPlanFailure, never> {
  return Effect.map(
    buildReviewPlanEffect(acquiredWords, targetLength, snapshot.schedulerRng),
    (plan) => ({ ...plan, snapshot: { spawnOrdinal: snapshot.spawnOrdinal, schedulerRng: plan.snapshot.schedulerRng } }),
  );
}

/** Convenience for callers that already hold a snapshot: builds the plan and
 * returns it with the ORIGINAL spawn ordinal preserved (the plan builder
 * never allocates ordinals; the runtime does, one per served spawn). */
export function buildReviewPlanFromSnapshot(
  acquiredWords: readonly string[],
  targetLength: number,
  snapshot: SchedulerSnapshot,
): ReviewPlan {
  return runDomain(buildReviewPlanFromSnapshotEffect(acquiredWords, targetLength, snapshot));
}
