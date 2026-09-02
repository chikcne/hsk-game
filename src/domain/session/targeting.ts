import type { Enemy } from "./types";

export function remainingTravelTime(enemy: Enemy): number {
  if (enemy.speedMultiplier <= 0 || !Number.isFinite(enemy.speedMultiplier)) return Number.POSITIVE_INFINITY;
  return Math.max(0, 1 - enemy.progress) / enemy.speedMultiplier;
}

/** Selects by predicted time to ground, not by altitude. */
export function soonestLandingEnemy(enemies: readonly Enemy[]): Enemy | null {
  let selected: Enemy | null = null;
  let selectedTime = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    if (enemy.status !== "descending") continue;
    const landingTime = remainingTravelTime(enemy);
    if (
      selected === null
      || landingTime < selectedTime
      || (landingTime === selectedTime && enemy.spawnOrdinal < selected.spawnOrdinal)
    ) {
      selected = enemy;
      selectedTime = landingTime;
    }
  }
  return selected;
}

/** Keeps a live target locked. A newly spawned faster word cannot steal the
 * selection; prediction is run again only after the locked target disappears. */
export function selectLockedTarget(enemies: readonly Enemy[], lockedTargetId: string | null): Enemy | null {
  const locked = lockedTargetId === null
    ? undefined
    : enemies.find((enemy) => enemy.id === lockedTargetId && enemy.status === "descending");
  return locked ?? soonestLandingEnemy(enemies);
}
