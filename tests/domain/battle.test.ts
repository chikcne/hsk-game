import { describe, expect, it } from "vitest";
import {
  applyMasteryOutcome, battlePools, categoryShares, hillMatureRatio, isInPool,
  masteryCategory, matureCount, selectBattleSpawn, type BattleSpawnSelection,
} from "../../src/domain/battle";
import type { VocabRow } from "../../src/shared/battle";
import { randomStateFromSeed, Xoshiro128StarStar, type RandomSource } from "../../src/domain/random";

import type { BattleConfig } from "../../src/shared/battle";

/** The approved tuning, inlined as a fixture (runtime tuning lives only in
 * config/battle.yaml served by the server). */
const CONFIG: BattleConfig = {
  learningSlots: 5,
  boundaries: { lowMax: 50, developingMax: 99 },
  masteryDelta: 10,
  curve: { midpoint: 5, shape: 1.3 },
  asymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 },
};

/** A vocab row at curriculum position `id` (card id derived for readability:
 * c-001..). Mastery defaults to 0. */
function row(id: number, mastery = 0): VocabRow {
  return {
    id,
    cardId: `c-${String(id).padStart(4, "0")}`,
    mastery,
    timeAdded: "2026-01-01T00:00:00.000Z",
    timeMastered: mastery === 100 ? "2026-01-02T00:00:00.000Z" : null,
  };
}

/** `mature` rows with mastery 51..99 plus `masteredAt100` rows at 100, all
 * with ids above a base of `lowCount` seeded low rows. */
function vocabWith(mature: number, masteredAt100 = 0, lowCount = CONFIG.learningSlots): VocabRow[] {
  const rows: VocabRow[] = [];
  for (let id = 1; id <= lowCount; id += 1) rows.push(row(id, 0));
  let id = lowCount;
  for (let count = 0; count < mature; count += 1) rows.push(row(++id, 60));
  for (let count = 0; count < masteredAt100; count += 1) rows.push(row(++id, 100));
  return rows;
}

describe("mastery categories", () => {
  it("partitions mastery exactly at the approved boundaries 0..50 / 51..99 / 100", () => {
    expect(masteryCategory(0, CONFIG)).toBe("low");
    expect(masteryCategory(50, CONFIG)).toBe("low");
    expect(masteryCategory(51, CONFIG)).toBe("developing");
    expect(masteryCategory(99, CONFIG)).toBe("developing");
    expect(masteryCategory(100, CONFIG)).toBe("mastered");
  });

  it("honors custom boundaries from the config", () => {
    const custom: BattleConfig = { ...CONFIG, boundaries: { lowMax: 10, developingMax: 90 } };
    expect(masteryCategory(10, custom)).toBe("low");
    expect(masteryCategory(11, custom)).toBe("developing");
    expect(masteryCategory(91, custom)).toBe("mastered");
  });
});

describe("battle pools", () => {
  it("seeds exactly the five lowest-id low rows; mature rows are all present", () => {
    const vocab = [
      row(7, 40), row(2, 0), row(5, 50), row(1, 10), row(3, 51), row(4, 99), row(6, 100), row(8, 100),
    ];
    const pools = battlePools(vocab, CONFIG);
    expect(pools.low.map((item) => item.id)).toEqual([1, 2, 5, 7]);
    expect(pools.developing.map((item) => item.id)).toEqual([3, 4]);
    expect(pools.mastered.map((item) => item.id)).toEqual([6, 8]);
  });

  it("benches low rows beyond the learning slots and reports them outside the pool", () => {
    // Six low rows: ids 1..5 fill the slots, id 6 (mastery 30) is benched.
    const vocab = [row(1, 0), row(2, 20), row(3, 40), row(4, 10), row(5, 50), row(6, 30)];
    const pools = battlePools(vocab, CONFIG);
    expect(pools.low.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(isInPool(vocab[5]!, pools, CONFIG)).toBe(false);
    expect(isInPool(vocab[4]!, pools, CONFIG)).toBe(true);
  });

  it("models the ordered refill assumption: an appended curriculum row joins the low slots after a graduation", () => {
    // Server state: rows 1..5 seeded; row 2 graduated to 60 and the refill
    // appended curriculum position 6 at mastery 0 (id order = curriculum order).
    const before = [row(1, 0), row(2, 60), row(3, 0), row(4, 0), row(5, 0)];
    const poolsBefore = battlePools(before, CONFIG);
    expect(poolsBefore.low.map((item) => item.id)).toEqual([1, 3, 4, 5]);
    expect(matureCount(poolsBefore)).toBe(1);

    const after = [...before, row(6, 0)];
    const poolsAfter = battlePools(after, CONFIG);
    expect(poolsAfter.low.map((item) => item.id)).toEqual([1, 3, 4, 5, 6]);
    expect(poolsAfter.developing.map((item) => item.id)).toEqual([2]);
  });

  it("treats a graduated-then-dropped row (mastery back <= 50) as a low candidate by id order", () => {
    const vocab = [row(1, 0), row(2, 0), row(3, 0), row(4, 0), row(5, 0), row(6, 45)];
    const pools = battlePools(vocab, CONFIG);
    expect(pools.low.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("category weights (Hill curve, midpoint 5, shape 1.3)", () => {
  it("n = 0 yields exactly 100% low", () => {
    const shares = categoryShares(battlePools(vocabWith(0), CONFIG), CONFIG);
    expect(shares.low).toBe(1);
    expect(shares.developing).toBe(0);
    expect(shares.mastered).toBe(0);
  });

  it("n = 1 draws about 10% mature; n = 7 about 55%", () => {
    const n1 = categoryShares(battlePools(vocabWith(1), CONFIG), CONFIG);
    expect(n1.low).toBeCloseTo(1 - 0.9 * hillMatureRatio(1, CONFIG), 12);
    expect(n1.developing + n1.mastered).toBeGreaterThan(0.09);
    expect(n1.developing + n1.mastered).toBeLessThan(0.11);

    const n7 = categoryShares(battlePools(vocabWith(7), CONFIG), CONFIG);
    const matureShare = n7.developing + n7.mastered;
    expect(matureShare).toBeGreaterThan(0.54);
    expect(matureShare).toBeLessThan(0.56);
  });

  it("r is exactly 1/2 at the midpoint n = 5 and approaches the asymptote .10 low", () => {
    expect(hillMatureRatio(5, CONFIG)).toBeCloseTo(0.5, 12);
    const huge = categoryShares(battlePools(vocabWith(0, 5000), CONFIG), CONFIG);
    expect(huge.low).toBeCloseTo(0.1, 3);
    expect(huge.developing).toBeCloseTo(0, 12);
    expect(huge.mastered).toBeCloseTo(0.9, 3);
  });

  it("splits the mature total .50:.40 between developing and mastered", () => {
    const shares = categoryShares(battlePools(vocabWith(6, 6), CONFIG), CONFIG);
    const r = hillMatureRatio(12, CONFIG);
    expect(shares.developing).toBeCloseTo(r * 0.5, 12);
    expect(shares.mastered).toBeCloseTo(r * 0.4, 12);
    expect(shares.low + shares.developing + shares.mastered).toBeCloseTo(1, 12);
  });

  it("renormalizes absent categories: developing-only keeps the mature total; mastered-only takes it all", () => {
    const developingOnly = categoryShares(battlePools(vocabWith(4), CONFIG), CONFIG);
    const r = hillMatureRatio(4, CONFIG);
    expect(developingOnly.mastered).toBe(0);
    expect(developingOnly.developing).toBeCloseTo(r * 0.9, 12);
    expect(developingOnly.low).toBeCloseTo(1 - r * 0.9, 12);

    const masteredOnly = categoryShares(battlePools(vocabWith(0, 4), CONFIG), CONFIG);
    expect(masteredOnly.developing).toBe(0);
    expect(masteredOnly.mastered).toBeCloseTo(r * 0.9, 12);
  });

  it("ceding low (empty pool) renormalizes the mature categories over the whole draw", () => {
    // Pathological state with no low rows at all.
    const shares = categoryShares(battlePools([row(1, 60), row(2, 100)], CONFIG), CONFIG);
    expect(shares.low).toBe(0);
    expect(shares.developing).toBeCloseTo(0.5 / 0.9, 12);
    expect(shares.mastered).toBeCloseTo(0.4 / 0.9, 12);
  });
});

describe("live spawn selection", () => {
  const seed = () => new Xoshiro128StarStar(randomStateFromSeed("battle-select"));

  it("spawns only pool members, never benched low rows", () => {
    const vocab = [row(1, 0), row(2, 20), row(3, 40), row(4, 10), row(5, 50), row(6, 30), row(7, 60)];
    const rng = seed();
    const seen = new Set<string>();
    for (let draw = 0; draw < 300; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, new Set());
      expect(selection).not.toBeNull();
      seen.add(selection!.row.cardId);
    }
    expect(seen.has("c-0006")).toBe(false); // benched low row
    for (const cardId of ["c-0001", "c-0002", "c-0003", "c-0004", "c-0005", "c-0007"]) {
      expect(seen.has(cardId)).toBe(true);
    }
  });

  it("never selects an active or preparing word: exclusions hold concurrently", () => {
    const vocab = vocabWith(2, 2);
    const rng = seed();
    const active = new Set(["c-0001", "c-0002", "c-0003", "c-0004", "c-0005"]);
    for (let draw = 0; draw < 100; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, active);
      expect(selection).not.toBeNull();
      expect(active.has(selection!.row.cardId)).toBe(false);
    }
    // With EVERY pool member active there is nothing left to spawn.
    const all = new Set(vocab.map((item) => item.cardId));
    expect(selectBattleSpawn(vocab, CONFIG, rng, all)).toBeNull();
  });

  it("renormalizes over categories that still have an idle member", () => {
    // Idle: only mastered rows. Every draw must come from mastered.
    const vocab = vocabWith(3, 3);
    const active = new Set([
      "c-0001", "c-0002", "c-0003", "c-0004", "c-0005",
      "c-0006", "c-0007", "c-0008", // developing excluded
    ]);
    const rng = seed();
    for (let draw = 0; draw < 50; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, active);
      expect(selection!.category).toBe("mastered");
    }
  });

  it("is deterministic under an injected seeded RNG and consumes two draws per call", () => {
    const vocab = vocabWith(4, 3, 3);
    const run = (): Array<BattleSpawnSelection | null> => {
      const rng = seed();
      return Array.from({ length: 25 }, () => selectBattleSpawn(vocab, CONFIG, rng, new Set()));
    };
    expect(run()).toEqual(run());

    // A counting RNG proves the draw count: category then member.
    let draws = 0;
    const counting: RandomSource = {
      nextUint32: () => 0,
      nextUnit: () => { draws += 1; return 0.25; },
      state: () => randomStateFromSeed("x"),
    };
    selectBattleSpawn(vocab, CONFIG, counting, new Set());
    expect(draws).toBe(2);
  });

  it("is uniform within the selected category (all five seeds appear from a fresh save)", () => {
    const vocab = vocabWith(0); // fresh save: five low rows, n = 0
    const rng = seed();
    const counts = new Map<string, number>();
    for (let draw = 0; draw < 5000; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, new Set());
      expect(selection!.category).toBe("low");
      counts.set(selection!.row.cardId, (counts.get(selection!.row.cardId) ?? 0) + 1);
    }
    expect(counts.size).toBe(5);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(5000 / 5 - 250);
      expect(count).toBeLessThan(5000 / 5 + 250);
    }
  });
});

describe("mastery outcome delta", () => {
  it("adds the delta on a clean correct and subtracts on any miss, clamped 0..100", () => {
    expect(applyMasteryOutcome(40, true, CONFIG)).toBe(50);
    expect(applyMasteryOutcome(95, true, CONFIG)).toBe(100);
    expect(applyMasteryOutcome(100, true, CONFIG)).toBe(100);
    expect(applyMasteryOutcome(5, false, CONFIG)).toBe(0);
    expect(applyMasteryOutcome(0, false, CONFIG)).toBe(0);
    expect(applyMasteryOutcome(60, false, CONFIG)).toBe(50);
  });

  it("reaches exactly 100 from 0 after ten clean corrects (time_mastered trigger point)", () => {
    let mastery = 0;
    for (let step = 0; step < 9; step += 1) mastery = applyMasteryOutcome(mastery, true, CONFIG);
    expect(mastery).toBe(90);
    expect(applyMasteryOutcome(mastery, true, CONFIG)).toBe(100);
  });
});
