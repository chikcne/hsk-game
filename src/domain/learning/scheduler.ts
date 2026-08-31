import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, WordProgress } from "../../shared/schemas";
import { type RandomSource, Xoshiro128StarStar } from "../random";
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
  return Math.max(0, spawnOrdinal - progress.nextEligibleSpawn);
}

export function effectiveAppearanceWeight(progress: WordProgress, spawnOrdinal: number): number {
  const age = eligibleAge(progress, spawnOrdinal);
  const ageBoost = 1 + Math.min(MAX_ELIGIBLE_AGE_BOOST, age / 100);
  return progress.appearanceWeight * ageBoost;
}

function candidate(id: string, progress: WordProgress, ordinal: number): Candidate {
  return { id, progress, eligibleAge: eligibleAge(progress, ordinal), effectiveWeight: effectiveAppearanceWeight(progress, ordinal) };
}

/** Returns the highest-priority eligible tier. Repair words stay urgent;
 * ordinary learning mixes practiced and completely new words. */
export function eligibleTier(
  level: LevelProgress,
  excludedWordIds: ReadonlySet<string> = new Set(),
): { tier: SpawnTier; candidates: Candidate[] } | null {
  const ordinal = level.nextSpawnOrdinal;
  const active = level.activeLearningWordIds.flatMap((id) => {
    const progress = level.words[id];
    return !progress || excludedWordIds.has(id) || !isEligible(progress, ordinal) ? [] : [candidate(id, progress, ordinal)];
  });
  const repair = active.filter((entry) => entry.progress.reinforcementRemaining > 0);
  if (repair.length > 0) return { tier: "repair", candidates: repair };

  const learning = active.filter((entry) => entry.progress.appearanceWeight > 1);
  if (learning.length > 0) return { tier: "learning", candidates: learning };

  const fallback = Object.entries(level.words).flatMap(([id, progress]) =>
    !excludedWordIds.has(id) && progress.appearanceWeight === 1 && isEligible(progress, ordinal)
      ? [candidate(id, progress, ordinal)] : [],
  );
  return fallback.length > 0 ? { tier: "fallback", candidates: fallback } : null;
}

function coolingTier(
  level: LevelProgress,
  excludedWordIds: ReadonlySet<string>,
): { tier: SpawnTier; candidates: Candidate[] } | null {
  const ordinal = level.nextSpawnOrdinal;
  const active = level.activeLearningWordIds.flatMap((id) => {
    const progress = level.words[id];
    return !progress || excludedWordIds.has(id) ? [] : [candidate(id, progress, ordinal)];
  });
  const repair = active.filter((entry) => entry.progress.reinforcementRemaining > 0);
  if (repair.length > 0) return { tier: "repair", candidates: repair };
  if (active.length > 0) return { tier: "learning", candidates: active };

  const fallback = Object.entries(level.words).flatMap(([id, progress]) =>
    !excludedWordIds.has(id) && progress.introducedAtOrdinal !== null && progress.appearanceWeight === 1
      ? [candidate(id, progress, ordinal)] : [],
  );
  return fallback.length > 0 ? { tier: "fallback", candidates: fallback } : null;
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chooseCandidate(candidates: Candidate[], rng: RandomSource, tier: SpawnTier): Candidate {
  const starved = candidates.filter((entry) => entry.eligibleAge >= ANTI_STARVATION_AGE);
  if (starved.length > 0) {
    starved.sort((left, right) => right.eligibleAge - left.eligibleAge || right.progress.appearanceWeight - left.progress.appearanceWeight || compareStableId(left.id, right.id));
    return starved[0]!;
  }

  let weighted = candidates.map((entry) => ({ entry, weight: entry.effectiveWeight }));
  if (tier === "learning") {
    const practicedTotal = candidates.reduce((sum, entry) => sum + (entry.progress.attempts > 0 ? entry.effectiveWeight : 0), 0);
    const newTotal = candidates.reduce((sum, entry) => sum + (entry.progress.attempts === 0 ? entry.effectiveWeight : 0), 0);
    if (practicedTotal > 0 && newTotal > 0) {
      // At pool level, practiced-but-unmastered words receive 55% of ordinary
      // learning spawns and completely new words receive 45%. Their mastery
      // weights still decide selection within each group.
      weighted = candidates.map((entry) => ({
        entry,
        weight: entry.progress.attempts > 0
          ? 0.55 * entry.effectiveWeight / practicedTotal
          : 0.45 * entry.effectiveWeight / newTotal,
      }));
    }
  }

  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  const unit = rng.nextUnit();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RangeError("RandomSource.nextUnit() must return a finite value in [0, 1)");
  let position = unit * total;
  for (const item of weighted) {
    if (position < item.weight) return item.entry;
    position -= item.weight;
  }
  return weighted[weighted.length - 1]!.entry;
}

/** Selects one regular-level word and reserves it against a simultaneous enemy.
 * The final outcome replaces this reservation with its response-based interval. */
export function spawnNextWord(
  sourceLevel: LevelProgress,
  deck: LearningDeck,
  sourceRng?: RandomSource,
  settings: DifficultySettings = DEFAULT_SETTINGS,
  excludedWordIds: ReadonlySet<string> = new Set(),
): SpawnResult {
  const level = refillCurriculum(sourceLevel, deck);
  const ordinal = level.nextSpawnOrdinal;
  // A small or completely missed pool can put every available card before its
  // due point. Falling back to the earliest cooling card keeps the arcade from
  // deadlocking; under ordinary load the due tier above remains authoritative.
  const selectedTier = eligibleTier(level, excludedWordIds) ?? coolingTier(level, excludedWordIds);
  if (selectedTier === null) {
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

  const rng = sourceRng ?? new Xoshiro128StarStar(level.schedulerRng);
  const selected = chooseCandidate(selectedTier.candidates, rng, selectedTier.tier);
  const cooldown = settings.mistakeRepeatPhrases;
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

  return { status: "spawned", level: nextLevel, wordId: selected.id, spawnOrdinal: ordinal, cooldown, tier: selectedTier.tier };
}
