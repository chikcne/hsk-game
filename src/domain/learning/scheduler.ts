import type { DifficultySettings, LevelProgress, WordProgress } from "../../shared/schemas";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import { RESERVED_COOLDOWN_PHRASES, isMemoryDue, isUnseenWord, nextDueAtMs, wordFamiliarity } from "../memory";
import { type RandomSource, Xoshiro128StarStar } from "../random";
import { introduceNewWords } from "./curriculum";
import { acquisitionWordIds } from "./progress";
import type { RegularSpawnResult, SchedulerSnapshot, SpawnTier, LearningDeck } from "./types";

/** When nothing is eligible, a regular session waits this long for the next
 * FSRS due date before ending itself. Ordinal-only blockage (cooling words)
 * never counts toward the horizon: the caller advances ordinals instead. */
export const SESSION_WAIT_HORIZON_MS = 120_000;

const TIER_PRIORITY: Record<SpawnTier, number> = { relearning: 0, learning: 1, new: 2, review: 3 };

export function spawnTierOf(progress: WordProgress): SpawnTier {
  if (progress.pinyin.state === "relearning" || progress.meaning.state === "relearning") return "relearning";
  if (progress.pinyin.state === "learning" || progress.meaning.state === "learning") return "learning";
  if (progress.pinyin.state === "new" && progress.meaning.state === "new") return "new";
  return "review";
}

type Candidate = { id: string; progress: WordProgress; tier: SpawnTier; dueMs: number };

function collectCandidates(level: LevelProgress, ordinal: number, nowMs: number, excludedWordIds: ReadonlySet<string>): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [id, progress] of Object.entries(level.words)) {
    if (progress.introducedAtOrdinal === null) continue;
    if (excludedWordIds.has(id)) continue;
    if (progress.nextEligibleSpawn > ordinal) continue;
    if (!isMemoryDue(progress, nowMs)) continue;
    candidates.push({ id, progress, tier: spawnTierOf(progress), dueMs: nextDueAtMs(progress) });
  }
  return candidates;
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Highest-priority tier first, then earliest due, then a uniform random pick
 * among exact ties. Deterministic given the scheduler RNG state. */
function pickCandidate(candidates: Candidate[], rng: RandomSource): Candidate {
  const topPriority = Math.min(...candidates.map((entry) => TIER_PRIORITY[entry.tier]));
  const topTier = candidates.filter((entry) => TIER_PRIORITY[entry.tier] === topPriority);
  const earliest = Math.min(...topTier.map((entry) => entry.dueMs));
  const due = topTier.filter((entry) => entry.dueMs === earliest)
    .sort((left, right) => compareStableId(left.id, right.id));
  return due[Math.floor(rng.nextUnit() * due.length)] ?? due[due.length - 1]!;
}

function isoTime(value: string | Date): number {
  const time = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(time)) throw new RangeError("now must be a valid timestamp");
  return time;
}

/**
 * Selects one regular-mode word. A word spawns only when ALL of the following
 * hold — none may be bypassed:
 *
 * 1. it has been introduced into the grade;
 * 2. its FSRS due date has passed (`pinyin`/`meaning` whichever is weaker) —
 *    graduated words therefore appear only for due maintenance;
 * 3. its ordinal cooldown has elapsed (`nextEligibleSpawn`);
 * 4. it is not already an active enemy.
 *
 * When nothing is eligible the scheduler reports `empty` (plus whether the
 * blockage is ordinal-only) or `complete` when nothing comes due within the
 * session horizon. It never selects a cooling or not-yet-due word.
 */
export function spawnNextWord(
  level: LevelProgress,
  deck: LearningDeck,
  now: string | Date,
  snapshot: SchedulerSnapshot,
  settings: DifficultySettings = DEFAULT_SETTINGS,
  excludedWordIds: ReadonlySet<string> = new Set(),
): RegularSpawnResult {
  const { level: poolLevel } = introduceNewWords(level, deck, settings.levelSize, snapshot.spawnOrdinal);
  const ordinal = snapshot.spawnOrdinal;
  const nowMs = isoTime(now);

  const candidates = collectCandidates(poolLevel, ordinal, nowMs, excludedWordIds);
  if (candidates.length > 0) {
    const rng = new Xoshiro128StarStar(snapshot.schedulerRng);
    const selected = pickCandidate(candidates, rng);
    const reserved: WordProgress = {
      ...selected.progress,
      lastSpawnOrdinal: ordinal,
      // Overwritten with the resolution cooldown when the outcome lands; this
      // placeholder only matters if the session ends mid-flight.
      nextEligibleSpawn: ordinal + RESERVED_COOLDOWN_PHRASES + 1,
    };
    return {
      status: "spawned",
      level: { ...poolLevel, words: { ...poolLevel.words, [selected.id]: reserved } },
      snapshot: { spawnOrdinal: ordinal + 1, schedulerRng: rng.state() },
      wordId: selected.id,
      spawnOrdinal: ordinal,
      tier: selected.tier,
      cooldownPhrases: RESERVED_COOLDOWN_PHRASES,
      familiarity: wordFamiliarity(selected.progress),
      unseen: isUnseenWord(selected.progress),
    };
  }

  // Nothing eligible. Distinguish "a due word exists but cannot spawn yet"
  // (cooling or reserved for an active enemy — keep the session alive; the
  // caller advances ordinals on the empty-field clock) from "nothing due
  // within the horizon" (end it).
  let coolingOnly = false;
  let blockedUntilOrdinal: number | null = null;
  let soonestFutureDueMs = Infinity;
  for (const [id, progress] of Object.entries(poolLevel.words)) {
    if (progress.introducedAtOrdinal === null) continue;
    if (isMemoryDue(progress, nowMs)) {
      if (excludedWordIds.has(id) || progress.nextEligibleSpawn > ordinal) {
        coolingOnly = true;
        blockedUntilOrdinal = Math.min(blockedUntilOrdinal ?? Infinity, progress.nextEligibleSpawn);
      }
      continue;
    }
    soonestFutureDueMs = Math.min(soonestFutureDueMs, nextDueAtMs(progress));
  }
  if (coolingOnly) {
    return {
      status: "empty", level: poolLevel, snapshot, coolingOnly: true,
      ...(blockedUntilOrdinal === null ? {} : { blockedUntilOrdinal }),
    };
  }
  if (Number.isFinite(soonestFutureDueMs) && soonestFutureDueMs <= nowMs + SESSION_WAIT_HORIZON_MS) {
    return { status: "empty", level: poolLevel, snapshot, coolingOnly: false };
  }
  return { status: "complete", level: poolLevel, snapshot };
}

/** Advances the global spawn counter without reserving a word. Callers use it
 * to let ordinal cooldowns elapse while the battlefield is empty, so a due
 * word becomes spawnable again without ever spawning early. Passing `to`
 * fast-forwards straight to a target ordinal (never backwards) — the cooldown
 * invariant still holds because eligibility keeps comparing against
 * `nextEligibleSpawn`; only the idle per-ordinal waiting disappears. */
export function advanceOrdinal(snapshot: SchedulerSnapshot, to?: number): SchedulerSnapshot {
  if (to === undefined) return { ...snapshot, spawnOrdinal: snapshot.spawnOrdinal + 1 };
  const target = Math.trunc(to);
  if (!Number.isFinite(target)) throw new RangeError("target ordinal must be finite");
  return { ...snapshot, spawnOrdinal: Math.max(snapshot.spawnOrdinal, target) };
}
