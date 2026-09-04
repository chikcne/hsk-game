import { describe, expect, it, test } from "vitest";
import {
  activeCharacter,
  activeWritableOrdinal,
  completedUnitCount,
  createWordWritingState,
  elapsedWritingMs,
  formatElapsedSeconds,
  presentationKey,
  writableUnitCount,
  writingReducer,
  type WordWritingState,
} from "../../src/client/writing/writingProgress";

const begin = (state: WordWritingState, nowMs: number) => writingReducer(state, { type: "begin-writing", nowMs });
const complete = (state: WordWritingState, index: number, nowMs: number, outcome: "written" | "skipped" | "missing" = "written") =>
  writingReducer(state, { type: "complete-unit", index, outcome, nowMs });

describe("word writing state", () => {
  test("a new card starts in an indefinite demo phase with no clock", () => {
    const state = createWordWritingState("你好", { newCard: true });
    expect(state.phase).toBe("demo");
    expect(state.startedAtMs).toBeNull();
    expect(state.activeIndex).toBe(0);
    expect(activeCharacter(state)).toBe("你");
    expect(writableUnitCount(state)).toBe(2);
    expect(elapsedWritingMs(state, 999)).toBeNull();
  });

  test("a later card starts writing immediately and the clock starts once", () => {
    const created = createWordWritingState("你好", { newCard: false });
    expect(created.phase).toBe("writing");
    const begun = begin(created, 1000);
    expect(begun.startedAtMs).toBe(1000);
    expect(begin(begun, 5000).startedAtMs).toBe(1000);
    expect(elapsedWritingMs(begun, 3250)).toBe(2250);
  });

  test("engaging from the demo phase starts writing and the clock", () => {
    const engaged = begin(createWordWritingState("你好", { newCard: true }), 800);
    expect(engaged.phase).toBe("writing");
    expect(engaged.startedAtMs).toBe(800);
    expect(begin(engaged, 2500).startedAtMs).toBe(800);
  });

  test("a later card's clock starts at the first stroke, not at completion", () => {
    // A later card is created in the writing phase but the clock is still
    // stopped until the player's first quiz stroke (correct or mistaken) so
    // the first character's writing time is counted.
    const created = createWordWritingState("你好", { newCard: false });
    expect(elapsedWritingMs(created, 5000)).toBeNull();
    const mistaken = begin(created, 4000);
    expect(mistaken.phase).toBe("writing");
    expect(mistaken.startedAtMs).toBe(4000);
    // Once running, later strokes and begin events keep the original start.
    expect(begin(mistaken, 8000).startedAtMs).toBe(4000);
  });

  test("completing units advances one character at a time until the word completes", () => {
    let state = begin(createWordWritingState("你好", { newCard: false }), 0);
    state = complete(state, 0, 4000);
    expect(state.activeIndex).toBe(1);
    expect(state.statuses[0]).toBe("done");
    expect(activeCharacter(state)).toBe("好");
    expect(state.phase).toBe("writing");
    state = complete(state, 1, 9000);
    expect(state.phase).toBe("complete");
    expect(state.activeIndex).toBe(-1);
    expect(state.completedAtMs).toBe(9000);
    expect(elapsedWritingMs(state, 123456)).toBe(9000);
  });

  test("completion is idempotent against duplicate writer callbacks and StrictMode", () => {
    const begun = begin(createWordWritingState("你好", { newCard: false }), 0);
    const once = complete(begun, 0, 2000);
    expect(complete(once, 0, 9999)).toBe(once);
    const wrongIndex = complete(begun, 1, 2000);
    expect(wrongIndex).toBe(begun);
  });

  test("skipping a character marks it, counts it, and still advances the word", () => {
    let state = begin(createWordWritingState("你好", { newCard: false }), 100);
    state = complete(state, 0, 200, "skipped");
    expect(state.statuses[0]).toBe("skipped");
    expect(state.skippedCount).toBe(1);
    expect(state.missingCount).toBe(0);
    expect(state.phase).toBe("writing");
    state = complete(state, 1, 700);
    expect(state.phase).toBe("complete");
    expect(elapsedWritingMs(state, 0)).toBe(600);
    expect(state.skippedCount).toBe(1);
  });

  test("a missing-data character is tracked separately from a player skip", () => {
    let state = begin(createWordWritingState("你好", { newCard: false }), 100);
    state = complete(state, 0, 200, "missing");
    expect(state.statuses[0]).toBe("missing");
    expect(state.missingCount).toBe(1);
    expect(state.skippedCount).toBe(0);
    expect(state.phase).toBe("writing");
    state = complete(state, 1, 500);
    expect(state.missingCount).toBe(1);
    expect(state.skippedCount).toBe(0);
    expect(completedUnitCount(state)).toBe(2);
  });

  test("skips and missing-data characters accumulate independently", () => {
    let state = begin(createWordWritingState("你好你", { newCard: false }), 0);
    state = complete(state, 0, 100, "skipped");
    state = complete(state, 1, 200);
    state = complete(state, 2, 300, "missing");
    expect(state.statuses).toEqual(["skipped", "done", "missing"]);
    expect(state.skippedCount).toBe(1);
    expect(state.missingCount).toBe(1);
  });

  test("finishing a whole word via skips still yields a usable clock", () => {
    const created = createWordWritingState("好", { newCard: true });
    const skipped = complete(created, 0, 5000, "skipped");
    expect(skipped.phase).toBe("complete");
    expect(elapsedWritingMs(skipped, 0)).toBe(0);
  });

  test("mistakes accumulate across characters", () => {
    let state = createWordWritingState("你好", { newCard: false });
    state = writingReducer(state, { type: "record-miss" });
    state = writingReducer(state, { type: "record-miss" });
    state = writingReducer(state, { type: "record-miss", count: 2 });
    expect(state.totalMisses).toBe(4);
  });

  test("non-Han units never become the writing target but fill the row", () => {
    const state = createWordWritingState("a 你", { newCard: false });
    expect(state.units).toEqual(["a", " ", "你"]);
    expect(state.statuses).toEqual(["done", "done", "pending"]);
    expect(state.activeIndex).toBe(2);
    expect(writableUnitCount(state)).toBe(1);
    expect(completedUnitCount(state)).toBe(2);
  });

  test("a phrase without writable characters completes immediately", () => {
    const state = createWordWritingState("!? ", { newCard: true });
    expect(state.phase).toBe("complete");
    expect(state.activeIndex).toBe(-1);
    expect(elapsedWritingMs(state, 0)).toBe(0);
  });

  test("reset swaps to a new word while keeping the machine total", () => {
    const played = complete(begin(createWordWritingState("你好", { newCard: true }), 10), 0, 20);
    const reset = writingReducer(played, { type: "reset", wordKey: "再见", newCard: false });
    expect(reset.wordKey).toBe("再见");
    expect(reset.phase).toBe("writing");
    expect(reset.startedAtMs).toBeNull();
    expect(reset.totalMisses).toBe(0);
    expect(reset.skippedCount).toBe(0);
    expect(reset.missingCount).toBe(0);
    expect(activeWritableOrdinal(reset)).toBe(1);
  });

  test("formatElapsedSeconds renders one decimal and clamps junk", () => {
    expect(formatElapsedSeconds(12_345)).toBe("12.3s");
    expect(formatElapsedSeconds(0)).toBe("0.0s");
    expect(formatElapsedSeconds(-5)).toBe("0.0s");
  });
});

describe("presentation keys", () => {
  it("changes per presentation so a RE-SERVED word remounts the WritingCard fresh", () => {
    // Same word served twice (the one-word Again/Hard/Good flow) must get a
    // different key, or the card would stay stuck in its completed phase.
    expect(presentationKey(0, "word-a")).toBe("0:word-a");
    expect(presentationKey(1, "word-a")).not.toBe(presentationKey(0, "word-a"));
    // Different words at the same generation also differ.
    expect(presentationKey(0, "word-b")).not.toBe(presentationKey(0, "word-a"));
    // Defensive against a nonsensical counter.
    expect(presentationKey(-3, "word-a")).toBe("0:word-a");
    expect(presentationKey(2.9, "word-a")).toBe("2:word-a");
  });
});
