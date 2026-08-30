import { describe, expect, it } from "vitest";
import {
  Xoshiro128StarStar,
  createSecureRandomState,
  drawCooldown,
  randomStateFromBytes,
  randomStateFromSeed,
  type RandomSource,
  type RandomState,
} from "../../src/domain/random";

class ScriptedRandom implements RandomSource {
  #index = 0;
  constructor(private readonly units: number[]) {}
  nextUnit(): number {
    const value = this.units[this.#index];
    if (value === undefined) throw new Error("script exhausted");
    this.#index += 1;
    return value;
  }
  nextUint32(): number {
    return Math.floor(this.nextUnit() * 0x1_0000_0000) >>> 0;
  }
  state(): RandomState {
    return [1, 2, 3, 4];
  }
  get consumed(): number {
    return this.#index;
  }
}

describe("Xoshiro128StarStar", () => {
  it("matches the reference first output and can resume exactly", () => {
    const rng = new Xoshiro128StarStar([1, 2, 3, 4]);
    expect(rng.nextUint32()).toBe(11_520);
    for (let index = 0; index < 100; index += 1) rng.nextUint32();
    const saved = rng.state();
    const resumed = new Xoshiro128StarStar(saved);
    expect(Array.from({ length: 100 }, () => resumed.nextUint32())).toEqual(
      Array.from({ length: 100 }, () => rng.nextUint32()),
    );
  });

  it("returns units in [0, 1) and defensive state copies", () => {
    const rng = new Xoshiro128StarStar(randomStateFromSeed("unit-range"));
    const values = Array.from({ length: 10_000 }, () => rng.nextUnit());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    const leaked = rng.state();
    leaked[0] = 0;
    expect(rng.state()).not.toEqual(leaked);
  });

  it("rejects malformed/all-zero state and repairs all-zero seed bytes", () => {
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow(/all-zero/);
    expect(() => new Xoshiro128StarStar([1, 2, 3, -1])).toThrow(/uint32/);
    expect(randomStateFromBytes(new Uint8Array(16))).toEqual([1, 0, 0, 0]);
    expect(() => randomStateFromBytes(new Uint8Array(15))).toThrow(/16/);
    expect(createSecureRandomState()).toHaveLength(4);
  });
});

describe("drawCooldown", () => {
  it("rejects out-of-range Gaussian samples instead of clamping", () => {
    const rng = new ScriptedRandom([1e-20, 0, 0.5, 0.25]);
    expect(drawCooldown(rng)).toBe(18);
    expect(rng.consumed).toBe(4);
  });

  it("rejects zero for log input and invalid RandomSource values", () => {
    const zeros = new ScriptedRandom([0, 0.5, 0.25]);
    expect(drawCooldown(zeros)).toBe(18);
    expect(zeros.consumed).toBe(3);
    expect(() => drawCooldown(new ScriptedRandom([1, 0]))).toThrow(/\[0, 1\)/);
    expect(() => drawCooldown(new ScriptedRandom([Number.NaN, 0]))).toThrow(/\[0, 1\)/);
  });

  it("has the expected broad truncated-Gaussian distribution", () => {
    const rng = new Xoshiro128StarStar(randomStateFromSeed("gaussian-100k"));
    const bins = new Map<number, number>();
    let sum = 0;
    for (let index = 0; index < 100_000; index += 1) {
      const value = drawCooldown(rng);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(25);
      sum += value;
      bins.set(value, (bins.get(value) ?? 0) + 1);
    }
    expect([...Array(16).keys()].map((offset) => bins.get(offset + 10) ?? 0).every(Boolean)).toBe(true);
    expect(sum / 100_000).toBeGreaterThan(17.35);
    expect(sum / 100_000).toBeLessThan(17.65);
    expect((bins.get(17) ?? 0) + (bins.get(18) ?? 0)).toBeGreaterThan(
      (bins.get(10) ?? 0) + (bins.get(25) ?? 0),
    );
  });
});
