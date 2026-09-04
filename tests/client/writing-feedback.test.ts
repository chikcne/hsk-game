import { describe, expect, test } from "vitest";
import {
  audioFailureFeedback,
  correctStrokeFeedback,
  demoPromptFeedback,
  mistakeFeedback,
  missingDataFeedback,
  nextStrokeFeedback,
} from "../../src/client/writing/writingFeedback";

describe("writing feedback", () => {
  test("the first shape mistake asks for another try", () => {
    const feedback = mistakeFeedback({ strokeNum: 2, totalStrokes: 8, mistakesOnStroke: 1, isBackwards: false });
    expect(feedback.tone).toBe("info");
    expect(feedback.message).toContain("stroke 3 of 8");
  });

  test("a backwards stroke gets a direction hint while the shape was good", () => {
    const feedback = mistakeFeedback({ strokeNum: 0, totalStrokes: 4, mistakesOnStroke: 1, isBackwards: true });
    expect(feedback.tone).toBe("gentle");
    expect(feedback.message).toMatch(/direction/);
  });

  test("the second miss points at the highlighted stroke", () => {
    const feedback = mistakeFeedback({ strokeNum: 5, totalStrokes: 9, mistakesOnStroke: 2, isBackwards: false });
    expect(feedback.tone).toBe("gentle");
    expect(feedback.message).toContain("highlighted");
    expect(feedback.message).toContain("Stroke 6");
  });

  test("later misses stay calm and name the stroke", () => {
    const feedback = mistakeFeedback({ strokeNum: 1, totalStrokes: 3, mistakesOnStroke: 4, isBackwards: true });
    expect(feedback.tone).toBe("gentle");
    expect(feedback.message).toContain("stroke 2");
  });

  test("correct strokes report the remaining count and completion", () => {
    expect(correctStrokeFeedback({ strokesRemaining: 3 }).message).toBe("Good — 3 strokes to go.");
    expect(correctStrokeFeedback({ strokesRemaining: 1 }).message).toBe("Good — 1 stroke to go.");
    const done = correctStrokeFeedback({ strokesRemaining: 0 });
    expect(done.tone).toBe("good");
    expect(done.message).toBe("Character complete.");
  });

  test("the next-stroke prompt is one-based and bounded", () => {
    expect(nextStrokeFeedback({ strokeNum: 0, totalStrokes: 4 }).message).toBe("Draw stroke 1 of 4.");
    expect(nextStrokeFeedback({ strokeNum: 0, totalStrokes: 0 }).message).toBe("Draw stroke 0 of 0.");
  });

  test("demo and missing-data prompts instruct without blame", () => {
    expect(demoPromptFeedback().message).toMatch(/Tap the square or press Enter/);
    expect(missingDataFeedback("字").tone).toBe("gentle");
  });

  test("audio failure copy points at the replay button without blame", () => {
    const feedback = audioFailureFeedback();
    expect(feedback.tone).toBe("gentle");
    expect(feedback.message).toMatch(/replay button/i);
  });
});
