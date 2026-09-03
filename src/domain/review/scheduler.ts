import type { ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import { type RandomSource, Xoshiro128StarStar } from "../random";

export type ReviewSpawnResult =
  | { status: "spawned"; review: ReviewProgress; wordKey: string; spawnOrdinal: number; tier: "repair" | "due" }
  | { status: "complete"; review: ReviewProgress; spawnOrdinal: number };

type Candidate = { key: string; progress: ReviewWordProgress };

function chooseRepair(candidates: readonly Candidate[], rng: RandomSource): Candidate {
  const earliest = Math.min(...candidates.map((item) => item.progress.dueOrdinal ?? Number.MAX_SAFE_INTEGER));
  const due = candidates.filter((item) => (item.progress.dueOrdinal ?? Number.MAX_SAFE_INTEGER) === earliest);
  return chooseWeighted(due, rng);
}

function chooseDue(candidates: readonly Candidate[], rng: RandomSource): Candidate {
  return chooseWeighted(candidates, rng);
}

function chooseWeighted(candidates: readonly Candidate[], rng: RandomSource): Candidate {
  const weights = candidates.map((item) => {
    const recallBias = item.progress.recallScoreMsPerChar === null ? 1 : 1 + Math.min(4, item.progress.recallScoreMsPerChar / 1000);
    const lapseBias = 1 + item.progress.wrongPinyin + item.progress.wrongMeaning + item.progress.landed + item.progress.struggles * 0.5;
    return recallBias * lapseBias;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let position = rng.nextUnit() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    if (position < weights[index]!) return candidates[index]!;
    position -= weights[index]!;
  }
  return candidates[candidates.length - 1]!;
}

/** Schedules only mastered cards supplied by the caller. Relearning (repair)
 * cards take priority; due cards follow wall-clock dueAt. When neither queue
 * has work the round simply ends — unrelated mastered cards are never pulled
 * in as graded fillers, so scheduled reviews cannot be pushed back. */
export function spawnNextReviewWord(
  source: ReviewProgress,
  masteredWordKeys: ReadonlySet<string>,
  excludedWordKeys: ReadonlySet<string> = new Set(),
  nowMs: number = Date.now(),
  sourceRng?: RandomSource,
): ReviewSpawnResult {
  const ordinal = source.nextSpawnOrdinal;
  const candidates = [...masteredWordKeys].flatMap((key) => {
    const progress = source.words[key];
    return !progress || excludedWordKeys.has(key) ? [] : [{ key, progress }];
  });
  const repair = candidates.filter((item) =>
    item.progress.phase === "relearning" && (item.progress.dueOrdinal ?? Number.MAX_SAFE_INTEGER) <= ordinal);
  const due = candidates.filter((item) =>
    item.progress.phase === "review" && item.progress.dueAt !== null && Date.parse(item.progress.dueAt) <= nowMs);

  let tier: "repair" | "due";
  let pool: Candidate[];
  if (repair.length > 0) { tier = "repair"; pool = repair; }
  else if (due.length > 0) { tier = "due"; pool = due; }
  else return { status: "complete", review: source, spawnOrdinal: ordinal };

  const rng = sourceRng ?? new Xoshiro128StarStar(source.schedulerRng);
  const selected = tier === "repair" ? chooseRepair(pool, rng) : chooseDue(pool, rng);
  const reserved: ReviewWordProgress = {
    ...selected.progress,
    lastSpawnOrdinal: ordinal,
  };
  return {
    status: "spawned",
    review: {
      ...source,
      nextSpawnOrdinal: ordinal + 1,
      schedulerRng: rng.state(),
      words: { ...source.words, [selected.key]: reserved },
    },
    wordKey: selected.key,
    spawnOrdinal: ordinal,
    tier,
  };
}
