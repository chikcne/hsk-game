import { describe, expect, it } from "vitest";
import { advanceEnemiesForRecallWindow } from "../../src/domain/session/landing";
import {
  masteryLevelFromAppearanceWeight,
  wordSpeedMultiplierFromAppearanceWeight,
} from "../../src/domain/session/speed";
import { selectLockedTarget, soonestLandingEnemy } from "../../src/domain/session/targeting";
import { calculatePoints } from "../../src/domain/session/scoring";
import type { Enemy } from "../../src/domain/session/types";

const enemy = (id: string, progress: number, spawnOrdinal: number, speedMultiplier = 1): Enemy => ({
  id,
  wordId: id,
  progress,
  speedMultiplier,
  spawnOrdinal,
  lane: 0,
  status: "descending",
});

describe("session rules", () => {
  it("scales alien speed up with word mastery", () => {
    expect(masteryLevelFromAppearanceWeight(100)).toBe(1);
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
  });

  it("gives a selected word the full pinyin recall window regardless of altitude", () => {
    const nearGround = enemy("target", 0.99, 1);
    const early = advanceEnemiesForRecallWindow([nearGround], 0.02, nearGround.id, "pinyin", 1_000, 5_000);
    expect(early.landed).toEqual([]);
    expect(early.active[0]?.progress).toBe(1);

    const timedOut = advanceEnemiesForRecallWindow(early.active, 0.02, nearGround.id, "pinyin", 5_000, 5_000);
    expect(timedOut.landed.map((item) => item.id)).toEqual([nearGround.id]);
  });

  it("does not turn altitude during meaning selection into a recall failure", () => {
    const target = enemy("target", 1, 1);
    const result = advanceEnemiesForRecallWindow([target], 0.1, target.id, "meaning", 20_000, 5_000);
    expect(result.landed).toEqual([]);
    expect(result.active.map((item) => item.id)).toEqual([target.id]);
  });
});
