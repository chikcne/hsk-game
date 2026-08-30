import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { randomStateFromSeed } from "../../src/domain/random";
import {
  applyReviewOutcome, createReviewProgress, prepareReviewRound,
  spawnNextReviewWord, syncReviewProgress,
} from "../../src/domain/review";

const settings = { ...DEFAULT_SETTINGS };
const NOW = "2026-01-01T00:00:00.000Z";

describe("Anki-style mastered-word review", () => {
  it("syncs mastered words from every sector and starts new cards due", () => {
    const keys = new Set(["hsk-1:a", "hsk-4:b"]);
    const review = prepareReviewRound(createReviewProgress(randomStateFromSeed("review")), keys);
    expect(Object.keys(review.words).sort()).toEqual([...keys].sort());
    const spawn = spawnNextReviewWord(review, keys, new Set(), undefined, settings);
    expect(spawn.status).toBe("spawned");
    if (spawn.status === "spawned") expect(keys.has(spawn.wordKey)).toBe(true);
  });

  it("assigns recall score from pinyin time divided by pinyin length", () => {
    const key = "hsk-2:word";
    const review = syncReviewProgress(createReviewProgress(), [key]);
    const result = applyReviewOutcome(review, key, { kind: "correct", pinyinMs: 4000, meaningMs: 90_000 }, 8, NOW, settings);
    expect(result.recallScoreMsPerChar).toBe(500);
    expect(result.progress.totalPinyinMs).toBe(4000);
    expect(result.interval).toBe(settings.reviewInitialInterval);
    expect(result.review.activePoolWordKeys).not.toContain(key);
  });

  it("keeps slow and wrong cards in the review pool without changing regular mastery", () => {
    const key = "hsk-1:word";
    const review = syncReviewProgress(createReviewProgress(), [key]);
    const slow = applyReviewOutcome(review, key, { kind: "correct", pinyinMs: 6000, meaningMs: 0 }, 3, NOW, settings);
    expect(slow.struggled).toBe(true);
    expect(slow.interval).toBe(settings.reviewLapseInterval);
    expect(slow.review.activePoolWordKeys).toContain(key);
    expect(slow.progress.recallScoreMsPerChar).toBe(2000);

    const wrong = applyReviewOutcome(slow.review, key, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, 3, NOW, settings);
    expect(wrong.progress.wrongMeaning).toBe(1);
    expect(wrong.review.activePoolWordKeys).toContain(key);
    expect(wrong.progress.repetitions).toBe(0);
  });

  it("graduates a repaired card and applies a finer interval gradient", () => {
    const key = "hsk-6:word";
    let review = syncReviewProgress(createReviewProgress(), [key]);
    review = applyReviewOutcome(review, key, { kind: "wrongPinyin", pinyinMs: 1000 }, 4, NOW, settings).review;
    const repaired = applyReviewOutcome(review, key, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, 4, NOW, settings);
    expect(repaired.review.activePoolWordKeys).not.toContain(key);
    expect(repaired.progress.repetitions).toBe(1);
    expect(repaired.interval).toBe(settings.reviewInitialInterval);
  });

  it("finishes a round when no card or repair is due and advances next round to earliest due", () => {
    const key = "hsk-3:word";
    const keys = new Set([key]);
    let review = syncReviewProgress(createReviewProgress(), keys);
    review = applyReviewOutcome(review, key, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, 2, NOW, settings).review;
    const complete = spawnNextReviewWord(review, keys, new Set(), undefined, settings);
    expect(complete.status).toBe("complete");
    const nextRound = prepareReviewRound(review, keys);
    expect(nextRound.nextSpawnOrdinal).toBe(review.words[key]?.dueOrdinal);
  });
});
