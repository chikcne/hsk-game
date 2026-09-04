import { Effect } from "effect";
import { InvalidRandomOutputError } from "../errors";
import type { RandomSource } from "./types";

export const MIN_COOLDOWN = 10;
export const MAX_COOLDOWN = 25;

/** Validates one draw against the `RandomSource` contract. */
function checkedUnitEffect(rng: RandomSource): Effect.Effect<number, InvalidRandomOutputError, never> {
  return Effect.suspend(() => {
    const value = rng.nextUnit();
    return Number.isFinite(value) && value >= 0 && value < 1
      ? Effect.succeed(value)
      : Effect.fail(new InvalidRandomOutputError());
  });
}

function nonZeroUnitEffect(rng: RandomSource): Effect.Effect<number, InvalidRandomOutputError, never> {
  return Effect.gen(function* () {
    let value = yield* checkedUnitEffect(rng);
    while (value === 0) value = yield* checkedUnitEffect(rng);
    return value;
  });
}

/** Typed variant of {@link drawCooldown}: fails with an
 * `InvalidRandomOutputError` when the source breaks its contract. */
export function drawCooldownEffect(rng: RandomSource): Effect.Effect<number, InvalidRandomOutputError, never> {
  return Effect.gen(function* () {
    for (;;) {
      const u1 = yield* nonZeroUnitEffect(rng);
      const u2 = yield* checkedUnitEffect(rng);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const candidate = Math.round(17.5 + 3.25 * z);
      if (candidate >= MIN_COOLDOWN && candidate <= MAX_COOLDOWN) return candidate;
    }
  });
}

/** Draws from N(17.5, 3.25), rejecting rather than clamping values outside 10..25.
 * Kept as a direct pure calculation because this is a scheduler hot path; the
 * typed Effect variant is available to fallible application workflows. */
export function drawCooldown(rng: RandomSource): number {
  const checkedUnit = (): number => {
    const value = rng.nextUnit();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("RandomSource.nextUnit() must return a finite value in [0, 1)");
    }
    return value;
  };
  for (;;) {
    let u1 = checkedUnit();
    while (u1 === 0) u1 = checkedUnit();
    const u2 = checkedUnit();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const candidate = Math.round(17.5 + 3.25 * z);
    if (candidate >= MIN_COOLDOWN && candidate <= MAX_COOLDOWN) return candidate;
  }
}
