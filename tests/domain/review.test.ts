import { describe, expect, it } from "vitest";
import { randomStateFromSeed } from "../../src/domain/random";
import {
  applyReviewOutcome, createReviewProgress, createReviewWordProgress, daysUntil,
  prepareReviewRound, spawnNextReviewWord, syncReviewProgress,
} from "../../src/domain/review";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;
const dueTomorrow = () => new Date(NOW_MS + DAY_MS).toISOString();

describe("Mastery Review scheduling", () => {
  it("syncs mastered words from every grade and starts new cards due now", () => {
    const keys = new Set(["hsk-1:a", "hsk-4:b"]);
    const review = prepareReviewRound(createReviewProgress(randomStateFromSeed("review")), keys, NOW);
    expect(Object.keys(review.words).sort()).toEqual([...keys].sort());
    expect(review.words["hsk-1:a"]?.dueAt).toBe(NOW);
    const spawn = spawnNextReviewWord(review, keys, new Set(), NOW_MS);
    expect(spawn.status).toBe("spawned");
    if (spawn.status === "spawned") expect(keys.has(spawn.wordKey)).toBe(true);
  });

  it("drops stale repair-pool keys that no longer belong to a mastered card", () => {
    const keys = new Set(["hsk-1:a"]);
    let review = prepareReviewRound(createReviewProgress(), new Set(["hsk-1:a", "hsk-1:gone"]), NOW);
    review = { ...review, activePoolWordKeys: [...review.activePoolWordKeys, "hsk-1:gone"] };
    const prepared = prepareReviewRound(review, keys, NOW);
    expect(prepared.activePoolWordKeys.every((key) => keys.has(key))).toBe(true);
  });

  it("assigns recall score from pinyin time divided by pinyin length", () => {
    const key = "hsk-2:word";
    const review = syncReviewProgress(createReviewProgress(), [key], NOW);
    const result = applyReviewOutcome(review, key, { kind: "correct", pinyinMs: 4000, meaningMs: 90_000 }, 8, NOW);
    expect(result.recallScoreMsPerChar).toBe(500);
    expect(result.progress.totalPinyinMs).toBe(4000);
    expect(result.progress.phase).toBe("review");
    expect(result.dueInDays).toBeGreaterThanOrEqual(1);
    expect(result.review.activePoolWordKeys).not.toContain(key);
  });

  it("grades by normalized latency and sends lapses through the 2/6/18 relearning steps", () => {
    const key = "hsk-1:word";
    const review = syncReviewProgress(createReviewProgress(), [key], NOW);
    const lapse = applyReviewOutcome(review, key, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, 3, NOW);
    expect(lapse.struggled).toBe(true);
    expect(lapse.progress.phase).toBe("relearning");
    expect(lapse.progress.dueOrdinal).toBe(lapse.review.nextSpawnOrdinal + 2);
    expect(lapse.dueInWords).toBe(2);
    expect(lapse.review.activePoolWordKeys).toContain(key);

    const step1 = applyReviewOutcome(lapse.review, key, { kind: "correct", pinyinMs: 9000, meaningMs: 100 }, 3, NOW);
    expect(step1.progress.stepIndex).toBe(1);
    expect(step1.dueInWords).toBe(6);

    const step2 = applyReviewOutcome(step1.review, key, { kind: "correct", pinyinMs: 9000, meaningMs: 100 }, 3, NOW);
    expect(step2.progress.stepIndex).toBe(2);
    expect(step2.dueInWords).toBe(18);

    const done = applyReviewOutcome(step2.review, key, { kind: "correct", pinyinMs: 9000, meaningMs: 100 }, 3, NOW);
    expect(done.progress.phase).toBe("review");
    expect(done.progress.dueOrdinal).toBeNull();
    expect(done.dueInDays).toBeGreaterThanOrEqual(1);
    expect(done.review.activePoolWordKeys).not.toContain(key);
  });

  it("never updates the schedule of a lapsed card from unrelated cards, and ends the round when nothing is due", () => {
    const keys = new Set(["hsk-3:a", "hsk-3:b"]);
    let review = prepareReviewRound(createReviewProgress(), keys, NOW);
    // Both cards reviewed: they move to future wall-clock due points.
    review = applyReviewOutcome(review, "hsk-3:a", { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, 2, NOW).review;
    review = applyReviewOutcome(review, "hsk-3:b", { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, 2, NOW).review;
    const complete = spawnNextReviewWord(review, keys, new Set(), NOW_MS);
    expect(complete.status).toBe("complete");

    // Advancing to a fresh round must not fast-forward time: cards stay due
    // at their wall-clock points even though nextSpawnOrdinal keeps growing.
    const nextRound = prepareReviewRound(review, keys, NOW);
    expect(nextRound.nextSpawnOrdinal).toBe(review.nextSpawnOrdinal);
    const spawn = spawnNextReviewWord(nextRound, keys, new Set(), NOW_MS);
    expect(spawn.status).toBe("complete");
    const later = Date.parse(NOW) + 3 * DAY_MS;
    const afterTime = spawnNextReviewWord(nextRound, keys, new Set(), later);
    expect(afterTime.status).toBe("spawned");
  });

  it("prioritizes relearning cards over merely due cards", () => {
    const keys = new Set(["hsk-6:a", "hsk-6:b"]);
    let review = prepareReviewRound(createReviewProgress(), keys, NOW);
    review = applyReviewOutcome(review, "hsk-6:a", { kind: "wrongPinyin", pinyinMs: 1000 }, 4, NOW).review;
    // hsk-6:a is relearning (due in 2 ordinals); make hsk-6:b due now too.
    review = { ...review, words: { ...review.words, "hsk-6:b": { ...createReviewWordProgress(NOW) } } };
    review = applyReviewOutcome(review, "hsk-6:b", { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, 4, NOW).review;
    const lapsed = { ...review.words["hsk-6:a"]!, dueOrdinal: review.nextSpawnOrdinal };
    review = { ...review, words: { ...review.words, "hsk-6:a": lapsed } };

    const spawn = spawnNextReviewWord(review, keys, new Set(), NOW_MS + 10 * DAY_MS);
    expect(spawn.status).toBe("spawned");
    if (spawn.status !== "spawned") return;
    expect(spawn.tier).toBe("repair");
    expect(spawn.wordKey).toBe("hsk-6:a");
  });

  it("reports days until a wall-clock due point", () => {
    expect(daysUntil(dueTomorrow(), NOW)).toBeCloseTo(1, 5);
    expect(daysUntil(new Date(NOW_MS - DAY_MS).toISOString(), NOW)).toBe(0);
  });
});
