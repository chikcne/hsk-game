import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { type RandomSource, Xoshiro128StarStar } from "../random";
import {
  ANTI_STARVATION_AGE,
  HARD_MIN_INTERVENING_WORDS,
  MAX_ELIGIBLE_AGE_BOOST,
  SPAWN_MIX,
} from "./constants";
import { refillCurriculum } from "./curriculum";
import type { LearningDeck, SpawnResult, SpawnTier } from "./types";

const DAY_MS = 86_400_000;

type BucketName = keyof typeof SPAWN_MIX;

type Candidate = {
  id: string;
  progress: WordProgress;
  eligibleAge: number;
  urgency: number;
  bucket: BucketName;
};

export function isEligible(progress: WordProgress, spawnOrdinal: number): boolean {
  return progress.introducedAtOrdinal !== null && progress.nextEligibleSpawn <= spawnOrdinal;
}

export function eligibleAge(progress: WordProgress, spawnOrdinal: number): number {
  return Math.max(0, spawnOrdinal - progress.nextEligibleSpawn);
}

/** Whether the word's schedule says it is due: learning/relearning words by
 * ordinal, graduated words by wall clock, and new words as soon as they have
 * been introduced. */
export function isDue(progress: WordProgress, spawnOrdinal: number, nowMs: number): boolean {
  switch (progress.phase) {
    case "new": return true;
    case "learning":
    case "relearning":
      return progress.dueOrdinal !== null && progress.dueOrdinal <= spawnOrdinal;
    case "review":
      return progress.dueAt !== null && Date.parse(progress.dueAt) <= nowMs;
  }
}

function bucketOf(progress: WordProgress): BucketName {
  return progress.phase === "review" || progress.phase === "relearning" ? "due"
    : progress.phase === "learning" ? "learning"
    : "new";
}

function urgency(progress: WordProgress, spawnOrdinal: number, nowMs: number): number {
  if (progress.phase === "review" && progress.dueAt !== null) {
    return 1 + Math.max(0, (nowMs - Date.parse(progress.dueAt)) / DAY_MS);
  }
  if (progress.dueOrdinal !== null) return 1 + Math.max(0, spawnOrdinal - progress.dueOrdinal);
  return 1 + Math.min(MAX_ELIGIBLE_AGE_BOOST, eligibleAge(progress, spawnOrdinal) / 100);
}

function candidate(progress: WordProgress, id: string, spawnOrdinal: number, nowMs: number): Candidate {
  return {
    id,
    progress,
    eligibleAge: eligibleAge(progress, spawnOrdinal),
    urgency: urgency(progress, spawnOrdinal, nowMs),
    bucket: bucketOf(progress),
  };
}

/** Buckets the eligible, off-screen words by due state: graduated and
 * relearning words that are due, learning words that are due, and brand-new
 * words awaiting their first test. Graduated words live outside the active
 * pool, so they are gathered from the full level record (their wall-clock
 * dueAt governs whether they reappear during regular play). */
export function selectionBuckets(
  level: LevelProgress,
  nowMs: number,
  excludedWordIds: ReadonlySet<string> = new Set(),
): Record<BucketName, Candidate[]> {
  const ordinal = level.nextSpawnOrdinal;
  const buckets: Record<BucketName, Candidate[]> = { due: [], learning: [], new: [] };
  const consider = (id: string, progress: WordProgress | undefined) => {
    if (!progress || excludedWordIds.has(id) || !isEligible(progress, ordinal)) return;
    if (isDue(progress, ordinal, nowMs)) buckets[bucketOf(progress)].push(candidate(progress, id, ordinal, nowMs));
  };
  for (const id of level.activeLearningWordIds) consider(id, level.words[id]);
  for (const [id, progress] of Object.entries(level.words)) {
    if (progress.phase === "review") consider(id, progress);
  }
  return buckets;
}

/** Eligible words that are not yet due may appear as ungraded practice when
 * nothing is due; their outcomes never change the schedule. This includes
 * mastered words, mirroring the old mastered fallback but always ungraded. */
export function practiceCandidates(
  level: LevelProgress,
  nowMs: number,
  excludedWordIds: ReadonlySet<string> = new Set(),
): Candidate[] {
  const ordinal = level.nextSpawnOrdinal;
  const pool: Candidate[] = [];
  const consider = (id: string, progress: WordProgress | undefined) => {
    if (!progress || excludedWordIds.has(id) || !isEligible(progress, ordinal) || progress.phase === "new") return;
    if (isDue(progress, ordinal, nowMs)) return;
    pool.push({ id, progress, eligibleAge: eligibleAge(progress, ordinal), urgency: 1, bucket: "due" });
  };
  for (const id of level.activeLearningWordIds) consider(id, level.words[id]);
  for (const [id, progress] of Object.entries(level.words)) {
    if (progress.phase === "review") consider(id, progress);
  }
  // Least recently seen first, so practice rotates through the whole pool.
  return pool.sort((left, right) =>
    (left.progress.lastSpawnOrdinal ?? left.progress.introducedAtOrdinal ?? 0) - (right.progress.lastSpawnOrdinal ?? right.progress.introducedAtOrdinal ?? 0)
    || compareStableId(left.id, right.id));
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Anti-starvation override: the most overdue candidate wins deterministically. */
function starvedCandidate(candidates: readonly Candidate[]): Candidate {
  return [...candidates].sort((left, right) =>
    right.eligibleAge - left.eligibleAge
    || right.urgency - left.urgency
    || compareStableId(left.id, right.id))[0]!;
}

function drawFromWeighted(candidates: readonly Candidate[], weights: readonly number[], unit: number): Candidate {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let position = unit * total;
  for (let index = 0; index < candidates.length; index += 1) {
    if (position < weights[index]!) return candidates[index]!;
    position -= weights[index]!;
  }
  return candidates[candidates.length - 1]!;
}

function nextUnit(rng: RandomSource): number {
  const unit = rng.nextUnit();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RangeError("RandomSource.nextUnit() must return a finite value in [0, 1)");
  return unit;
}

/** Chooses a bucket by the target mix, redistributing the share of any empty
 * bucket across the remaining ones, then picks within the bucket by urgency. */
function drawBucketed(buckets: Record<BucketName, Candidate[]>, rng: RandomSource): { selected: Candidate; tier: SpawnTier } {
  const present = (Object.keys(SPAWN_MIX) as BucketName[]).filter((bucket) => buckets[bucket].length > 0);
  const shareTotal = present.reduce((sum, bucket) => sum + SPAWN_MIX[bucket], 0);
  const shares = present.map((bucket) => SPAWN_MIX[bucket] / shareTotal);
  let position = nextUnit(rng);
  let chosen = present[present.length - 1]!;
  for (let index = 0; index < present.length; index += 1) {
    if (position < shares[index]!) { chosen = present[index]!; break; }
    position -= shares[index]!;
  }
  const pool = buckets[chosen];
  const selected = drawFromWeighted(pool, pool.map((entry) => entry.urgency), nextUnit(rng));
  return { selected, tier: chosen };
}

/** Selects one regular-level word and reserves it against a simultaneous
 * enemy. Spacing is never violated: only due words are graded, and when
 * nothing is due the battlefield runs on ungraded practice instead of
 * dragging a cooling word back early. */
export function spawnNextWord(
  sourceLevel: LevelProgress,
  deck: LearningDeck,
  sourceRng?: RandomSource,
  nowMs: number = Date.now(),
  excludedWordIds: ReadonlySet<string> = new Set(),
): SpawnResult {
  const level = refillCurriculum(sourceLevel, deck);
  const ordinal = level.nextSpawnOrdinal;
  const buckets = selectionBuckets(level, nowMs, excludedWordIds);
  const dueCandidates = [...buckets.due, ...buckets.learning, ...buckets.new];

  const rng = sourceRng ?? new Xoshiro128StarStar(level.schedulerRng);
  let selected: Candidate;
  let tier: SpawnTier;
  if (dueCandidates.length > 0) {
    const starved = dueCandidates.filter((entry) => entry.eligibleAge >= ANTI_STARVATION_AGE);
    if (starved.length > 0) {
      selected = starvedCandidate(starved);
      tier = selected.bucket;
    } else {
      ({ selected, tier } = drawBucketed(buckets, rng));
    }
  } else {
    const practice = practiceCandidates(level, nowMs, excludedWordIds);
    if (practice.length === 0) {
      const records = Object.values(level.words);
      return {
        status: "noEligibleWord",
        level,
        spawnOrdinal: ordinal,
        diagnostics: {
          activeCount: level.activeLearningWordIds.length,
          introducedCount: records.filter((progress) => progress.introducedAtOrdinal !== null).length,
          coolingCount: records.filter((progress) => progress.introducedAtOrdinal !== null && progress.nextEligibleSpawn > ordinal).length,
        },
      };
    }
    selected = practice[0]!;
    tier = "practice";
  }

  const progress: WordProgress = {
    ...selected.progress,
    lastSpawnOrdinal: ordinal,
    nextEligibleSpawn: ordinal + 1 + HARD_MIN_INTERVENING_WORDS,
  };
  const nextLevel: LevelProgress = {
    ...level,
    nextSpawnOrdinal: ordinal + 1,
    schedulerRng: rng.state(),
    words: { ...level.words, [selected.id]: progress },
  };
  return { status: "spawned", level: nextLevel, wordId: selected.id, spawnOrdinal: ordinal, tier };
}
