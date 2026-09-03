import type { DifficultySettings, LevelProgress } from "../../shared/schemas";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import {
  RESERVED_COOLDOWN_PHRASES,
  componentRetrievability,
  isGraduated,
  isMemoryDue,
  isRelearning,
  nextDueAtMs,
  wordFamiliarity,
} from "../memory";
import { type RandomSource, Xoshiro128StarStar } from "../random";
import type { LevelsMap, ReviewSpawnResult, SchedulerSnapshot } from "./types";

type Candidate = {
  deckId: string;
  wordId: string;
  progress: LevelProgress["words"][string];
  tier: "relearning" | "review";
  dueMs: number;
  retrievability: number;
};

function collectCandidates(levels: LevelsMap, ordinal: number, nowMs: number, excludedWordKeys: ReadonlySet<string>): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [deckId, level] of Object.entries(levels)) {
    if (!level) continue;
    for (const [wordId, progress] of Object.entries(level.words)) {
      const key = `${deckId}:${wordId}`;
      if (excludedWordKeys.has(key)) continue;
      if (progress.introducedAtOrdinal === null) continue;
      // Review mode serves graduated maintenance and lapsed repairs; new and
      // mid-learning words belong to their grade's regular mode.
      const tier = isRelearning(progress.pinyin) || isRelearning(progress.meaning)
        ? "relearning" as const
        : isGraduated(progress) ? "review" as const : null;
      if (tier === null) continue;
      if (progress.nextEligibleSpawn > ordinal) continue;
      if (!isMemoryDue(progress, nowMs)) continue;
      candidates.push({
        deckId, wordId, progress, tier,
        dueMs: nextDueAtMs(progress),
        retrievability: Math.min(
          componentRetrievability(progress.pinyin, nowMs),
          componentRetrievability(progress.meaning, nowMs),
        ),
      });
    }
  }
  return candidates;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Relearning repairs come first (earliest due); graduated maintenance is
 * ordered by lowest retrievability — the material closest to being forgotten.
 * Ties break on stable ID, then a uniform random pick. */
function pickCandidate(candidates: Candidate[], rng: RandomSource): Candidate {
  const topTier = candidates.filter((entry) => entry.tier === "relearning");
  const pool = topTier.length > 0 ? topTier : candidates;
  const sortKeyOf = (entry: Candidate): number => entry.tier === "relearning" ? entry.dueMs : entry.retrievability;
  const best = Math.min(...pool.map(sortKeyOf));
  const tied = pool.filter((entry) => sortKeyOf(entry) === best)
    .sort((left, right) => compareStable(`${left.deckId}:${left.wordId}`, `${right.deckId}:${right.wordId}`));
  return tied[Math.floor(rng.nextUnit() * tied.length)] ?? tied[tied.length - 1]!;
}

/**
 * Schedules one cross-grade review word from currently eligible cards.
 *
 * Unlike the old pool-based scheduler there are no fillers: a round contains
 * exactly the graduated/relearning cards whose FSRS due date has passed, and
 * it ends the moment nothing is due. Stale repair pools are structurally
 * impossible because relearning is per-card FSRS state, never a key list.
 */
export function spawnNextReviewWord(
  levels: LevelsMap,
  now: string | Date,
  snapshot: SchedulerSnapshot,
  excludedWordKeys: ReadonlySet<string> = new Set(),
  _settings: DifficultySettings = DEFAULT_SETTINGS,
): ReviewSpawnResult {
  const ordinal = snapshot.spawnOrdinal;
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid timestamp");

  const candidates = collectCandidates(levels, ordinal, nowMs, excludedWordKeys);
  if (candidates.length === 0) return { status: "complete", levels, snapshot };

  const rng = new Xoshiro128StarStar(snapshot.schedulerRng);
  const selected = pickCandidate(candidates, rng);
  const level = levels[selected.deckId]!;
  const reserved: LevelProgress["words"][string] = {
    ...selected.progress,
    lastSpawnOrdinal: ordinal,
    nextEligibleSpawn: ordinal + RESERVED_COOLDOWN_PHRASES + 1,
  };
  return {
    status: "spawned",
    levels: { ...levels, [selected.deckId]: { ...level, words: { ...level.words, [selected.wordId]: reserved } } },
    snapshot: { spawnOrdinal: ordinal + 1, schedulerRng: rng.state() },
    wordKey: `${selected.deckId}:${selected.wordId}`,
    spawnOrdinal: ordinal,
    tier: selected.tier,
    cooldownPhrases: RESERVED_COOLDOWN_PHRASES,
    familiarity: wordFamiliarity(selected.progress),
  };
}
