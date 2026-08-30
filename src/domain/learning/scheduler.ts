import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { drawCooldown, type RandomSource, Xoshiro128StarStar } from "../random";
import { ANTI_STARVATION_AGE, MAX_ELIGIBLE_AGE_BOOST } from "./constants";
import { refillCurriculum } from "./curriculum";
import type { LearningDeck, SpawnResult, SpawnTier } from "./types";

type Candidate = {
  id: string;
  progress: WordProgress;
  eligibleAge: number;
  effectiveWeight: number;
};

export function isEligible(progress: WordProgress, spawnOrdinal: number): boolean {
  return progress.introducedAtOrdinal !== null && progress.nextEligibleSpawn <= spawnOrdinal;
}

export function eligibleAge(progress: WordProgress, spawnOrdinal: number): number {
  const origin = progress.lastSpawnOrdinal ?? progress.introducedAtOrdinal ?? spawnOrdinal;
  return Math.max(0, spawnOrdinal - origin - 25);
}

export function effectiveAppearanceWeight(progress: WordProgress, spawnOrdinal: number): number {
  const age = eligibleAge(progress, spawnOrdinal);
  const ageBoost = 1 + Math.min(MAX_ELIGIBLE_AGE_BOOST, age / 100);
  return progress.appearanceWeight * ageBoost;
}

function candidate(id: string, progress: WordProgress, ordinal: number): Candidate {
  return {
    id,
    progress,
    eligibleAge: eligibleAge(progress, ordinal),
    effectiveWeight: effectiveAppearanceWeight(progress, ordinal),
  };
}

export function eligibleTier(
  level: LevelProgress,
): { tier: SpawnTier; candidates: Candidate[] } | null {
  const ordinal = level.nextSpawnOrdinal;
  const active = level.activeLearningWordIds.flatMap((id) => {
    const progress = level.words[id];
    return progress === undefined || !isEligible(progress, ordinal)
      ? []
      : [candidate(id, progress, ordinal)];
  });

  const repair = active.filter((entry) => entry.progress.reinforcementRemaining > 0);
  if (repair.length > 0) return { tier: "repair", candidates: repair };

  const learning = active.filter((entry) => entry.progress.appearanceWeight > 1);
  if (learning.length > 0) return { tier: "learning", candidates: learning };

  const fallback = Object.entries(level.words).flatMap(([id, progress]) =>
    progress.appearanceWeight === 1 && isEligible(progress, ordinal)
      ? [candidate(id, progress, ordinal)]
      : [],
  );
  return fallback.length > 0 ? { tier: "fallback", candidates: fallback } : null;
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chooseCandidate(candidates: Candidate[], rng: RandomSource): Candidate {
  const starved = candidates.filter((entry) => entry.eligibleAge >= ANTI_STARVATION_AGE);
  if (starved.length > 0) {
    starved.sort(
      (left, right) =>
        right.eligibleAge - left.eligibleAge ||
        right.progress.appearanceWeight - left.progress.appearanceWeight ||
        compareStableId(left.id, right.id),
    );
    const selected = starved[0];
    if (selected === undefined) throw new Error("Internal scheduler error: empty starvation tier");
    return selected;
  }

  const total = candidates.reduce((sum, entry) => sum + entry.effectiveWeight, 0);
  const unit = rng.nextUnit();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
    throw new RangeError("RandomSource.nextUnit() must return a finite value in [0, 1)");
  }
  let position = unit * total;
  for (const entry of candidates) {
    if (position < entry.effectiveWeight) return entry;
    position -= entry.effectiveWeight;
  }
  const selected = candidates[candidates.length - 1];
  if (selected === undefined) throw new Error("Internal scheduler error: empty candidate tier");
  return selected;
}

/**
 * Selects and cooldowns one word. The returned level contains the consumed RNG state;
 * callers must persist it rather than reusing the input level.
 */
export function spawnNextWord(
  sourceLevel: LevelProgress,
  deck: LearningDeck,
  sourceRng?: RandomSource,
): SpawnResult {
  const level = refillCurriculum(sourceLevel, deck);
  const ordinal = level.nextSpawnOrdinal;
  const selectedTier = eligibleTier(level);
  if (selectedTier === null) {
    const records = Object.values(level.words);
    return {
      status: "noEligibleWord",
      level,
      spawnOrdinal: ordinal,
      diagnostics: {
        activeCount: level.activeLearningWordIds.length,
        introducedCount: records.filter((progress) => progress.introducedAtOrdinal !== null).length,
        coolingCount: records.filter(
          (progress) =>
            progress.introducedAtOrdinal !== null && progress.nextEligibleSpawn > ordinal,
        ).length,
      },
    };
  }

  const rng = sourceRng ?? new Xoshiro128StarStar(level.schedulerRng);
  const selected = chooseCandidate(selectedTier.candidates, rng);
  const cooldown = drawCooldown(rng);
  const progress: WordProgress = {
    ...selected.progress,
    lastSpawnOrdinal: ordinal,
    nextEligibleSpawn: ordinal + cooldown + 1,
  };
  const nextLevel: LevelProgress = {
    ...level,
    nextSpawnOrdinal: ordinal + 1,
    schedulerRng: rng.state(),
    words: { ...level.words, [selected.id]: progress },
  };

  return {
    status: "spawned",
    level: nextLevel,
    wordId: selected.id,
    spawnOrdinal: ordinal,
    cooldown,
    tier: selectedTier.tier,
  };
}
