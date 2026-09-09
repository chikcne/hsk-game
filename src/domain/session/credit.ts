import type { EncounterOutcome } from "./types";

/** Pure accounting for one resolved battle encounter, keyed on whether the
 * answer arrived in second chance — the frozen, untimed mode a word enters once
 * its answer timer reaches the curve floor.
 *
 * A second-chance answer is not a clean recall even when it is right: the word
 * survives and its mastery is held flat, but it scores no points, does not
 * continue the streak, and is excluded from the summary's clean-recall
 * accuracy. Only an answer given before the floor earns credit in all three
 * dimensions. */
export function encounterCredit(outcome: EncounterOutcome, secondChance: boolean): {
  /** Counts toward the summary's ACCURACY (clean recalls only). */
  countsAsCorrect: boolean;
  /** Continues the running streak (second chance resets it to zero). */
  streakContinues: boolean;
  /** Earns arcade points (second chance scores exactly zero). */
  earnsPoints: boolean;
} {
  const clean = outcome.kind === "correct" && !secondChance;
  return { countsAsCorrect: clean, streakContinues: clean, earnsPoints: clean };
}
