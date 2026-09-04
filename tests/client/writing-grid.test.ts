import { describe, expect, test } from "vitest";
import { toGridStrokeEvent } from "../../src/client/writing/WritingGrid";

/** hanzi-writer 3.7.3 passes `strokesRemaining = total - strokeNum - (isCorrect ? 1 : 0)`:
 * on a mistake the rejected stroke still counts as remaining, on a correct
 * stroke it is already consumed. `toGridStrokeEvent` must undo that exactly,
 * otherwise `totalStrokes` reads one too high on mistake callbacks. */

const writerData = (strokeNum: number, strokesRemaining: number) => ({
  strokeNum,
  strokesRemaining,
  mistakesOnStroke: 1,
  totalMistakes: 3,
  isBackwards: false,
});

describe("toGridStrokeEvent", () => {
  test("a correct stroke reconstructs the real stroke total", () => {
    // 4-stroke character, second stroke accepted: 1 correct + 2 remaining.
    const event = toGridStrokeEvent(writerData(1, 2), true);
    expect(event.totalStrokes).toBe(4);
    expect(event.strokeNum).toBe(1);
  });

  test("a mistaken stroke is not off by one", () => {
    // Same 4-stroke character, second stroke rejected: 1 consumed + 3 still
    // to do (the rejected one included).
    const event = toGridStrokeEvent(writerData(1, 3), false);
    expect(event.totalStrokes).toBe(4);
  });

  test("the last stroke reports 1 total whether accepted or not", () => {
    expect(toGridStrokeEvent(writerData(3, 0), true).totalStrokes).toBe(4);
    expect(toGridStrokeEvent(writerData(3, 1), false).totalStrokes).toBe(4);
  });

  test("the first stroke of a one-stroke character reports 1", () => {
    expect(toGridStrokeEvent(writerData(0, 0), true).totalStrokes).toBe(1);
    expect(toGridStrokeEvent(writerData(0, 1), false).totalStrokes).toBe(1);
  });

  test("miss and direction metadata pass through unchanged", () => {
    const event = toGridStrokeEvent({ ...writerData(2, 4), mistakesOnStroke: 2, totalMistakes: 5, isBackwards: true }, false);
    expect(event.mistakesOnStroke).toBe(2);
    expect(event.totalMistakes).toBe(5);
    expect(event.isBackwards).toBe(true);
  });
});
