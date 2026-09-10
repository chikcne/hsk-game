import type { Enemy } from "./types";

/** Slot space words are assigned into. Matches the widest responsive grid. */
export const COLUMN_SLOTS = 12;

/** Coarsest responsive column count. Every layout's count is a multiple of it,
 * so slots that differ modulo this value never share a column in any layout. */
export const COLUMN_PERIOD = 6;

/** Layout-independent identity of the column a slot lands in. */
export function columnClass(slot: number): number {
  return ((slot % COLUMN_PERIOD) + COLUMN_PERIOD) % COLUMN_PERIOD;
}

/** Column classes held by live words. A preparing word is already visible in
 * its column, so callers must include it. */
export function occupiedColumnClasses(enemies: readonly Enemy[]): Set<number> {
  const occupied = new Set<number>();
  for (const enemy of enemies) {
    if (enemy.status !== "descending") continue;
    occupied.add(columnClass(enemy.columnSlot));
  }
  return occupied;
}

/**
 * First free slot at or after `cursor`, scanning the slot space in spawn
 * order (right to left, wrapping). Returns null when every column already
 * holds a word: spawning waits instead of stacking two words in one column.
 */
export function nextFreeColumnSlot(enemies: readonly Enemy[], cursor: number): number | null {
  const occupied = occupiedColumnClasses(enemies);
  if (occupied.size >= COLUMN_PERIOD) return null;
  const start = ((cursor % COLUMN_SLOTS) + COLUMN_SLOTS) % COLUMN_SLOTS;
  for (let offset = 0; offset < COLUMN_SLOTS; offset += 1) {
    const slot = (start + offset) % COLUMN_SLOTS;
    if (!occupied.has(columnClass(slot))) return slot;
  }
  return null;
}
