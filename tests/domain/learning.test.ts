import { describe, expect, it } from "vitest";
import type { LevelProgress, WordProgress } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { randomStateFromSeed } from "../../src/domain/random";
import {
  applyOutcome, applyOutcomeToLevel, assertLevelInvariants,
  countMastered, createLevelProgress, createWordProgress, curriculumOrder,
  displayedMastery, inferRecallGrade, isDue, isEligible, practiceCandidates,
  reconcileLevelProgress, selectionBuckets, spawnNextWord, validateLevelInvariants,
  type LearningDeck,
} from "../../src/domain/learning";

const NOW = "2026-01-02T03:04:05.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;
const settings = { ...DEFAULT_SETTINGS };

function deck(count = 200, fingerprint = "fingerprint-a", prefix = "word"): LearningDeck {
  return { id: "hsk-1", fingerprint, words: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(3, "0")}` })) };
}
function freshLevel(sourceDeck = deck(), levelSize = 20): LevelProgress {
  return createLevelProgress(sourceDeck, { schedulerRng: randomStateFromSeed("scheduler"), curriculumSeed: "curriculum", levelSize });
}
function updateWord(level: LevelProgress, id: string, patch: Partial<WordProgress>): LevelProgress {
  const progress = level.words[id]; if (!progress) throw new Error(`missing ${id}`);
  return { ...level, words: { ...level.words, [id]: { ...progress, ...patch } } };
}
/** Puts a word into an arbitrary phase for scheduler tests. */
function phasePatch(phase: WordProgress["phase"], dueInWords: number | null, ordinal = 0): Partial<WordProgress> {
  if (phase === "review") {
    return { phase, stepIndex: 0, dueOrdinal: null, dueAt: dueInWords === null ? new Date(NOW_MS + 30 * DAY_MS).toISOString() : new Date(NOW_MS - dueInWords * DAY_MS).toISOString(), stability: 4, difficulty: 5, lapses: 0, lastGrade: "good" };
  }
  return { phase, stepIndex: 0, dueOrdinal: dueInWords === null ? null : ordinal + dueInWords, dueAt: null, stability: phase === "relearning" ? 2 : 0, difficulty: 5, lapses: 0, lastGrade: null };
}

describe("rolling grade curriculum", () => {
  it("replaces an individually graduated word without waiting for the rest of the pool", () => {
    const source = deck(600);
    const level = freshLevel(source);
    const order = curriculumOrder(source, "curriculum");
    expect(level.currentLevelWordIds).toEqual(order.slice(0, 20));
    expect(level.activeLearningWordIds).toEqual(level.currentLevelWordIds);

    const graduatedId = level.currentLevelWordIds[0]!;
    const result = applyOutcomeToLevel(
      updateWord(level, graduatedId, { phase: "learning", stepIndex: 2, dueOrdinal: level.nextSpawnOrdinal }),
      source,
      graduatedId,
      { kind: "correct", pinyinMs: 3000, meaningMs: 99_000 },
      NOW,
      settings,
    );
    expect(result.progress.phase).toBe("review");
    expect(result.progress.dueAt).toBe(new Date(Date.parse(NOW) + DAY_MS).toISOString());
    expect(result.level.currentLevelWordIds).not.toContain(graduatedId);
    expect(result.level.currentLevelWordIds).toContain(order[20]);
    expect(result.level.currentLevelWordIds.filter((id) => level.currentLevelWordIds.includes(id))).toHaveLength(19);
    expect(result.level.curriculumCursor).toBe(21);
    expect(result.transitions).toEqual([]);
  });

  it("keeps a fixed-size rolling pool while unseen words remain", () => {
    const source = deck(40);
    let level = freshLevel(source);
    for (let index = 0; index < 20; index += 1) {
      const id = level.currentLevelWordIds[0]!;
      const result = applyOutcomeToLevel(
        updateWord(level, id, { ...phasePatch("learning", null), stepIndex: 2 }),
        source,
        id,
        { kind: "correct", pinyinMs: 3000, meaningMs: 0 },
        NOW,
        settings,
      );
      expect(result.progress.phase).toBe("review");
      level = result.level;
    }
    expect(level.curriculumCursor).toBe(40);
    expect(level.currentLevelWordIds).toHaveLength(20);
    expect(level.currentLevelIndex).toBe(1);
  });

  it("returns a lapsed graduated word to the active pool as relearning", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const lapsedId = level.currentLevelWordIds[0]!;
    level = updateWord(level, lapsedId, { phase: "review", stepIndex: 0, dueOrdinal: null, dueAt: new Date(NOW_MS + 10 * DAY_MS).toISOString(), stability: 8, lapses: 0, lastGrade: "good" });
    level = { ...level, activeLearningWordIds: level.activeLearningWordIds.filter((id) => id !== lapsedId) };
    const lapse = applyOutcomeToLevel(level, source, lapsedId, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, NOW, settings);
    expect(lapse.progress.phase).toBe("relearning");
    expect(lapse.progress.dueOrdinal).toBe(lapse.level.nextSpawnOrdinal + 2);
    expect(lapse.progress.stability).toBeCloseTo(2, 5);
    expect(lapse.progress.lapses).toBe(1);
    expect(lapse.level.activeLearningWordIds).toContain(lapsedId);
    expect(lapse.transitions).toEqual([]);
  });

  it("completes the grade when the final word graduates", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const final = level.currentLevelWordIds.at(-1)!;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, phasePatch("review", null));
    level = updateWord(level, final, { phase: "learning", stepIndex: 2, dueOrdinal: level.nextSpawnOrdinal });
    level = { ...level, activeLearningWordIds: [final] };
    const result = applyOutcomeToLevel(level, source, final, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, NOW, settings);
    expect(result.transitions).toContain("gradeCompleted");
    expect(result.level.firstCompletedAt).toBe(NOW);
    expect(countMastered(result.level)).toBe(20);
  });
});

describe("continuous grading", () => {
  it.each([
    { kind: "wrongPinyin", pinyinMs: 1000 },
    { kind: "wrongMeaning", pinyinMs: 1000, meaningMs: 9000 },
    { kind: "landed", activeThinkingMs: null },
    { kind: "correct", pinyinMs: 1000, meaningMs: 1000, autocompleted: true },
  ] as const)("grades every failure mode, including autocomplete, as Again ($kind)", (outcome) => {
    expect(inferRecallGrade(outcome, 2)).toBe("again");
  });

  it("grades correct answers by pinyin latency per character", () => {
    expect(inferRecallGrade({ kind: "correct", pinyinMs: 2800, meaningMs: 0 }, 2)).toBe("easy");
    expect(inferRecallGrade({ kind: "correct", pinyinMs: 8000, meaningMs: 0 }, 2)).toBe("good");
    expect(inferRecallGrade({ kind: "correct", pinyinMs: 8100, meaningMs: 0 }, 2)).toBe("hard");
    // The old cliff: a slow answer is merely Hard, never punished below its stage.
    expect(inferRecallGrade({ kind: "correct", pinyinMs: 60_000, meaningMs: 0 }, 2)).toBe("hard");
  });

  it("ignores meaning time when grading", () => {
    const quickMeaning = applyOutcome(createWordProgress(), { kind: "correct", pinyinMs: 2000, meaningMs: 10 }, NOW, 0);
    const slowMeaning = applyOutcome(createWordProgress(), { kind: "correct", pinyinMs: 2000, meaningMs: 100_000 }, NOW, 0);
    expect(quickMeaning.grade).toBe(slowMeaning.grade);
    expect(slowMeaning.progress.totalThinkingMs).toBeGreaterThan(quickMeaning.progress.totalThinkingMs);
  });
});

describe("learning and relearning steps", () => {
  it("starts new words in the new phase and walks the 3/10/30 learning steps", () => {
    const fresh = createWordProgress();
    expect(fresh.phase).toBe("new");
    expect(displayedMastery(fresh)).toBe(0);

    // First correct answer (Good): learning step 0, due after 3 words.
    const first = applyOutcome(fresh, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, 10);
    expect(first.progress.phase).toBe("learning");
    expect(first.progress.stepIndex).toBe(0);
    expect(first.progress.dueOrdinal).toBe(13);
    expect(first.dueInWords).toBe(3);
    expect(displayedMastery(first.progress)).toBe(25);

    // Second Good: step 1, due after 10 words.
    const second = applyOutcome(first.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, 20);
    expect(second.progress.stepIndex).toBe(1);
    expect(second.progress.dueOrdinal).toBe(30);
    expect(second.dueInWords).toBe(10);
    expect(displayedMastery(second.progress)).toBe(50);

    // Third Good: step 2, due after 30 words.
    const third = applyOutcome(second.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, 40);
    expect(third.progress.stepIndex).toBe(2);
    expect(third.progress.dueOrdinal).toBe(70);
    expect(third.dueInWords).toBe(30);
    expect(displayedMastery(third.progress)).toBe(75);

    // Fourth Good graduates into wall-clock review with 1 day of stability.
    const fourth = applyOutcome(third.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, 80);
    expect(fourth.progress.phase).toBe("review");
    expect(fourth.progress.dueOrdinal).toBeNull();
    expect(fourth.progress.dueAt).toBe(new Date(Date.parse(NOW) + DAY_MS).toISOString());
    expect(fourth.becameMastered).toBe(true);
    expect(fourth.dueInDays).toBe(1);
    expect(displayedMastery(fourth.progress)).toBe(83);
  });

  it("never graduates a word before at least four spaced successes", () => {
    let progress = createWordProgress();
    let corrects = 0;
    while (progress.phase !== "review" && corrects < 100) {
      const origin = 100 * (corrects + 1);
      progress = applyOutcome(progress, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, origin).progress;
      corrects += 1;
    }
    expect(progress.phase).toBe("review");
    expect(corrects).toBe(4);
  });

  it("keeps Hard at the current stage with a shortened interval and Easy ahead with a longer one", () => {
    const step1 = { ...createWordProgress(), phase: "learning" as const, stepIndex: 1, dueOrdinal: 100, attempts: 2, completeCorrect: 2 };
    const hard = applyOutcome(step1, { kind: "correct", pinyinMs: 9000, meaningMs: 100 }, NOW, 20);
    expect(hard.progress.stepIndex).toBe(1);
    expect(hard.dueInWords).toBe(5);
    expect(hard.struggled).toBe(true);

    const easy = applyOutcome(step1, { kind: "correct", pinyinMs: 1000, meaningMs: 100 }, NOW, 20);
    expect(easy.progress.stepIndex).toBe(2);
    expect(easy.dueInWords).toBe(45);

    // A Hard answer at the 8-second boundary changes almost nothing.
    const boundary = applyOutcome(step1, { kind: "correct", pinyinMs: 8100, meaningMs: 100 }, NOW, 20);
    expect(boundary.progress.stepIndex).toBe(1);
    expect(boundary.dueInWords).toBe(5);
  });

  it("restarts learning steps after Another failure and walks relearning after a lapse", () => {
    const step2 = { ...createWordProgress(), phase: "learning" as const, stepIndex: 2, dueOrdinal: 100, attempts: 3, completeCorrect: 3 };
    const again = applyOutcome(step2, { kind: "wrongPinyin", pinyinMs: 1000 }, NOW, 50);
    expect(again.progress.stepIndex).toBe(0);
    expect(again.progress.dueOrdinal).toBe(53);
    expect(again.progress.lapses).toBe(1);

    const lapsed = { ...createWordProgress(), phase: "review" as const, stepIndex: 0, dueOrdinal: null, dueAt: new Date(NOW_MS + DAY_MS).toISOString(), stability: 6, attempts: 5, completeCorrect: 5 };
    const lapse = applyOutcome(lapsed, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, NOW, 60);
    expect(lapse.progress.phase).toBe("relearning");
    expect(lapse.progress.dueOrdinal).toBe(62);

    // Relearning steps run 2 → 6 → 18, then return to wall-clock review.
    const step0 = applyOutcome(lapse.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 100 }, NOW, 70);
    expect(step0.progress.stepIndex).toBe(1);
    expect(step0.dueInWords).toBe(6);
    const step1 = applyOutcome(step0.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 100 }, NOW, 80);
    expect(step1.progress.stepIndex).toBe(2);
    expect(step1.dueInWords).toBe(18);
    const done = applyOutcome(step1.progress, { kind: "correct", pinyinMs: 2000, meaningMs: 100 }, NOW, 100);
    expect(done.progress.phase).toBe("review");
    expect(done.progress.dueOrdinal).toBeNull();
    expect(done.dueInDays).toBe(2);
  });

  it("grows graduated stability by grade and difficulty, and collapses it on a lapse", () => {
    const graduated = { ...createWordProgress(), phase: "review" as const, dueOrdinal: null, dueAt: new Date(NOW_MS + DAY_MS).toISOString(), stability: 4, difficulty: 5, attempts: 5, completeCorrect: 5 };
    const good = applyOutcome(graduated, { kind: "correct", pinyinMs: 2000, meaningMs: 100 }, NOW, 0);
    expect(good.progress.stability).toBeCloseTo(7, 5);
    expect(good.dueInDays).toBe(7);
    expect(good.progress.dueAt).toBe(new Date(Date.parse(NOW) + 7 * DAY_MS).toISOString());

    const hard = applyOutcome(good.progress, { kind: "correct", pinyinMs: 9000, meaningMs: 100 }, NOW, 0);
    // Hard keeps knowledge roughly flat instead of punishing it.
    expect(hard.progress.stability).toBeGreaterThan(6);
    expect(hard.progress.stability).toBeLessThan(good.progress.stability);

    const again = applyOutcome(hard.progress, { kind: "wrongPinyin", pinyinMs: 900 }, NOW, 0);
    expect(again.progress.stability).toBeCloseTo(1.67, 2);
    expect(again.progress.difficulty).toBeGreaterThan(hard.progress.difficulty);
  });

  it("maintains counters and pinyin timing stats", () => {
    let progress = createWordProgress();
    progress = applyOutcome(progress, { kind: "correct", pinyinMs: 1000, meaningMs: 50_000 }, NOW, 0).progress;
    progress = applyOutcome(progress, { kind: "wrongMeaning", pinyinMs: 2000, meaningMs: 1 }, NOW, 50).progress;
    expect(progress.attempts).toBe(2);
    expect(progress.totalPinyinMs).toBe(3000);
    expect(progress.fastestPinyinMs).toBe(1000);
    expect(progress.attempts).toBe(progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed);
  });

  it("leaves the schedule untouched for ungraded practice", () => {
    const learning = { ...createWordProgress(), phase: "learning" as const, stepIndex: 1, dueOrdinal: 500, attempts: 2, completeCorrect: 2 };
    const practice = applyOutcome(learning, { kind: "wrongPinyin", pinyinMs: 900 }, NOW, 10, { graded: false });
    expect(practice.graded).toBe(false);
    expect(practice.progress.phase).toBe("learning");
    expect(practice.progress.dueOrdinal).toBe(500);
    expect(practice.progress.stepIndex).toBe(1);
    expect(practice.dueInWords).toBeNull();
    expect(practice.progress.attempts).toBe(3);
    expect(practice.progress.wrongPinyin).toBe(1);
  });
});

describe("scheduler: hard spacing and due-state selection", () => {
  it("reserves spawned words and never selects unintroduced words", () => {
    const source = deck();
    const level = freshLevel(source);
    const result = spawnNextWord(level, source, undefined, NOW_MS);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.tier).toBe("new");
    expect(level.words[result.wordId]?.introducedAtOrdinal).not.toBeNull();
    expect(result.level.words[result.wordId]?.nextEligibleSpawn).toBe(result.spawnOrdinal + 3);
    expect(isEligible(result.level.words[result.wordId]!, result.level.nextSpawnOrdinal)).toBe(false);
  });

  it("never selects a word before its hard spacing floor, even when everything is cooling", () => {
    const source = deck(20);
    let level = freshLevel(source);
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, phasePatch("learning", 5));
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { nextEligibleSpawn: 1_000 });
    const result = spawnNextWord(level, source, undefined, NOW_MS);
    expect(result.status).toBe("noEligibleWord");
    if (result.status !== "noEligibleWord") return;
    expect(result.diagnostics.coolingCount).toBe(20);
  });

  it("selects only due words for graded spawns", () => {
    let level = freshLevel(deck(40));
    const [dueId, futureId, newId] = level.activeLearningWordIds;
    level = updateWord(level, dueId!, { ...phasePatch("learning", 0), nextEligibleSpawn: 0 });
    level = updateWord(level, futureId!, { ...phasePatch("learning", 100), nextEligibleSpawn: 0 });
    const buckets = selectionBuckets(level, NOW_MS);
    expect(buckets.learning.map((entry) => entry.id)).toEqual([dueId]);
    expect(buckets.new.length).toBe(18);

    // Repeated spawns draw from due and new buckets only; the future word
    // cannot appear graded before its due point.
    const seen = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const result = spawnNextWord(level, deck(40), undefined, NOW_MS);
      expect(result.status).toBe("spawned");
      if (result.status !== "spawned") return;
      expect(result.wordId).not.toBe(futureId);
      expect(result.tier).not.toBe("practice");
      seen.add(result.tier);
      level = result.level;
    }
    expect(seen.has("learning")).toBe(true);
    expect(seen.has("new")).toBe(true);
  });

  it("runs ungraded practice when nothing is due, without violating spacing", () => {
    const source = deck(40);
    let level = freshLevel(source);
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { ...phasePatch("learning", 100), nextEligibleSpawn: 0 });
    const candidates = practiceCandidates(level, NOW_MS);
    expect(candidates.length).toBe(20);
    // Least recently seen first; every word ties, so stable ID order decides.
    const expectedId = [...level.activeLearningWordIds].sort()[0]!;
    expect(candidates[0]!.id).toBe(expectedId);

    const result = spawnNextWord(level, source, undefined, NOW_MS);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.tier).toBe("practice");
    expect(result.wordId).toBe(expectedId);
    // The practice spawn still reserves hard spacing.
    expect(result.level.words[expectedId]?.nextEligibleSpawn).toBe(result.spawnOrdinal + 3);
  });

  it("brings graduated words back by wall-clock dueAt in regular play", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const graduatedId = level.currentLevelWordIds[0]!;
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { ...phasePatch("learning", 100), nextEligibleSpawn: 1_000 });
    level = updateWord(level, graduatedId, { ...phasePatch("review", 2), nextEligibleSpawn: 0 });
    level = { ...level, activeLearningWordIds: level.activeLearningWordIds.filter((id) => id !== graduatedId) };

    expect(isDue(level.words[graduatedId]!, 0, NOW_MS)).toBe(true);
    const preLoop = level;
    // The graduation refill introduces one new word, so the lottery holds a
    // due and a new bucket; the due graduated word must surface within a few
    // spawns as the new word cools.
    let drawn = false;
    for (let index = 0; index < 12 && !drawn; index += 1) {
      const result = spawnNextWord(level, source, undefined, NOW_MS);
      expect(result.status).toBe("spawned");
      if (result.status !== "spawned") return;
      if (result.wordId === graduatedId) {
        expect(result.tier).toBe("due");
        drawn = true;
      } else {
        expect(result.tier).toBe("new");
      }
      level = result.level;
    }
    expect(drawn).toBe(true);

    // Before its dueAt the same word is never graded: the due bucket stays
    // empty and the round continues on new words and ungraded practice.
    const early = updateWord(preLoop, graduatedId, phasePatch("review", null));
    expect(selectionBuckets(early, NOW_MS).due).toHaveLength(0);
    const earlyResult = spawnNextWord(early, source, undefined, NOW_MS);
    expect(earlyResult.status).toBe("spawned");
    if (earlyResult.status !== "spawned") return;
    expect(earlyResult.tier).not.toBe("due");
    expect(practiceCandidates(early, NOW_MS).map((entry) => entry.id)).toContain(graduatedId);
  });

  it("does not deadlock when every other level word is in flight", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const inFlight = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const spawn = spawnNextWord(level, source, undefined, NOW_MS, inFlight);
      expect(spawn.status).toBe("spawned");
      if (spawn.status !== "spawned") return;
      level = spawn.level;
      inFlight.add(spawn.wordId);
    }
    expect(spawnNextWord(level, source, undefined, NOW_MS, inFlight).status).toBe("noEligibleWord");
  });
});

describe("spawn delay from outcomes", () => {
  it("keeps the spawn-reserved spacing floor and sets the due point from the resolution ordinal", () => {
    const source = deck();
    const level = { ...freshLevel(source), nextSpawnOrdinal: 12 };
    const id = level.currentLevelWordIds[0]!;
    // Simulate the reservation a spawn at ordinal 11 made: floor at 14.
    const reserved = updateWord(level, id, { lastSpawnOrdinal: 11, nextEligibleSpawn: 14 });
    const result = applyOutcomeToLevel(reserved, source, id, { kind: "wrongPinyin", pinyinMs: 1000 }, NOW, settings);
    expect(result.progress.phase).toBe("learning");
    expect(result.progress.dueOrdinal).toBe(15);
    expect(result.progress.nextEligibleSpawn).toBe(14);
  });
});

describe("reconciliation and invariants", () => {
  it("retains IDs, adds new words to the current pool, and orphans removals", () => {
    const oldDeck = deck(30, "old", "stable");
    let level = freshLevel(oldDeck);
    level = updateWord(level, "stable-001", { attempts: 1, completeCorrect: 1 });
    const newDeck: LearningDeck = { id: "hsk-1", fingerprint: "new", words: [...oldDeck.words.slice(1), { id: "added" }] };
    const result = reconcileLevelProgress(level, newDeck);
    expect(result.report).toEqual({ retained: 29, added: 1, removed: 1 });
    expect(result.level.words.added).toBeDefined();
    expect(result.level.currentLevelWordIds).toContain("added");
    expect(result.level.activeLearningWordIds).toContain("added");
    expect(result.level.orphanedProgress["stable-000"]).toBeDefined();
    expect(countMastered(result.level)).toBe(0);
    expect(validateLevelInvariants(result.level, newDeck)).toEqual([]);
  });

  it("diagnoses malformed progress", () => {
    const source = deck(30);
    const valid = freshLevel(source);
    assertLevelInvariants(valid, source);
    const id = valid.activeLearningWordIds[0]!;
    const malformed = updateWord(valid, id, { attempts: 7, phase: "review", dueOrdinal: 4 });
    const errors = validateLevelInvariants(malformed, source);
    expect(errors.some((error) => error.includes("outcome counters"))).toBe(true);
    expect(errors.some((error) => error.includes("dueOrdinal must be null"))).toBe(true);
    expect(errors.some((error) => error.includes("graduated word is active"))).toBe(true);
    expect(errors.some((error) => error.includes("dueAt must be a valid timestamp"))).toBe(true);
    expect(() => assertLevelInvariants(malformed, source)).toThrow(/Invalid level progress/);
  });

  it("rejects due points inside the hard spacing floor", () => {
    const source = deck(30);
    let level = { ...freshLevel(source), nextSpawnOrdinal: 4 };
    const id = level.activeLearningWordIds[0]!;
    level = updateWord(level, id, { ...phasePatch("learning", 3, 0), lastSpawnOrdinal: 0, nextEligibleSpawn: 3, dueOrdinal: 4 });
    expect(validateLevelInvariants(level, source)).toEqual([]);
    const violated = updateWord(level, id, { dueOrdinal: 2 });
    expect(validateLevelInvariants(violated, source).some((error) => error.includes("hard spacing floor"))).toBe(true);
  });
});
