import { describe, expect, it } from "vitest";
import { advanceEnemiesForRecallWindow } from "../../src/domain/session/landing";
import {
  masteryLevelFromAppearanceWeight,
  wordSpeedMultiplierFromAppearanceWeight,
} from "../../src/domain/session/speed";
import { selectLockedTarget, soonestLandingEnemy } from "../../src/domain/session/targeting";
import { calculatePoints, nextStreak } from "../../src/domain/session/scoring";
import {
  nextPerformanceMultiplier,
  performanceAdjustedSpawnDelayMs,
} from "../../src/domain/session/performance";
import type { Enemy } from "../../src/domain/session/types";

const enemy = (id: string, progress: number, spawnOrdinal: number, speedMultiplier = 1): Enemy => ({
  id,
  wordId: id,
  progress,
  speedMultiplier,
  isNewWord: false,
  spawnOrdinal,
  lane: 0,
  status: "descending",
});

describe("session rules", () => {
  it("scales alien speed up with word mastery", () => {
    expect(masteryLevelFromAppearanceWeight(100)).toBe(0);
    expect(masteryLevelFromAppearanceWeight(21)).toBe(80);
    expect(masteryLevelFromAppearanceWeight(1)).toBe(100);
    expect(wordSpeedMultiplierFromAppearanceWeight(100)).toBeCloseTo(0.65);
    expect(wordSpeedMultiplierFromAppearanceWeight(1)).toBeCloseTo(1.5);
    expect(wordSpeedMultiplierFromAppearanceWeight(30)).toBeGreaterThan(wordSpeedMultiplierFromAppearanceWeight(70));
  });

  it("targets predicted landing time rather than altitude, then breaks ties by age", () => {
    const lowerButSlow = enemy("slow", 0.8, 1, 0.5); // 0.4 base-travel units remain
    const higherButFast = enemy("fast", 0.6, 2, 2); // 0.2 base-travel units remain
    expect(soonestLandingEnemy([lowerButSlow, higherButFast])?.id).toBe("fast");
    expect(soonestLandingEnemy([enemy("a", 0.8, 1), enemy("b", 0.8, 2)])?.id).toBe("a");
  });

  it("keeps the selected word locked when a faster arrival spawns", () => {
    const selected = enemy("selected", 0.2, 1, 1);
    const fasterArrival = enemy("new", 0.9, 2, 2);
    expect(selectLockedTarget([selected, fasterArrival], selected.id)?.id).toBe(selected.id);
    expect(selectLockedTarget([fasterArrival], selected.id)?.id).toBe(fasterArrival.id);
  });

  it("advances each alien at its mastery-scaled speed", () => {
    const result = advanceEnemiesForRecallWindow(
      [enemy("slow", 0, 1, 0.5), enemy("fast", 0, 2, 1.5)],
      0.1,
      "slow",
      "pinyin",
      0,
      5_000,
    );
    expect(result.active.find((item) => item.id === "slow")?.progress).toBeCloseTo(0.05);
    expect(result.active.find((item) => item.id === "fast")?.progress).toBeCloseTo(0.15);
  });

  it("scores speed, pressure and streak", () => {
    expect(calculatePoints(2500, 0, 3000, 1)).toBe(400);
    expect(calculatePoints(12000, 0, 3000, 1)).toBe(200);
    expect(calculatePoints(2500, 10, 1500, 1.5)).toBeGreaterThan(400);
    expect(nextStreak(7, false, true)).toBe(7);
    expect(nextStreak(7, false, false)).toBe(0);
    expect(nextStreak(7, true, true)).toBe(8);
  });

  it("smoothly adapts pressure to current answer performance", () => {
    const fast = nextPerformanceMultiplier(1, true, 0, 8_000);
    const slow = nextPerformanceMultiplier(1, true, 16_000, 8_000);
    const miss = nextPerformanceMultiplier(1, false, 1_000, 8_000);
    expect(fast).toBeCloseTo(1.15);
    expect(slow).toBeCloseTo(0.91);
    expect(miss).toBeCloseTo(0.91);
  });

  it("multiplies configured pressure and fills an empty battlefield within half a second", () => {
    expect(performanceAdjustedSpawnDelayMs(3_000, 1.5, true)).toBe(2_000);
    expect(performanceAdjustedSpawnDelayMs(3_000, 0.75, true)).toBe(4_000);
    expect(performanceAdjustedSpawnDelayMs(5_000, 0.7, false)).toBe(500);
  });

  it("gives a selected word its full recall window and a two-second autocomplete grace period", () => {
    const nearGround = enemy("target", 0.99, 1);
    const early = advanceEnemiesForRecallWindow([nearGround], 0.02, nearGround.id, "pinyin", 1_000, 5_000);
    expect(early.autocompleted).toEqual([]);
    expect(early.active[0]?.progress).toBe(1);

    const timedOut = advanceEnemiesForRecallWindow(early.active, 0.02, nearGround.id, "pinyin", 5_000, 5_000);
    expect(timedOut.autocompleted).toEqual([]);
    expect(timedOut.active[0]?.pinyinTimeoutStartedAtMs).toBe(5_000);

    const graceElapsed = advanceEnemiesForRecallWindow(timedOut.active, 0, nearGround.id, "pinyin", 7_000, 5_000);
    expect(graceElapsed.landed).toEqual([]);
    expect(graceElapsed.autocompleted.map((item) => item.id)).toEqual([nearGround.id]);
  });

  it("moves every word up by 25% when a target is autocompleted", () => {
    const target = { ...enemy("target", 1, 1), pinyinTimeoutStartedAtMs: 5_000 };
    const other = enemy("other", 0.5, 2);
    const result = advanceEnemiesForRecallWindow([target, other], 0, target.id, "pinyin", 7_000, 5_000);
    expect(result.active.find((item) => item.id === target.id)?.progress).toBeCloseTo(0.75);
    expect(result.active.find((item) => item.id === other.id)?.progress).toBeCloseTo(0.25);
  });

  it("does not turn altitude during meaning selection into a recall failure", () => {
    const target = enemy("target", 1, 1);
    const result = advanceEnemiesForRecallWindow([target], 0.1, target.id, "meaning", 20_000, 5_000);
    expect(result.landed).toEqual([]);
    expect(result.active.map((item) => item.id)).toEqual([target.id]);
  });
});
