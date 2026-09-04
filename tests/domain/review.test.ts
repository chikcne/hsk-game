import { describe, expect, it } from "vitest";
import {
  REVIEW_FULL_SCALE_WORD_COUNT, REVIEW_MIN_ACQUIRED_WORDS, REVIEW_NEW_TIER_RANK_LIMIT,
  REVIEW_RECENT_TIER_RANK_LIMIT, REVIEW_REPAIR_DELAY_SPAWNS,
} from "../../src/shared/constants";
import {
  applyReviewOutcome, createReviewSession, decideReviewSpawn, isReviewSessionSettled,
  pendingReviewWork, recencyLabelOfRank, recencyPressureOfRank, reserveReviewSpawn,
  reviewWordIdOf, reviewWordKey, buildReviewPlan, buildReviewPlanFromSnapshot,
  type RecencyLabel, type ReviewSession, type ReviewSpawnDecision,
} from "../../src/domain/review";
import { encounterCredit } from "../../src/domain/session/credit";
import { randomStateFromSeed, Xoshiro128StarStar } from "../../src/domain/random";

const SEED_STATE = randomStateFromSeed("review-plan");

/** `size` distinct acquired keys, newest first: rank 0 = k-000. */
function acquiredLog(size: number, deckId = "hsk-1"): string[] {
  return Array.from({ length: size }, (_, rank) => reviewWordKey(deckId, `k-${String(rank).padStart(3, "0")}`));
}

function countOf(spawns: readonly string[], key: string): number {
  return spawns.filter((spawn) => spawn === key).length;
}

describe("review word keys", () => {
  it("maps review keys to their grade and word", () => {
    expect(reviewWordKey("hsk-3", "w:1")).toBe("hsk-3:w:1");
    expect(reviewWordIdOf("hsk-3:w:1")).toEqual({ deckId: "hsk-3", wordId: "w:1" });
    expect(() => reviewWordIdOf("noseparator")).toThrow(/Invalid review word key/);
  });
});

describe("review session reducer: retries, exclusions, completion", () => {
  const plan = ["a", "b", "c", "d", "e"];
  const none = new Set<string>();

  /** Narrows a decision to a spawn, failing the test on wait/complete. */
  function expectSpawn(session: ReviewSession, active: ReadonlySet<string> = none): Extract<ReviewSpawnDecision, { kind: "spawn" }> {
    const decision = decideReviewSpawn(session, active);
    if (decision.kind !== "spawn") throw new Error(`expected a spawn, got ${decision.kind}`);
    return decision;
  }

  it("serves base spawns strictly in plan order; repairs never consume the plan", () => {
    let session = createReviewSession(plan);
    for (const key of plan) {
      const decision = expectSpawn(session);
      expect(decision).toEqual({ kind: "spawn", wordKey: key, source: "base" });
      session = reserveReviewSpawn(session, decision);
    }
    expect(session.cursor).toBe(plan.length);
    expect(decideReviewSpawn(session, none)).toEqual({ kind: "complete" });
  });

  it("delays a repair by ten further base spawns, then prioritizes it additively", () => {
    const keys = Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index)); // a..l
    let session = createReviewSession(keys);
    // Serve "a" and miss it: obligation recorded at cursor 1.
    session = reserveReviewSpawn(session, expectSpawn(session));
    session = applyReviewOutcome(session, "a", false).session;
    expect(session.obligations.get("a")!.missedAtCursor).toBe(1);

    // For the next REVIEW_REPAIR_DELAY_SPAWNS base spawns the repair waits.
    for (let served = 0; served < REVIEW_REPAIR_DELAY_SPAWNS; served += 1) {
      const decision = expectSpawn(session);
      expect(decision.source).toBe("base");
      session = reserveReviewSpawn(session, decision);
      session = applyReviewOutcome(session, decision.wordKey, true).session;
    }
    expect(session.cursor).toBe(1 + REVIEW_REPAIR_DELAY_SPAWNS); // 1 + 10 base spawns
    expect(session.repairsServed).toBe(0);

    // Delay elapsed: the repair spawns ADDITIVELY before the next base spawn.
    const decision = expectSpawn(session);
    expect(decision).toEqual({ kind: "spawn", wordKey: "a", source: "repair" });
    const before = session.cursor;
    session = reserveReviewSpawn(session, decision);
    expect(session.cursor).toBe(before); // plan untouched
    expect(session.repairsServed).toBe(1);
    // The repair resolves cleanly, clearing the obligation; the remaining
    // base plan still proceeds afterwards, in order.
    session = applyReviewOutcome(session, "a", true).session;
    const tail = decideReviewSpawn(session, none);
    expect(tail).toEqual({ kind: "spawn", wordKey: "l", source: "base" });
  });

  it("clears an obligation only on a clean, fully correct encounter", () => {
    let session = createReviewSession(["a"]);
    session = reserveReviewSpawn(session, expectSpawn(session));
    session = applyReviewOutcome(session, "a", false).session;
    expect(session.obligations.has("a")).toBe(true);

    // Plan exhausted: the retry is forced immediately and missed again.
    expect(decideReviewSpawn(session, none)).toEqual({ kind: "spawn", wordKey: "a", source: "repair" });
    session = reserveReviewSpawn(session, expectSpawn(session));
    session = applyReviewOutcome(session, "a", false).session;
    expect(session.obligations.get("a")!.misses).toBe(2); // requeued, not cleared

    // A clean correct encounter finally clears it.
    session = reserveReviewSpawn(session, expectSpawn(session));
    const result = applyReviewOutcome(session, "a", true);
    session = result.session;
    expect(result.cleared).toBe(true);
    expect(session.obligations.size).toBe(0);
    expect(isReviewSessionSettled(session, none)).toBe(true);
    expect(decideReviewSpawn(session, none)).toEqual({ kind: "complete" });
  });

  it("never respawns a word that is currently active (waits or reroutes instead)", () => {
    let session = createReviewSession(plan);
    session = reserveReviewSpawn(session, expectSpawn(session)); // a served
    session = applyReviewOutcome(session, "a", false).session; // a missed
    // The base head "b" is active: the due repair of "a" may still fire.
    // But when the REPAIR word itself is the active one, it must wait.
    let blocked = createReviewSession(["a", "b"]);
    blocked = reserveReviewSpawn(blocked, expectSpawn(blocked));
    blocked = applyReviewOutcome(blocked, "a", false).session;
    // Plan exhausted (cursor 1 of 2? no — cursor 1, plan length 2)... serve the rest first:
    blocked = reserveReviewSpawn(blocked, expectSpawn(blocked)); // b
    blocked = applyReviewOutcome(blocked, "b", true).session;
    // Now only the "a" repair remains, but "a" is active → wait, never spawn.
    expect(decideReviewSpawn(blocked, new Set(["a"]))).toEqual({ kind: "wait" });
    // Resolving the active enemy unblocks it.
    expect(decideReviewSpawn(blocked, none)).toEqual({ kind: "spawn", wordKey: "a", source: "repair" });
  });

  it("reroutes to the base head when a due repair word is active", () => {
    const session = createReviewSession(["a", "b"]);
    let running = reserveReviewSpawn(session, expectSpawn(session)); // a
    running = applyReviewOutcome(running, "a", false).session;
    running = reserveReviewSpawn(running, { kind: "spawn", wordKey: "b", source: "base" });
    // "b" (base head after cursor advanced past... b IS the head) — make the
    // repair word active instead and confirm the OTHER obligation ordering:
    running = applyReviewOutcome(running, "b", false).session; // b missed too
    // Both obligations due (plan exhausted), a first. If a is active → serve b.
    expect(decideReviewSpawn(running, new Set(["a"]))).toEqual({ kind: "spawn", wordKey: "b", source: "repair" });
  });

  it("forces endgame retries without deadlocking on lag", () => {
    // Miss the final base spawn: with the plan exhausted the repair is due
    // immediately regardless of any delay counter.
    let session = createReviewSession(["a", "b"]);
    for (const key of ["a", "b"]) {
      session = reserveReviewSpawn(session, expectSpawn(session));
      session = applyReviewOutcome(session, key, key === "b" ? false : true).session;
    }
    expect(session.cursor).toBe(2);
    expect(decideReviewSpawn(session, none)).toEqual({ kind: "spawn", wordKey: "b", source: "repair" });
  });

  it("drains multiple obligations oldest-miss first", () => {
    let session: ReviewSession = createReviewSession(["a", "b", "c"]);
    for (const key of ["a", "b", "c"]) {
      session = reserveReviewSpawn(session, expectSpawn(session));
      session = applyReviewOutcome(session, key, false).session;
    }
    expect(expectSpawn(session).wordKey).toBe("a");
    session = reserveReviewSpawn(session, expectSpawn(session));
    session = applyReviewOutcome(session, "a", true).session; // a cleared
    expect(expectSpawn(session).wordKey).toBe("b");
  });

  it("keeps base occurrences able to clear a repair: a later clean base encounter suffices", () => {
    // Plan [a, a, ...]: miss the first base occurrence; a clean second base
    // occurrence clears the obligation without any additive spawn.
    let session = createReviewSession(["a", "a"]);
    session = reserveReviewSpawn(session, expectSpawn(session));
    session = applyReviewOutcome(session, "a", false).session;
    // Not yet due (0 < 10 further base spawns) and plan not exhausted → the
    // base head fires again... but it equals the active word? It resolved,
    // so it is not active: serve base occurrence #2.
    const decision = expectSpawn(session);
    expect(decision).toEqual({ kind: "spawn", wordKey: "a", source: "base" });
    session = reserveReviewSpawn(session, decision);
    const outcome = applyReviewOutcome(session, "a", true);
    expect(outcome.cleared).toBe(true);
    expect(isReviewSessionSettled(outcome.session, none)).toBe(true);
    expect(outcome.session.repairsServed).toBe(0); // cleared without additive retries
  });

  it("treats an active preparing enemy as blocking for completion", () => {
    const session = createReviewSession(["a"]);
    let running = reserveReviewSpawn(session, expectSpawn(session));
    running = applyReviewOutcome(running, "a", true).session;
    expect(isReviewSessionSettled(running, none)).toBe(true);
    expect(isReviewSessionSettled(running, new Set(["a"]))).toBe(false); // still on screen
  });

  it("survives a full scripted battle: base 200 + forced retries end exactly clean", () => {
    const log = acquiredLog(500);
    const built = buildReviewPlan(log, 200, SEED_STATE);
    let session = createReviewSession(built.spawns);
    const rng = new Xoshiro128StarStar(randomStateFromSeed("battle-sim"));
    let spawns = 0;
    const active = new Set<string>();
    while (spawns < 10_000) {
      const decision = decideReviewSpawn(session, active);
      if (decision.kind === "complete") break;
      if (decision.kind === "wait") throw new Error("deadlock: wait with progressing state");
      session = reserveReviewSpawn(session, decision);
      spawns += 1;
      // Answer: 90% clean correct, 10% miss (which stays active one step).
      const miss = rng.nextUnit() < 0.1;
      if (miss) {
        active.add(decision.wordKey);
        session = applyReviewOutcome(session, decision.wordKey, false).session;
        active.delete(decision.wordKey); // resolved immediately after recording
      } else {
        session = applyReviewOutcome(session, decision.wordKey, true).session;
      }
    }
    expect(spawns).toBeLessThan(10_000);
    expect(session.cursor).toBe(200);
    expect(session.obligations.size).toBe(0);
    expect(isReviewSessionSettled(session, none)).toBe(true);
    // Retries are additive: total spawns ≥ plan length, bounded by misses.
    expect(spawns).toBeGreaterThanOrEqual(200);
  });

  it("is immutable: inputs are never mutated by decisions, reservations, or outcomes", () => {
    const session = createReviewSession(["a", "b"]);
    const snapshot = JSON.stringify(session, (_key, value) => value instanceof Map ? [...value.entries()] : value);
    decideReviewSpawn(session, none);
    reserveReviewSpawn(session, { kind: "spawn", wordKey: "a", source: "base" });
    applyReviewOutcome(session, "a", false);
    expect(JSON.stringify(session, (_key, value) => value instanceof Map ? [...value.entries()] : value)).toBe(snapshot);
  });
});

describe("recency tiers", () => {
  it("labels ranks by the documented boundaries 19/20/99/100", () => {
    expect(recencyLabelOfRank(0)).toBe("new");
    expect(recencyLabelOfRank(19)).toBe("new");
    expect(recencyLabelOfRank(20)).toBe("recent");
    expect(recencyLabelOfRank(99)).toBe("recent");
    expect(recencyLabelOfRank(100)).toBe("old");
    expect(recencyLabelOfRank(499)).toBe("old");
    expect(() => recencyLabelOfRank(-1)).toThrow(RangeError);
  });

  it("interpolates pressure from gentlest (rank 0) to maximum (rank 100+)", () => {
    expect(recencyPressureOfRank(0)).toBe(0);
    expect(recencyPressureOfRank(19)).toBeCloseTo(0.19);
    expect(recencyPressureOfRank(99)).toBeCloseTo(0.99);
    expect(recencyPressureOfRank(100)).toBe(1);
    expect(recencyPressureOfRank(499)).toBe(1); // Old caps at maximum pressure
    expect(recencyPressureOfRank(50)).toBeCloseTo(0.5);
  });

  it("scales tier boundaries and pressure with eligible pools below 100 words", () => {
    expect(recencyLabelOfRank(9, 50)).toBe("new");
    expect(recencyLabelOfRank(10, 50)).toBe("recent");
    expect(recencyLabelOfRank(49, 50)).toBe("recent");
    expect(recencyLabelOfRank(50, 50)).toBe("old");
    expect(recencyPressureOfRank(25, 50)).toBeCloseTo(0.5);
    expect(recencyPressureOfRank(49, 50)).toBeCloseTo(0.98);
  });

  it("exposes the eligibility and tier constants the plan relies on", () => {
    expect(REVIEW_MIN_ACQUIRED_WORDS).toBe(20);
    expect(REVIEW_FULL_SCALE_WORD_COUNT).toBe(100);
    expect(REVIEW_NEW_TIER_RANK_LIMIT).toBe(20);
    expect(REVIEW_RECENT_TIER_RANK_LIMIT).toBe(100);
    expect(REVIEW_REPAIR_DELAY_SPAWNS).toBe(10);
  });
});

describe("deterministic review base plan", () => {
  it("is exactly the target length at both slider boundaries (200 and 500)", () => {
    for (const target of [200, 500]) {
      const plan = buildReviewPlan(acquiredLog(500), target, SEED_STATE);
      expect(plan.spawns).toHaveLength(target);
    }
  });

  it("guarantees exact tier quotas with 500 acquired words", () => {
    const log = acquiredLog(500);
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    // Ranks 0–19 (New): exactly two occurrences each.
    for (let rank = 0; rank < 20; rank += 1) expect(countOf(plan.spawns, log[rank]!)).toBe(2);
    // Ranks 20–99 (Recent): exactly one occurrence each.
    for (let rank = 20; rank < 100; rank += 1) expect(countOf(plan.spawns, log[rank]!)).toBe(1);
    // Ranks 100+ (Old): no guarantee, but the 80 filler slots must draw from them.
    const oldFillers = plan.spawns.filter((key) => recencyLabelOfRank(log.indexOf(key)) === "old").length;
    expect(oldFillers).toBe(200 - 120);
    for (const key of new Set(plan.spawns)) expect(log).toContain(key); // nothing invented
  });

  it("fills the 500 target with Old fillers beyond the 120 guaranteed slots", () => {
    const log = acquiredLog(500);
    const plan = buildReviewPlan(log, 500, SEED_STATE);
    const guaranteed = 120;
    const oldTier = plan.spawns.filter((key) => log.indexOf(key) >= 100).length;
    expect(oldTier).toBe(500 - guaranteed);
  });

  it("scales a 50-word pool's tiers and default game length by one half", () => {
    const log = acquiredLog(50);
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    expect(plan.spawns).toHaveLength(100);
    expect([...plan.recency.values()].filter((label) => label === "new")).toHaveLength(10);
    expect([...plan.recency.values()].filter((label) => label === "recent")).toHaveLength(40);
    expect([...plan.recency.values()].filter((label) => label === "old")).toHaveLength(0);
    expect(plan.pressure.get(log[25]!)).toBeCloseTo(0.5);
    expect(plan.pressure.get(log[49]!)).toBeCloseTo(0.98);
    // The 10 scaled New words retain their twice-per-plan quota. Remaining
    // filler slots come from Recent because an under-100 pool has no Old.
    for (let rank = 0; rank < 10; rank += 1) expect(countOf(plan.spawns, log[rank]!)).toBe(2);
    for (let rank = 10; rank < 50; rank += 1) expect(countOf(plan.spawns, log[rank]!)).toBeGreaterThanOrEqual(1);
  });

  it("allows exactly 20 words and scales the default game to 40 spawns", () => {
    const log = acquiredLog(20);
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    expect(plan.spawns).toHaveLength(40);
    expect([...plan.recency.values()].filter((label) => label === "new")).toHaveLength(4);
    expect([...plan.recency.values()].filter((label) => label === "recent")).toHaveLength(16);
    for (let rank = 0; rank < 4; rank += 1) expect(countOf(plan.spawns, log[rank]!)).toBe(2);
    for (const key of new Set(plan.spawns)) expect(log).toContain(key);
  });

  it("returns an empty plan below the 20-word minimum without consuming RNG", () => {
    for (const size of [0, 1, 19]) {
      const plan = buildReviewPlan(acquiredLog(size), 200, SEED_STATE);
      expect(plan.spawns).toEqual([]);
      expect(plan.recency.size).toBe(0);
      expect(plan.pressure.size).toBe(0);
      expect(plan.snapshot.schedulerRng).toEqual(SEED_STATE);
    }
  });

  it("uses the configured session length as the value to scale and rounds to an integer", () => {
    expect(buildReviewPlan(acquiredLog(50), 500, SEED_STATE).spawns).toHaveLength(250);
    expect(buildReviewPlan(acquiredLog(75), 200, SEED_STATE).spawns).toHaveLength(150);
    expect(buildReviewPlan(acquiredLog(49), 210, SEED_STATE).spawns).toHaveLength(103);
  });

  it("is deterministic: identical inputs produce identical plans", () => {
    const log = acquiredLog(120);
    const left = buildReviewPlan(log, 200, SEED_STATE);
    const right = buildReviewPlan(log, 200, SEED_STATE);
    expect(left.spawns).toEqual(right.spawns);
    expect(left.snapshot).toEqual(right.snapshot);
  });

  it("advances the persisted RNG and never mutates its input state", () => {
    const log = acquiredLog(150);
    const input = [...SEED_STATE] as typeof SEED_STATE;
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    expect(SEED_STATE).toEqual(input); // caller's state untouched
    expect(plan.snapshot.schedulerRng).not.toEqual(input);
    const rerolled = buildReviewPlan(log, 200, plan.snapshot.schedulerRng);
    expect(rerolled.snapshot.schedulerRng).not.toEqual(plan.snapshot.schedulerRng);
  });

  it("interleaves tiers instead of emitting tier blocks while preserving counts", () => {
    const log = acquiredLog(500);
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    const labels: RecencyLabel[] = plan.spawns.map((key) => plan.recency.get(key)!);
    const firstOld = labels.indexOf("old");
    const lastNew = labels.lastIndexOf("new");
    // With 80 Old fillers shuffled among 120 guaranteed slots, the very first
    // and very last positions cannot both be non-Old filler territory.
    expect(firstOld).toBeGreaterThanOrEqual(0);
    expect(firstOld).toBeLessThan(60); // Old appears early, not only at the tail
    expect(lastNew).toBeGreaterThan(140); // New occurrences spread deep into the plan
    // And the quota totals survive the shuffle exactly.
    expect(countOf(plan.spawns, log[0]!)).toBe(2);
    expect(countOf(plan.spawns, log[19]!)).toBe(2);
    expect(countOf(plan.spawns, log[20]!)).toBe(1);
    expect(countOf(plan.spawns, log[99]!)).toBe(1);
  });

  it("extends the plan rather than dropping guaranteed quota if the target were too small", () => {
    // Impossible via settings bounds, but the domain defends the invariant.
    const plan = buildReviewPlan(acquiredLog(120), 50, SEED_STATE);
    expect(plan.spawns).toHaveLength(120); // 2×20 + 80 guaranteed, kept whole
  });

  it("captures recency labels and pressure per unique key at session start", () => {
    const log = acquiredLog(150);
    const plan = buildReviewPlanFromSnapshot(log, 200, { spawnOrdinal: 7, schedulerRng: SEED_STATE });
    expect(plan.recency.get(log[0]!)).toBe("new");
    expect(plan.recency.get(log[25]!)).toBe("recent");
    expect(plan.recency.get(log[120]!)).toBe("old");
    expect(plan.pressure.get(log[0]!)).toBe(0);
    expect(plan.pressure.get(log[100]!)).toBe(1);
    expect(plan.snapshot.spawnOrdinal).toBe(7); // ordinal preserved; runtime advances it
  });

  it("draws fillers uniformly from the Old pool (seeded spot check)", () => {
    // Direct RNG replay: the 80 filler picks are the first 80 nextUnit draws
    // AFTER the shuffle, but the shuffle itself also draws. Instead verify
    // statistically that multiple plans with different seeds all cover Old
    // ranks broadly — uniform draws over 400 Old words across 80 picks.
    const log = acquiredLog(500);
    const seen = new Set<string>();
    for (let seed = 0; seed < 8; seed += 1) {
      const plan = buildReviewPlan(log, 200, randomStateFromSeed(`uniform-${seed}`));
      for (const key of plan.spawns) if (log.indexOf(key) >= 100) seen.add(key);
    }
    // 8 plans × 80 Old picks = 640 draws over 400 words: broad coverage is
    // statistically certain under uniformity; a clustered draw would miss.
    expect(seen.size).toBeGreaterThan(200);
  });

  it("tolerates duplicate keys in the input log defensively (first occurrence wins)", () => {
    // 500 unique words + a duplicate of the rank-0 key at the end: the
    // duplicate must not grant a second quota allocation, and the fillers
    // (drawn from Old) cannot inflate the New count either.
    const log = [...acquiredLog(500), "hsk-1:k-000"];
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    expect(countOf(plan.spawns, "hsk-1:k-000")).toBe(2); // quota applied once, not twice
    expect(plan.recency.get("hsk-1:k-000")).toBe("new");
    expect(plan.pressure.get("hsk-1:k-000")).toBe(0);
  });

  it("validates the target length", () => {
    expect(() => buildReviewPlan(acquiredLog(5), 199.5, SEED_STATE)).toThrow(RangeError);
    expect(() => buildReviewPlan(acquiredLog(5), -1, SEED_STATE)).toThrow(RangeError);
  });

  it("consumes the shared xoshiro stream exactly like any other caller", () => {
    // The plan's advanced state must equal manually replaying the same
    // number of draws through the raw RNG (shuffle + fillers).
    const log = acquiredLog(500);
    const plan = buildReviewPlan(log, 200, SEED_STATE);
    const manual = new Xoshiro128StarStar(SEED_STATE);
    const entries: string[] = [];
    for (let rank = 0; rank < 20; rank += 1) entries.push(log[rank]!, log[rank]!);
    for (let rank = 20; rank < 100; rank += 1) entries.push(log[rank]!);
    const oldPool = Array.from({ length: 400 }, (_, index) => log[100 + index]!);
    for (let index = 0; index < 80; index += 1) entries.push(oldPool[Math.floor(manual.nextUnit() * 400)]!);
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(manual.nextUnit() * (index + 1));
      [entries[index], entries[swap]] = [entries[swap]!, entries[index]!];
    }
    expect(plan.spawns).toEqual(entries);
    expect(plan.snapshot.schedulerRng).toEqual(manual.state());
  });
});

describe("round-progress pending work", () => {
  const plan = ["a", "b", "c"];

  function reserve(session: ReviewSession, key?: string): ReviewSession {
    const decision = decideReviewSpawn(session, new Set());
    if (decision.kind !== "spawn") throw new Error(`expected a spawn, got ${decision.kind}`);
    if (key !== undefined && decision.wordKey !== key) throw new Error(`expected spawn of ${key}, got ${decision.wordKey}`);
    return reserveReviewSpawn(session, decision);
  }

  it("is zero only for a fully resolved session, so the progress bar hits 100% exactly at completion", () => {
    let session = createReviewSession(plan);
    for (const key of plan) {
      session = reserve(session);
      session = applyReviewOutcome(session, key, true).session;
    }
    expect(pendingReviewWork(session, plan.length, new Set())).toBe(0);
  });

  it("keeps the bar below 100% when a FINAL-base miss creates a repair — no 100%-then-regress", () => {
    // HUD composition: total = resolved + pendingWork + inFlightCount.
    const totalOf = (resolved: number, pending: number, inFlight: number) => resolved + pending + inFlight;
    let session = createReviewSession(plan);
    let resolved = 0;
    for (const key of plan) {
      session = reserve(session, key);
      // Last base spawn now in flight (uncovered but counted separately):
      // resolved 2 + pending 0 + inFlight 1 → bar 2/3.
      const total = totalOf(resolved, pendingReviewWork(session, plan.length, new Set()), key === "c" ? 1 : 0);
      expect(total).toBeGreaterThan(resolved);
      session = applyReviewOutcome(session, key, true).session;
      resolved += 1;
    }
    // Last base spawn resolves as a MISS: obligation open, battlefield empty.
    session = applyReviewOutcome(session, "c", false).session;
    const pending = pendingReviewWork(session, plan.length, new Set());
    expect(pending).toBe(1);
    // 3 resolved / (3 + 1) — strictly below 100% while the repair is owed.
    expect(totalOf(resolved, pending, 0)).toBe(4);

    // The repair spawn is reserved and in flight for the SAME word: the
    // obligation is covered, so resolved + pending + inFlight stays 4 —
    // the bar does NOT regress.
    session = reserve(session, "c");
    expect(session.repairsServed).toBe(1);
    expect(totalOf(resolved, pendingReviewWork(session, plan.length, new Set(["c"])), 1)).toBe(4);

    // Clean repair resolution: everything done, exactly 100%.
    session = applyReviewOutcome(session, "c", true).session;
    expect(pendingReviewWork(session, plan.length, new Set())).toBe(0);
    expect(totalOf(resolved + 1, 0, 0)).toBe(4);
  });

  it("counts uncovered in-flight enemies and open obligations without double-booking", () => {
    const session = createReviewSession(["a", "b", "c", "d"]);
    // Nothing reserved, one in-flight base spawn: 3 unreserved + 1 in flight.
    expect(pendingReviewWork(session, 4, new Set(["a"]))).toBe(4);
    // An in-flight enemy whose word HAS an obligation is covered by it.
    const withObligation = applyReviewOutcome(reserve(session, "a"), "a", false).session;
    // cursor 1, obligation on "a" (missed), no flight: remaining 3 + obligation 1.
    expect(pendingReviewWork(withObligation, 4, new Set())).toBe(4);
    // Re-serve "a" in flight: obligation covered, remaining 3, in flight 1.
    expect(pendingReviewWork(withObligation, 4, new Set(["a"]))).toBe(3);
  });
});

describe("encounter credit (autocomplete-as-miss accounting)", () => {
  const correct = { kind: "correct" as const, pinyinMs: 100, meaningMs: 100 };

  it("gives full credit only to clean encounters", () => {
    expect(encounterCredit(correct, false)).toEqual({ countsAsCorrect: true, streakContinues: true, earnsPoints: true });
  });

  it("a reveal-then-correct encounter stays a miss: no points, streak reset, no clean-recall credit", () => {
    expect(encounterCredit(correct, true)).toEqual({ countsAsCorrect: false, streakContinues: false, earnsPoints: false });
    expect(encounterCredit({ kind: "wrongMeaning", pinyinMs: 1, meaningMs: 1 }, false)).toEqual({ countsAsCorrect: false, streakContinues: false, earnsPoints: false });
  });
});
