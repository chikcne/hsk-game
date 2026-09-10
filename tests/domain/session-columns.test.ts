import { describe, expect, it } from "vitest";
import {
  COLUMN_PERIOD,
  COLUMN_SLOTS,
  columnClass,
  nextFreeColumnSlot,
  occupiedColumnClasses,
} from "../../src/domain/session/columns";
import { battlefieldColumn } from "../../src/domain/session/targeting";
import type { Enemy } from "../../src/domain/session/types";

const enemy = (id: string, columnSlot: number, status: Enemy["status"] = "descending"): Enemy => ({
  id,
  wordId: id,
  progress: 0.5,
  speedMultiplier: 1,
  isNewWord: false,
  lane: 0,
  spawnOrdinal: columnSlot,
  columnSlot,
  status,
});

describe("battlefield column occupancy", () => {
  it("treats slots a period apart as the same column", () => {
    expect(columnClass(0)).toBe(columnClass(COLUMN_PERIOD));
    expect(columnClass(1)).not.toBe(columnClass(0));
    expect(battlefieldColumn(enemy("a", 0), 6)).toBe(battlefieldColumn(enemy("b", COLUMN_PERIOD), 6));
  });

  it("counts only live words as occupying a column", () => {
    const occupied = occupiedColumnClasses([enemy("live", 3), enemy("gone", 4, "resolved")]);
    expect([...occupied]).toEqual([columnClass(3)]);
  });

  it("marches right to left from the cursor and skips taken columns", () => {
    expect(nextFreeColumnSlot([], 0)).toBe(0);
    expect(nextFreeColumnSlot([enemy("a", 0)], 0)).toBe(1);
    expect(nextFreeColumnSlot([enemy("a", 1), enemy("b", 2)], 1)).toBe(3);
    expect(nextFreeColumnSlot([enemy("a", 0)], 11)).toBe(11);
  });

  it("wraps the cursor back to the first free column", () => {
    const live = Array.from({ length: COLUMN_PERIOD - 1 }, (_, index) => enemy(`e${index}`, index + 1));
    expect(nextFreeColumnSlot(live, COLUMN_SLOTS - 1)).toBe(0);
    expect(nextFreeColumnSlot(live, 1)).toBe(6);
  });

  it("returns no slot once every column holds a word", () => {
    const full = Array.from({ length: COLUMN_PERIOD }, (_, index) => enemy(`e${index}`, index));
    expect(nextFreeColumnSlot(full, 0)).toBeNull();
    expect(nextFreeColumnSlot(full, 7)).toBeNull();
  });

  it("never assigns a slot that shares a column with a live word in any layout", () => {
    const live = [enemy("a", 2), enemy("b", 9)];
    const slot = nextFreeColumnSlot(live, 8);
    expect(slot).not.toBeNull();
    for (const columnCount of [6, 12] as const) {
      const taken = live.map((item) => battlefieldColumn(item, columnCount));
      expect(taken).not.toContain(battlefieldColumn(enemy("next", slot!), columnCount));
    }
  });
});
