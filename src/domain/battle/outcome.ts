import type { BattleConfig, BattleOutcome } from "../../shared/battle";

/**
 * Mastery gain for a correct answer, read off the piecewise-linear speed curve
 * at `answerMs` — the answer timer that starts the moment a word becomes the
 * locked target and stops when the pinyin answer completes, so it measures
 * only the pinyin selection time, never the meaning phase.
 *
 * The curve is flat at `maxGain` up to `maxMs`, slopes to `midGain` at `midMs`,
 * then to `floorGain` at `floorMs`, and stays at `floorGain` beyond it. In live
 * play `floorMs` is never crossed while answering: it opens second chance
 * instead, whose gain is a separate configured constant.
 */
export function speedMasteryGain(answerMs: number, config: BattleConfig): number {
  const { maxMs, maxGain, midMs, midGain, floorMs, floorGain } = config.masteryCurve;
  if (answerMs <= maxMs) return maxGain;
  if (answerMs >= floorMs) return floorGain;
  const [fromMs, toMs, fromGain, toGain] = answerMs <= midMs
    ? [maxMs, midMs, maxGain, midGain]
    : [midMs, floorMs, midGain, floorGain];
  return Math.round(fromGain + (toGain - fromGain) * ((answerMs - fromMs) / (toMs - fromMs)));
}

/** True once the answer clock has reached the curve floor, at which point the
 * encounter escalates to second chance instead of scoring the floor gain. */
export function opensSecondChance(answerMs: number, config: BattleConfig): boolean {
  return answerMs >= config.masteryCurve.floorMs;
}

/**
 * Signed mastery change for one resolved encounter. A correct answer earns the
 * speed-curve gain; a correct answer given in second chance earns the flat
 * `secondChanceGain`; a wrong pinyin or meaning costs `masteryDelta` whenever
 * it happens. A word that reaches the ground unanswered is not an outcome at
 * all — it changes nothing and is never posted.
 */
export function masteryDeltaFor(outcome: BattleOutcome, config: BattleConfig): number {
  if (outcome.kind === "wrong") return -config.masteryDelta;
  if (outcome.kind === "secondChance") return config.masteryCurve.secondChanceGain;
  return speedMasteryGain(outcome.answerMs, config);
}

/** Pure client-side mirror of the server's mastery update, clamped to 0..100.
 * The server outcome is authoritative and replaces this optimistic value when
 * its response arrives.
 *
 * `time_mastered` is a server-only column (set the first time mastery reaches
 * 100, never cleared) and is not modeled here. */
export function applyMasteryOutcome(mastery: number, outcome: BattleOutcome, config: BattleConfig): number {
  return Math.max(0, Math.min(100, mastery + masteryDeltaFor(outcome, config)));
}

/** Altitude relief every OTHER word on the field receives when one word is
 * answered correctly: the smaller second-chance amount when the answer came in
 * second chance, and none at all for a wrong answer. */
export function reliefForCorrect(secondChance: boolean, config: BattleConfig): number {
  return secondChance ? config.relief.secondChance : config.relief.correct;
}
