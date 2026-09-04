import type { EncounterOutcome } from "./types";

/** Pure accounting for one resolved review encounter, keyed on whether the
 * pinyin was revealed by the recall window (autocomplete).
 *
 * A reveal-then-correct-meaning encounter is a MISS with a retry obligation,
 * even though the meaning answer stands and the battle continues: it scores
 * no points, does not continue the streak, and is excluded from the
 * summary's clean-recall accuracy. Only a clean encounter (typed pinyin +
 * correct meaning + no reveal) earns full credit in all three dimensions. */
export function encounterCredit(outcome: EncounterOutcome, revealed: boolean): {
  /** Counts toward the summary's ACCURACY (clean recalls only). */
  countsAsCorrect: boolean;
  /** Continues the running streak (a reveal resets it to zero). */
  streakContinues: boolean;
  /** Earns arcade points (a reveal scores exactly zero). */
  earnsPoints: boolean;
} {
  const clean = outcome.kind === "correct" && !revealed;
  return { countsAsCorrect: clean, streakContinues: clean, earnsPoints: clean };
}
