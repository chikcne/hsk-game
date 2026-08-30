import { describe, expect, it } from "vitest";
import type { LevelProgress, WordProgress } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { randomStateFromSeed } from "../../src/domain/random";
import {
  applyOutcome, applyOutcomeToLevel, assertLevelInvariants, correctRepeatInterval,
  countMastered, createLevelProgress, createWordProgress, curriculumOrder,
  eligibleTier, isEligible, reconcileLevelProgress, spawnNextWord, validateLevelInvariants,
  type LearningDeck,
} from "../../src/domain/learning";

const NOW = "2026-01-02T03:04:05.000Z";
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

describe("fixed sector levels and scheduler", () => {
  it("creates 20-word levels (600 words = 30 levels) without rolling replacements", () => {
    const source = deck(600);
    const level = freshLevel(source);
    expect(level.currentLevelWordIds).toHaveLength(20);
    expect(level.activeLearningWordIds).toEqual(level.currentLevelWordIds);
    expect(level.currentLevelWordIds).toEqual(curriculumOrder(source, "curriculum").slice(0, 20));
    expect(Math.ceil(source.words.length / settings.levelSize)).toBe(30);

    const masteredId = level.currentLevelWordIds[0]!;
    const result = applyOutcomeToLevel(updateWord(level, masteredId, { appearanceWeight: 2 }), source, masteredId, { kind: "correct", pinyinMs: 1000, meaningMs: 99_000 }, NOW, settings);
    expect(result.progress.appearanceWeight).toBe(1);
    expect(result.level.currentLevelWordIds).toEqual(level.currentLevelWordIds);
    expect(result.level.curriculumCursor).toBe(20);
  });

  it("advances only after the complete current pool is mastered", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const final = level.currentLevelWordIds.at(-1)!;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = updateWord(level, final, { appearanceWeight: 2 });
    level = { ...level, activeLearningWordIds: [final] };
    const result = applyOutcomeToLevel(level, source, final, { kind: "correct", pinyinMs: 1000, meaningMs: 50_000 }, NOW, settings);
    expect(result.transitions).toEqual(["levelCompleted"]);
    expect(result.level.currentLevelIndex).toBe(1);
    expect(result.level.currentLevelWordIds).toHaveLength(20);
    expect(result.level.activeLearningWordIds).toHaveLength(20);
    expect(result.level.reviewedOlderWordIds).toEqual([]);
  });

  it("requires every older sector word once and puts a lapsed older word in the level pool", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const oldIds = [...level.currentLevelWordIds];
    for (const id of oldIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = { ...level, activeLearningWordIds: [] };
    // An outcome on the completed first level starts level two.
    level = applyOutcomeToLevel(level, source, oldIds[0]!, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, NOW, settings).level;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = { ...level, activeLearningWordIds: [] };

    const lapse = applyOutcomeToLevel(level, source, oldIds[0]!, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, NOW, settings);
    expect(lapse.level.reviewedOlderWordIds).toContain(oldIds[0]);
    expect(lapse.level.activeLearningWordIds).toContain(oldIds[0]);
    expect(lapse.progress.appearanceWeight).toBe(41);
    expect(lapse.transitions).toEqual([]);
  });

  it("completes the sector only after every older word has been checked", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const oldIds = [...level.currentLevelWordIds];
    for (const id of oldIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = { ...level, activeLearningWordIds: [] };
    level = applyOutcomeToLevel(level, source, oldIds[0]!, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, NOW, settings).level;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = { ...level, activeLearningWordIds: [] };

    let lastTransitions: string[] = [];
    for (const id of oldIds) {
      const result = applyOutcomeToLevel(level, source, id, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, NOW, settings);
      level = result.level;
      lastTransitions = result.transitions;
    }
    expect(lastTransitions).toEqual(["sectorCompleted"]);
    expect(level.firstCompletedAt).toBe(NOW);
    expect(level.reviewedOlderWordIds).toHaveLength(20);
  });

  it("uses repair, learning, checkpoint, then sector-only fallback tiers", () => {
    let level = freshLevel(deck(40));
    const [repairId, learningId] = level.activeLearningWordIds;
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { nextEligibleSpawn: 100 });
    level = updateWord(level, repairId!, { nextEligibleSpawn: 0, reinforcementRemaining: 3 });
    level = updateWord(level, learningId!, { nextEligibleSpawn: 0 });
    expect(eligibleTier(level)?.tier).toBe("repair");
    level = updateWord(level, repairId!, { reinforcementRemaining: 0 });
    expect(eligibleTier(level)?.tier).toBe("learning");

    level = updateWord(level, repairId!, { nextEligibleSpawn: 100 });
    level = updateWord(level, learningId!, { nextEligibleSpawn: 100 });
    const olderId = Object.keys(level.words).find((id) => !level.currentLevelWordIds.includes(id))!;
    level = updateWord(level, olderId, { appearanceWeight: 1, introducedAtOrdinal: 0, nextEligibleSpawn: 0 });
    expect(eligibleTier(level)?.tier).toBe("checkpoint");
    level = { ...level, reviewedOlderWordIds: [olderId] };
    expect(eligibleTier(level)?.tier).toBe("fallback");
  });

  it("reserves spawned words and never selects unintroduced words", () => {
    const source = deck();
    const level = freshLevel(source);
    const result = spawnNextWord(level, source, undefined, settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(level.words[result.wordId]?.introducedAtOrdinal).not.toBeNull();
    expect(result.level.words[result.wordId]?.nextEligibleSpawn).toBe(result.spawnOrdinal + settings.mistakeRepeatPhrases + 1);
    expect(isEligible(result.level.words[result.wordId]!, result.level.nextSpawnOrdinal)).toBe(false);
  });

  it("does not deadlock when every other level word is in flight", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const inFlight = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const spawn = spawnNextWord(level, source, undefined, settings, inFlight);
      expect(spawn.status).toBe("spawned");
      if (spawn.status !== "spawned") return;
      level = spawn.level;
      inFlight.add(spawn.wordId);
    }
    expect(spawnNextWord(level, source, undefined, settings, inFlight).status).toBe("noEligibleWord");
    const resolved = [...inFlight][0]!;
    inFlight.delete(resolved);
    level = applyOutcomeToLevel(level, source, resolved, { kind: "landed", activeThinkingMs: null }, NOW, settings).level;
    const recovery = spawnNextWord(level, source, undefined, settings, inFlight);
    expect(recovery.status).toBe("spawned");
    if (recovery.status === "spawned") expect(recovery.wordId).toBe(resolved);
  });
});

describe("pinyin-only mastery and forced repeat points", () => {
  it("maps ten seconds to ten phrases and mistakes to five by default", () => {
    expect(correctRepeatInterval(10_000, settings)).toBe(10);
    expect(correctRepeatInterval(2_000, settings)).toBe(18);
    expect(applyOutcome(createWordProgress(), { kind: "wrongPinyin", pinyinMs: 1000 }, NOW, settings).repeatAfterPhrases).toBe(5);
  });

  it("ignores meaning time when determining mastery", () => {
    const quickMeaning = applyOutcome(createWordProgress(), { kind: "correct", pinyinMs: 2000, meaningMs: 10 }, NOW, settings);
    const slowMeaning = applyOutcome(createWordProgress(), { kind: "correct", pinyinMs: 2000, meaningMs: 100_000 }, NOW, settings);
    expect(quickMeaning.progress.appearanceWeight).toBe(45);
    expect(slowMeaning.progress.appearanceWeight).toBe(45);
    expect(quickMeaning.repeatAfterPhrases).toBe(slowMeaning.repeatAfterPhrases);
    expect(slowMeaning.progress.totalThinkingMs).toBeGreaterThan(quickMeaning.progress.totalThinkingMs);
  });

  it("treats pinyin over five seconds as a struggle and reduces mastery", () => {
    const update = applyOutcome({ ...createWordProgress(), appearanceWeight: 30 }, { kind: "correct", pinyinMs: 6000, meaningMs: 0 }, NOW, settings);
    expect(update.struggled).toBe(true);
    expect(update.progress.appearanceWeight).toBe(45);
    expect(update.progress.reinforcementRemaining).toBe(3);
    expect(update.repeatAfterPhrases).toBe(14);
  });

  it.each([
    { kind: "wrongPinyin", pinyinMs: 1000 } as const,
    { kind: "wrongMeaning", pinyinMs: 1000, meaningMs: 9000 } as const,
    { kind: "landed", activeThinkingMs: null } as const,
  ])("heavily penalizes $kind and schedules it after five phrases", (outcome) => {
    const update = applyOutcome({ ...createWordProgress(), appearanceWeight: 1 }, outcome, NOW, settings);
    expect(update.progress.appearanceWeight).toBe(41);
    expect(update.progress.reinforcementRemaining).toBe(3);
    expect(update.repeatAfterPhrases).toBe(5);
    expect(update.relapsed).toBe(true);
  });

  it("stores the forced due point from the resolution ordinal", () => {
    const source = deck();
    const level = { ...freshLevel(source), nextSpawnOrdinal: 12 };
    const id = level.currentLevelWordIds[0]!;
    const result = applyOutcomeToLevel(level, source, id, { kind: "wrongPinyin", pinyinMs: 1000 }, NOW, settings);
    expect(result.progress.nextEligibleSpawn).toBe(17);
  });

  it("maintains counters and pinyin timing stats", () => {
    let progress = createWordProgress();
    progress = applyOutcome(progress, { kind: "correct", pinyinMs: 1000, meaningMs: 50_000 }, NOW, settings).progress;
    progress = applyOutcome(progress, { kind: "wrongMeaning", pinyinMs: 2000, meaningMs: 1 }, NOW, settings).progress;
    expect(progress.attempts).toBe(2);
    expect(progress.totalPinyinMs).toBe(3000);
    expect(progress.fastestPinyinMs).toBe(1000);
    expect(progress.attempts).toBe(progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed);
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
    const malformed = updateWord(valid, id, { attempts: 7, appearanceWeight: 1, reinforcementRemaining: 3 });
    const errors = validateLevelInvariants(malformed, source);
    expect(errors.some((error) => error.includes("outcome counters"))).toBe(true);
    expect(errors.some((error) => error.includes("zero at weight 1"))).toBe(true);
    expect(errors.some((error) => error.includes("mastered word is active"))).toBe(true);
    expect(() => assertLevelInvariants(malformed, source)).toThrow(/Invalid level progress/);
  });
});
