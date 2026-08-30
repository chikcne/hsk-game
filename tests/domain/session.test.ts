import { describe, expect, it } from "vitest";
import { nearestEnemy } from "../../src/domain/session/targeting";
import { calculatePoints } from "../../src/domain/session/scoring";
import type { Enemy } from "../../src/domain/session/types";
const enemy = (id: string, progress: number, spawnOrdinal: number): Enemy => ({ id, wordId: id, progress, spawnOrdinal, lane: 0, status: "descending" });
describe("session rules", () => {
  it("targets nearest, then oldest", () => { expect(nearestEnemy([enemy("a",.4,1), enemy("b",.8,2)])?.id).toBe("b"); expect(nearestEnemy([enemy("a",.8,1), enemy("b",.8,2)])?.id).toBe("a"); });
  it("scores speed, pressure and streak", () => { expect(calculatePoints(2500,0,3000,1)).toBe(400); expect(calculatePoints(12000,0,3000,1)).toBe(200); expect(calculatePoints(2500,10,1500,1.5)).toBeGreaterThan(400); });
});
