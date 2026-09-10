import { BASE_TRAVEL_MS } from "../../shared/constants";
import type { Enemy } from "./types";

export const MIN_TARGET_TRAVEL_MS = 2000;

export function remainingTravelTime(enemy: Enemy): number {
  if (enemy.speedMultiplier <= 0 || !Number.isFinite(enemy.speedMultiplier)) return Number.POSITIVE_INFINITY;
  return Math.max(0, 1 - enemy.progress) / enemy.speedMultiplier;
}

export function minimumTargetTravelTime(globalSpeedMultiplier: number): number {
  if (globalSpeedMultiplier <= 0 || !Number.isFinite(globalSpeedMultiplier)) return 0;
  return MIN_TARGET_TRAVEL_MS * globalSpeedMultiplier / BASE_TRAVEL_MS;
}

/** Visual column occupied by an enemy. Columns are numbered left-to-right;
 * assigned slots fill from right-to-left and wrap at the current responsive
 * count. */
export function battlefieldColumn(enemy: Enemy, columnCount: number): number {
  return columnCount - 1 - (enemy.columnSlot % columnCount);
}

/** Resolves a column tap to its live word. Slot assignment keeps at most one
 * live word per column, so this is a lookup rather than a tie-break. */
export function bottomMostEnemyInColumn<T extends Enemy>(
  enemies: readonly T[],
  column: number,
  columnCount: number,
): T | null {
  if (!Number.isInteger(columnCount) || columnCount <= 0 || !Number.isInteger(column) || column < 0 || column >= columnCount) {
    return null;
  }
  let selected: T | null = null;
  for (const enemy of enemies) {
    if (enemy.status !== "descending" || battlefieldColumn(enemy, columnCount) !== column) continue;
    if (
      selected === null
      || enemy.progress > selected.progress
      || (enemy.progress === selected.progress && enemy.spawnOrdinal < selected.spawnOrdinal)
    ) selected = enemy;
  }
  return selected;
}

/** Selects by predicted time to ground, not by altitude. */
export function soonestLandingEnemy(enemies: readonly Enemy[], minimumTravelTime = 0): Enemy | null {
  let selected: Enemy | null = null;
  let selectedTime = Number.POSITIVE_INFINITY;
  let fallback: Enemy | null = null;
  let fallbackTime = Number.NEGATIVE_INFINITY;
  for (const enemy of enemies) {
    if (enemy.status !== "descending") continue;
    const landingTime = remainingTravelTime(enemy);
    if (landingTime > minimumTravelTime) {
      if (
        selected === null
        || landingTime < selectedTime
        || (landingTime === selectedTime && enemy.spawnOrdinal < selected.spawnOrdinal)
      ) {
        selected = enemy;
        selectedTime = landingTime;
      }
    } else if (
      fallback === null
      || landingTime > fallbackTime
      || (landingTime === fallbackTime && enemy.spawnOrdinal < fallback.spawnOrdinal)
    ) {
      fallback = enemy;
      fallbackTime = landingTime;
    }
  }
  return selected ?? fallback;
}

/** Keeps a live target locked. A newly spawned faster word cannot steal the
 * selection; prediction is run again only after the locked target disappears. */
export function selectLockedTarget(
  enemies: readonly Enemy[],
  lockedTargetId: string | null,
  minimumTravelTime = 0,
): Enemy | null {
  const locked = lockedTargetId === null
    ? undefined
    : enemies.find((enemy) => enemy.id === lockedTargetId && enemy.status === "descending");
  return locked ?? soonestLandingEnemy(enemies, minimumTravelTime);
}
