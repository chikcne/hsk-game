import { describe, expect, it } from "vitest";
import { advanceEnemies, moveEnemiesUp } from "../../src/domain/session/landing";
import { wordSpeedMultiplierForFamiliarity } from "../../src/domain/session/speed";
import {
  battlefieldColumn,
  bottomMostEnemyInColumn,
  minimumTargetTravelTime,
  selectLockedTarget,
  soonestLandingEnemy,
} from "../../src/domain/session/targeting";
import { calculatePoints, nextStreak } from "../../src/domain/session/scoring";
import {
  emptyFieldWriteSchedule,
  gameplayWriteSchedule,
  masteryAdjustedSpawnDelayMs,
  nextPerformanceMultiplier,
  performanceAdjustedSpawnDelayMs,
} from "../../src/domain/session/performance";
import type { Enemy } from "../../src/domain/session/types";
import { BASE_TRAVEL_MS } from "../../src/shared/constants";

const enemy = (id: string, progress: number, spawnOrdinal: number, speedMultiplier = 1): Enemy => ({
  id,
  wordId: id,
  progress,
  speedMultiplier,
  isNewWord: false,
  spawnOrdinal,
  lane: 0,
  columnSlot: spawnOrdinal,
  status: "descending",
});

describe("session rules", () => {
  it("scales word speed with the 0..1 pressure value (review recency pressure)", () => {
    expect(wordSpeedMultiplierForFamiliarity(0)).toBeCloseTo(0.65);
    expect(wordSpeedMultiplierForFamiliarity(1)).toBeCloseTo(1.5);
    expect(wordSpeedMultiplierForFamiliarity(0.3)).toBeLessThan(wordSpeedMultiplierForFamiliarity(0.7));
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

  it("maps assigned slots to responsive columns and resolves a column to its live word", () => {
    const rightmost = enemy("rightmost", 0.25, 0);
    const nextColumn = enemy("next", 0.9, 1);
    const wideOnly = enemy("wide", 0.7, 6);
    const resolved = { ...enemy("resolved", 0.95, 2), status: "resolved" as const };

    expect(battlefieldColumn(rightmost, 12)).toBe(11);
    expect(battlefieldColumn(rightmost, 6)).toBe(5);
    expect(battlefieldColumn(nextColumn, 6)).toBe(4);
    expect(battlefieldColumn(wideOnly, 12)).toBe(5);
    expect(battlefieldColumn(wideOnly, 6)).toBe(5);
    expect(bottomMostEnemyInColumn([rightmost, nextColumn], 5, 6)?.id).toBe("rightmost");
    expect(bottomMostEnemyInColumn([rightmost, nextColumn], 4, 6)?.id).toBe("next");
    expect(bottomMostEnemyInColumn([rightmost, resolved], 9, 12)).toBeNull();
    expect(bottomMostEnemyInColumn([rightmost], 0, 6)).toBeNull();
  });

  it("expresses the two-second targeting floor in base-travel units", () => {
    expect(minimumTargetTravelTime(1)).toBeCloseTo(2000 / BASE_TRAVEL_MS);
    expect(minimumTargetTravelTime(0.9)).toBeCloseTo(0.075);
    expect(minimumTargetTravelTime(0)).toBe(0);
  });

  it("skips a landing inside the two-second floor for the next soonest answerable word", () => {
    const floor = minimumTargetTravelTime(0.9);
    const doomed = enemy("doomed", 0.97, 1);
    const answerable = enemy("answerable", 0.8, 2);
    const later = enemy("later", 0.1, 3);
    expect(soonestLandingEnemy([doomed, answerable, later], floor)?.id).toBe("answerable");
    expect(selectLockedTarget([doomed, answerable, later], null, floor)?.id).toBe("answerable");
  });

  it("selects the word with the most time left when every landing is inside the floor", () => {
    const floor = minimumTargetTravelTime(0.9);
    expect(soonestLandingEnemy([enemy("a", 0.99, 1), enemy("b", 0.96, 2)], floor)?.id).toBe("b");
    expect(soonestLandingEnemy([], floor)).toBeNull();
  });

  it("never drops a locked target that falls inside the floor", () => {
    const floor = minimumTargetTravelTime(0.9);
    const locked = enemy("locked", 0.99, 1);
    expect(selectLockedTarget([locked, enemy("fresh", 0.2, 2)], locked.id, floor)?.id).toBe("locked");
  });

  it("advances each word at its mastery-scaled speed", () => {
    const result = advanceEnemies([enemy("slow", 0, 1, 0.5), enemy("fast", 0, 2, 1.5)], 0.1);
    expect(result.vanished).toEqual([]);
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
    const fast = nextPerformanceMultiplier(1, true, 0);
    const slow = nextPerformanceMultiplier(1, true, 20_000);
    const miss = nextPerformanceMultiplier(1, false, 1_000);
    expect(fast).toBeCloseTo(1.15);
    expect(slow).toBeCloseTo(0.91);
    expect(miss).toBeCloseTo(0.91);
  });

  it("scales the next spawn timer from the previous word's mastery", () => {
    expect(masteryAdjustedSpawnDelayMs(5_000, 0)).toBe(8_000);
    expect(masteryAdjustedSpawnDelayMs(5_000, 50)).toBe(5_000);
    expect(masteryAdjustedSpawnDelayMs(5_000, 100)).toBe(2_000);
    expect(masteryAdjustedSpawnDelayMs(5_000, -10)).toBe(8_000);
    expect(masteryAdjustedSpawnDelayMs(5_000, 110)).toBe(2_000);
  });

  it("multiplies mastery-adjusted pressure and fills an empty battlefield within half a second", () => {
    expect(performanceAdjustedSpawnDelayMs(3_000, 1.5, true)).toBe(2_000);
    expect(performanceAdjustedSpawnDelayMs(3_000, 0.75, true)).toBe(4_000);
    expect(performanceAdjustedSpawnDelayMs(5_000, 1, true, 0)).toBe(8_000);
    expect(performanceAdjustedSpawnDelayMs(5_000, 1, true, 100)).toBe(2_000);
    expect(performanceAdjustedSpawnDelayMs(5_000, 0.7, false, 0)).toBe(500);
  });

  it("compresses an empty-board pre-write into the two-second budget but never gameplay writes", () => {
    // A short lead keeps natural cadence and lands after the due floor.
    expect(emptyFieldWriteSchedule(1_000, 500, 800)).toEqual({ spawnAtMs: 1_800, writeMs: 800, writeSpeed: 1 });
    // An 8-second lead compresses 4x to finish exactly at the budget.
    expect(emptyFieldWriteSchedule(0, 0, 8_000)).toEqual({ spawnAtMs: 2_000, writeMs: 2_000, writeSpeed: 4 });
    // Extreme leads clamp at the maximum speedup; spawn still honors the budget.
    const clamped = emptyFieldWriteSchedule(0, 0, 40_000);
    expect(clamped.writeSpeed).toBe(8);
    expect(clamped.spawnAtMs).toBe(2_000);
    // The due floor still delays a spawn even with no writing to do.
    expect(emptyFieldWriteSchedule(0, 5_000, 0).spawnAtMs).toBe(5_000);
    // Gameplay pacing is untouched: full lead, natural speed.
    expect(gameplayWriteSchedule(100, 6_000, 8_000)).toEqual({ spawnAtMs: 8_100, writeMs: 8_000, writeSpeed: 1 });
  });

  it("drops a word that reaches the ground, keeping the rest on the field", () => {
    const nearGround = enemy("gone", 0.99, 1);
    const high = enemy("high", 0.2, 2);
    const result = advanceEnemies([nearGround, high], 0.02);
    expect(result.vanished.map((item) => item.id)).toEqual([nearGround.id]);
    expect(result.vanished[0]?.progress).toBe(1);
    expect(result.active.map((item) => item.id)).toEqual([high.id]);
  });

  it("never parks a word at the landing line", () => {
    let active = [enemy("target", 0.5, 1)];
    for (let frame = 0; frame < 200 && active.length > 0; frame += 1) {
      const result = advanceEnemies(active, 0.01);
      for (const item of result.active) expect(item.progress).toBeLessThan(1);
      active = result.active;
    }
    expect(active).toEqual([]);
  });

  it("lifts the surviving words by the configured relief, never above the top", () => {
    const correctRelief = 0.1;
    const secondChanceRelief = 0.05;
    const wrongAnswerRelief = 0;
    const lifted = moveEnemiesUp([enemy("low", 0.9, 1), enemy("fresh", 0.04, 2)], correctRelief);
    expect(lifted.find((item) => item.id === "low")?.progress).toBeCloseTo(0.8);
    expect(lifted.find((item) => item.id === "fresh")?.progress).toBe(0);
    expect(moveEnemiesUp([enemy("low", 0.9, 1)], secondChanceRelief)[0]?.progress).toBeCloseTo(0.85);
    expect(moveEnemiesUp([enemy("low", 0.9, 1)], wrongAnswerRelief)[0]?.progress).toBeCloseTo(0.9);
  });
});
