import { describe, expect, it } from "vitest";
import type { ComponentMemory, LevelProgress, WordProgress } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { randomStateFromSeed } from "../../src/domain/random";
import { componentRetrievability } from "../../src/domain/memory";
import { countDueReviewWords, reviewWordIdOf, reviewWordKey, spawnNextReviewWord } from "../../src/domain/review";
import type { LevelsMap, SchedulerSnapshot } from "../../src/domain/learning";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const settings = { ...DEFAULT_SETTINGS };
const SNAPSHOT: SchedulerSnapshot = { spawnOrdinal: 0, schedulerRng: randomStateFromSeed("review") };

function memory(patch: Partial<ComponentMemory>): ComponentMemory {
  return {
    state: "review", due: new Date(NOW - 1000).toISOString(), stability: 3, difficulty: 5,
    elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 3, lapses: 0,
    lastReview: new Date(NOW - 4 * 86_400_000).toISOString(), ...patch,
  };
}
function reviewedWord(dueMs = NOW - 1000, lastReviewDaysAgo = 4): WordProgress {
  const base = {
    due: new Date(dueMs).toISOString(),
    lastReview: new Date(NOW - lastReviewDaysAgo * 86_400_000).toISOString(),
  };
  return {
    pinyin: memory(base), meaning: memory(base),
    attempts: 3, completeCorrect: 3, wrongPinyin: 0, wrongMeaning: 0, landed: 0,
    totalThinkingMs: 9000, fastestCorrectMs: 2500, totalPinyinMs: 9000, fastestPinyinMs: 2000,
    lastPinyinMs: 2000, lastOutcome: "correct", lastSeenAt: base.lastReview,
    introducedAtOrdinal: 0, lastSpawnOrdinal: null, nextEligibleSpawn: 0,
  };
}
function level(deckId: string, words: Record<string, WordProgress>, fingerprint = `${deckId}-fp`): LevelProgress {
  return {
    deckId: deckId as LevelProgress["deckId"], deckFingerprint: fingerprint,
    curriculumSeed: "seed", curriculumCursor: Object.keys(words).length, firstCompletedAt: null,
    words, orphanedProgress: {},
  };
}

describe("cross-grade FSRS review scheduling", () => {
  it("spawns only due graduated words across decks", () => {
    const levels: LevelsMap = {
      "hsk-1": level("hsk-1", { a: reviewedWord(), b: reviewedWord(NOW + 86_400_000) }),
      "hsk-2": level("hsk-2", { c: reviewedWord() }),
    };
    const result = spawnNextReviewWord(levels, new Date(NOW), SNAPSHOT, new Set(), settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(["hsk-1:a", "hsk-2:c"]).toContain(result.wordKey);
    expect(result.tier).toBe("review");
    // Not-due cards are never touched (this is the old review-filler bug).
    expect(result.snapshot.spawnOrdinal).toBe(1);
    expect(result.levels["hsk-1"]!.words.b?.lastSpawnOrdinal).toBeNull();
  });

  it("ends the round when nothing is due — no graded fillers, ever", () => {
    const levels: LevelsMap = {
      "hsk-1": level("hsk-1", {
        a: reviewedWord(NOW + 3 * 86_400_000),
        b: reviewedWord(NOW + 30 * 86_400_000),
      }),
    };
    const result = spawnNextReviewWord(levels, new Date(NOW), SNAPSHOT, new Set(), settings);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    // SRS state untouched: no filler spawn overwrote the future due dates.
    expect(result.levels["hsk-1"]!.words.a?.pinyin.due).toBe(levels["hsk-1"]!.words.a!.pinyin.due);
    expect(result.levels["hsk-1"]!.words.a?.lastSpawnOrdinal).toBeNull();
  });

  it("never serves un-graduated learning words; repairs relearning cards first", () => {
    const learning: WordProgress = {
      ...reviewedWord(),
      pinyin: memory({ state: "learning", reps: 1, lapses: 0, stability: 0.1, difficulty: 5, learningSteps: 1 }),
    };
    const lapsed: WordProgress = {
      ...reviewedWord(),
      pinyin: memory({ state: "relearning", reps: 4, lapses: 1, stability: 0.8, learningSteps: 0 }),
    };
    const levels: LevelsMap = { "hsk-1": level("hsk-1", { learn: learning, lapse: lapsed, ok: reviewedWord() }) };
    const result = spawnNextReviewWord(levels, new Date(NOW), SNAPSHOT, new Set(), settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.wordKey).toBe("hsk-1:lapse");
    expect(result.tier).toBe("relearning");
  });

  it("orders graduated maintenance by lowest retrievability", () => {
    const soon = reviewedWord(NOW - 1000, 1); // reviewed yesterday, barely decayed
    const overdue = reviewedWord(NOW - 1000, 10); // reviewed long ago, most decayed
    expect(componentRetrievability(overdue.pinyin, NOW)).toBeLessThan(componentRetrievability(soon.pinyin, NOW));
    const levels: LevelsMap = { "hsk-1": level("hsk-1", { soon, overdue }) };
    const result = spawnNextReviewWord(levels, new Date(NOW), SNAPSHOT, new Set(), settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.wordKey).toBe("hsk-1:overdue");
  });

  it("respects the ordinal cooldown and ends the round while repairs cool", () => {
    const word = reviewedWord();
    const reserved: WordProgress = { ...word, lastSpawnOrdinal: 3, nextEligibleSpawn: 9 };
    const levels: LevelsMap = { "hsk-1": level("hsk-1", { a: reserved }) };
    const blocked = spawnNextReviewWord(levels, new Date(NOW), { spawnOrdinal: 5, schedulerRng: SNAPSHOT.schedulerRng }, new Set(), settings);
    expect(blocked.status).toBe("complete"); // cooling repair: round finishes instead of bypassing

    const ready = spawnNextReviewWord(levels, new Date(NOW), { spawnOrdinal: 9, schedulerRng: SNAPSHOT.schedulerRng }, new Set(), settings);
    expect(ready.status).toBe("spawned");
  });

  it("reservation survives mode crossings through the shared ordinal", () => {
    // A review spawn sets nextEligibleSpawn on the grade's word record, so the
    // same word cannot instantly respawn inside its regular grade either.
    const levels: LevelsMap = { "hsk-1": level("hsk-1", { a: reviewedWord() }) };
    const first = spawnNextReviewWord(levels, new Date(NOW), SNAPSHOT, new Set(), settings);
    expect(first.status).toBe("spawned");
    if (first.status !== "spawned") return;
    const reserved = first.levels["hsk-1"]!.words.a!;
    expect(reserved.lastSpawnOrdinal).toBe(0);
    expect(reserved.nextEligibleSpawn).toBeGreaterThan(0);
    const immediate = spawnNextReviewWord(first.levels, new Date(NOW), first.snapshot, new Set(), settings);
    expect(immediate.status).toBe("complete");
  });

  it("counts due reviewable words honestly", () => {
    const levels: LevelsMap = {
      "hsk-1": level("hsk-1", {
        due: reviewedWord(),
        future: reviewedWord(NOW + 86_400_000),
        lapsed: { ...reviewedWord(), pinyin: memory({ state: "relearning", reps: 4, lapses: 1, stability: 0.8 }) },
      }),
      "hsk-2": level("hsk-2", {
        unstarted: { ...reviewedWord(), introducedAtOrdinal: null },
      }),
    };
    expect(countDueReviewWords(levels, new Date(NOW))).toBe(2); // `due` + `lapsed`
  });

  it("maps review keys to their grade and word", () => {
    expect(reviewWordKey("hsk-3", "w:1")).toBe("hsk-3:w:1");
    expect(reviewWordIdOf("hsk-3:w:1")).toEqual({ deckId: "hsk-3", wordId: "w:1" });
    expect(() => reviewWordIdOf("noseparator")).toThrow(/Invalid review word key/);
  });
});
