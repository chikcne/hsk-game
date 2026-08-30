import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { DifficultySettings, ReviewProgress, ReviewWordProgress } from "../../shared/schemas";
import { type RandomSource, Xoshiro128StarStar } from "../random";

export type ReviewSpawnResult =
  | { status: "spawned"; review: ReviewProgress; wordKey: string; spawnOrdinal: number; tier: "repair" | "due" | "filler" }
  | { status: "complete"; review: ReviewProgress; spawnOrdinal: number };

type Candidate = { key: string; progress: ReviewWordProgress };

function choose(candidates: Candidate[], rng: RandomSource): Candidate {
  const earliest = Math.min(...candidates.map((item) => item.progress.dueOrdinal));
  const due = candidates.filter((item) => item.progress.dueOrdinal === earliest);
  const weights = due.map((item) => {
    const recallBias = item.progress.recallScoreMsPerChar === null ? 1 : 1 + Math.min(4, item.progress.recallScoreMsPerChar / 1000);
    const lapseBias = 1 + item.progress.wrongPinyin + item.progress.wrongMeaning + item.progress.landed + item.progress.struggles * 0.5;
    return recallBias * lapseBias;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let position = rng.nextUnit() * total;
  for (let index = 0; index < due.length; index += 1) {
    if (position < weights[index]!) return due[index]!;
    position -= weights[index]!;
  }
  return due[due.length - 1]!;
}

/** Schedules only mastered cards supplied by the caller. Repair cards take
 * priority; slow recall therefore remains in the current review pool. */
export function spawnNextReviewWord(
  source: ReviewProgress,
  masteredWordKeys: ReadonlySet<string>,
  excludedWordKeys: ReadonlySet<string> = new Set(),
  sourceRng?: RandomSource,
  settings: DifficultySettings = DEFAULT_SETTINGS,
): ReviewSpawnResult {
  const ordinal = source.nextSpawnOrdinal;
  const active = new Set(source.activePoolWordKeys);
  const candidates = [...masteredWordKeys].flatMap((key) => {
    const progress = source.words[key];
    return !progress || excludedWordKeys.has(key) ? [] : [{ key, progress }];
  });
  const repair = candidates.filter((item) => active.has(item.key) && item.progress.dueOrdinal <= ordinal);
  const due = candidates.filter((item) => !active.has(item.key) && item.progress.dueOrdinal <= ordinal);
  let tier: "repair" | "due" | "filler";
  let pool: Candidate[];
  if (repair.length > 0) { tier = "repair"; pool = repair; }
  else if (due.length > 0) { tier = "due"; pool = due; }
  else if (active.size > 0) {
    // Keep the round alive until repair cards graduate. Other mastered cards
    // provide the intervening phrases while a repair card is cooling.
    const fillers = candidates.filter((item) => !active.has(item.key));
    tier = "filler";
    pool = fillers.length > 0 ? fillers : candidates.filter((item) => active.has(item.key));
    if (pool.length === 0) return { status: "complete", review: source, spawnOrdinal: ordinal };
  } else {
    return { status: "complete", review: source, spawnOrdinal: ordinal };
  }

  const rng = sourceRng ?? new Xoshiro128StarStar(source.schedulerRng);
  const selected = choose(pool, rng);
  const reserved: ReviewWordProgress = {
    ...selected.progress,
    lastSpawnOrdinal: ordinal,
    dueOrdinal: ordinal + settings.reviewLapseInterval + 1,
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
