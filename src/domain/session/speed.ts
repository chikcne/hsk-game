import { Effect } from "effect";
import { runDomain } from "../effect";
import { NonFiniteNumberError } from "../errors";

const MIN_WORD_SPEED_MULTIPLIER = 0.65;
const MAX_WORD_SPEED_MULTIPLIER = 1.5;

export type WordSpeedMultiplierFailure = NonFiniteNumberError;

/** Typed variant of {@link wordSpeedMultiplierForFamiliarity}: fails with a
 * `NonFiniteNumberError` instead of throwing a `RangeError`. */
export function wordSpeedMultiplierForFamiliarityEffect(familiarity: number): Effect.Effect<number, WordSpeedMultiplierFailure, never> {
  return Effect.suspend(() =>
    Number.isFinite(familiarity)
      ? Effect.succeed(MIN_WORD_SPEED_MULTIPLIER + Math.min(1, Math.max(0, familiarity)) * (MAX_WORD_SPEED_MULTIPLIER - MIN_WORD_SPEED_MULTIPLIER))
      : Effect.fail(new NonFiniteNumberError({ param: "familiarity" })),
  );
}

/** Converts a 0..1 pressure value (review recency pressure) to player-facing
 * enemy speed. 0 (newest words) is gentlest; 1 is fastest. Review planning
 * scales the pressure range for eligible acquired-word pools below 100.
 *
 * Legacy throwing adapter: raises the same `RangeError` as before. */
export function wordSpeedMultiplierForFamiliarity(familiarity: number): number {
  return runDomain(wordSpeedMultiplierForFamiliarityEffect(familiarity));
}
