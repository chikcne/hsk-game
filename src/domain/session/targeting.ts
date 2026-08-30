import type { Enemy } from "./types";
export function nearestEnemy(enemies: readonly Enemy[]): Enemy | null {
  return [...enemies]
    .filter((enemy) => enemy.status === "descending")
    .sort((left, right) => right.progress - left.progress || left.spawnOrdinal - right.spawnOrdinal)[0] ?? null;
}
