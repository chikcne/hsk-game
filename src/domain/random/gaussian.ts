import type { RandomSource } from "./types";

export const MIN_COOLDOWN = 10;
export const MAX_COOLDOWN = 25;

function checkedUnit(rng: RandomSource): number {
  const value = rng.nextUnit();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("RandomSource.nextUnit() must return a finite value in [0, 1)");
  }
  return value;
}

function nonZeroUnit(rng: RandomSource): number {
  let value = checkedUnit(rng);
  while (value === 0) value = checkedUnit(rng);
  return value;
}

/** Draws from N(17.5, 3.25), rejecting rather than clamping values outside 10..25. */
export function drawCooldown(rng: RandomSource): number {
  for (;;) {
    const u1 = nonZeroUnit(rng);
    const u2 = checkedUnit(rng);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const candidate = Math.round(17.5 + 3.25 * z);
    if (candidate >= MIN_COOLDOWN && candidate <= MAX_COOLDOWN) return candidate;
  }
}
