import type { BattleConfig } from "../../shared/battle";

/** Pure client-side mirror of the server's mastery update: a clean correct
 * answer (typed/selected pinyin, correct meaning, no reveal) adds the delta;
 * a wrong pinyin, wrong meaning, reveal, or landing subtracts it. The result
 * is clamped to 0..100 — the server outcome is authoritative and replaces
 * this optimistic value when its response arrives.
 *
 * `time_mastered` is a server-only column (set the first time mastery
 * reaches 100, never cleared) and is not modeled here. */
export function applyMasteryOutcome(mastery: number, cleanCorrect: boolean, config: BattleConfig): number {
  const next = cleanCorrect ? mastery + config.masteryDelta : mastery - config.masteryDelta;
  return Math.max(0, Math.min(100, next));
}
