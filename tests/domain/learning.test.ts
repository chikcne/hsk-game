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

describe("rolling sector curriculum and scheduler", () => {
  it("replaces an individually mastered word without waiting for the rest of the pool", () => {
    const source = deck(600);
    const level = freshLevel(source);
    const order = curriculumOrder(source, "curriculum");
    expect(level.currentLevelWordIds).toEqual(order.slice(0, 20));
    expect(level.activeLearningWordIds).toEqual(level.currentLevelWordIds);

    const masteredId = level.currentLevelWordIds[0]!;
    const result = applyOutcomeToLevel(
      updateWord(level, masteredId, { appearanceWeight: 1 + settings.masteryCorrectDecrease }),
      source,
      masteredId,
      { kind: "correct", pinyinMs: 1000, meaningMs: 99_000 },
      NOW,
      settings,
    );
    expect(result.progress.appearanceWeight).toBe(1);
    expect(result.level.currentLevelWordIds).not.toContain(masteredId);
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
        updateWord(level, id, { appearanceWeight: 1 + settings.masteryCorrectDecrease }),
        source,
        id,
        { kind: "correct", pinyinMs: 1000, meaningMs: 0 },
        NOW,
        settings,
      );
      level = result.level;
    }
    expect(level.curriculumCursor).toBe(40);
    expect(level.currentLevelWordIds).toHaveLength(20);
    expect(level.currentLevelIndex).toBe(1);
  });

  it("gives practiced unmastered words a slight aggregate edge over new words", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const [practicedId, newId] = level.currentLevelWordIds;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { nextEligibleSpawn: 1_000_000 });
    let practicedSelections = 0;
    for (let trial = 0; trial < 1000; trial += 1) {
      level = updateWord(level, practicedId!, { attempts: 1, completeCorrect: 1, appearanceWeight: 70, nextEligibleSpawn: level.nextSpawnOrdinal });
      level = updateWord(level, newId!, { attempts: 0, completeCorrect: 0, appearanceWeight: 70, nextEligibleSpawn: level.nextSpawnOrdinal });
      const result = spawnNextWord(level, source, undefined, settings);
      expect(result.status).toBe("spawned");
      if (result.status !== "spawned") return;
      if (result.wordId === practicedId) practicedSelections += 1;
      level = result.level;
    }
    expect(practicedSelections).toBeGreaterThan(510);
    expect(practicedSelections).toBeLessThan(590);
  });

  it("returns a lapsed mastered word to the active repair pool", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const lapsedId = level.currentLevelWordIds[0]!;
    level = updateWord(level, lapsedId, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = { ...level, activeLearningWordIds: level.activeLearningWordIds.filter((id) => id !== lapsedId) };
    const lapse = applyOutcomeToLevel(level, source, lapsedId, { kind: "wrongMeaning", pinyinMs: 900, meaningMs: 100 }, NOW, settings);
    expect(lapse.level.activeLearningWordIds).toContain(lapsedId);
    expect(lapse.progress.reinforcementRemaining).toBe(settings.repairRepetitions);
    expect(lapse.transitions).toEqual([]);
  });

  it("completes the sector when the final word masters", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const final = level.currentLevelWordIds.at(-1)!;
    for (const id of level.currentLevelWordIds) level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    level = updateWord(level, final, { appearanceWeight: 1 + settings.masteryCorrectDecrease });
    level = { ...level, activeLearningWordIds: [final] };
    const result = applyOutcomeToLevel(level, source, final, { kind: "correct", pinyinMs: 1000, meaningMs: 0 }, NOW, settings);
    expect(result.transitions).toContain("sectorCompleted");
    expect(result.level.firstCompletedAt).toBe(NOW);
  });

  it("uses repair, learning, then mastered fallback tiers", () => {
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
    const fallbackId = Object.keys(level.words).find((id) => !level.currentLevelWordIds.includes(id))!;
    level = updateWord(level, fallbackId, { appearanceWeight: 1, introducedAtOrdinal: 0, nextEligibleSpawn: 0 });
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
    expect(quickMeaning.progress.appearanceWeight).toBe(21);
    expect(slowMeaning.progress.appearanceWeight).toBe(21);
    expect(quickMeaning.repeatAfterPhrases).toBe(slowMeaning.repeatAfterPhrases);
    expect(slowMeaning.progress.totalThinkingMs).toBeGreaterThan(quickMeaning.progress.totalThinkingMs);
  });

  it("starts new words at zero, promotes a correct answer to 80%, and keeps misses at zero", () => {
    const fresh = createWordProgress();
    expect(fresh.appearanceWeight).toBe(100);
    expect(applyOutcome(fresh, { kind: "correct", pinyinMs: 1000, meaningMs: 1000 }, NOW, settings).progress.appearanceWeight).toBe(21);
    expect(applyOutcome(fresh, { kind: "correct", pinyinMs: 9000, meaningMs: 1000 }, NOW, settings).progress.appearanceWeight).toBe(21);
    expect(applyOutcome(fresh, { kind: "wrongPinyin", pinyinMs: 1000 }, NOW, settings).progress.appearanceWeight).toBe(100);
  });

  it("treats pinyin over the configured threshold as a struggle", () => {
    const pinyinMs = settings.struggleThresholdMs + 1;
    const update = applyOutcome({ ...createWordProgress(), appearanceWeight: 30 }, { kind: "correct", pinyinMs, meaningMs: 0 }, NOW, settings);
    expect(update.struggled).toBe(true);
    expect(update.progress.appearanceWeight).toBe(30 + settings.masteryStruggleIncrease);
    expect(update.progress.reinforcementRemaining).toBe(settings.repairRepetitions);
    expect(update.repeatAfterPhrases).toBe(correctRepeatInterval(pinyinMs, settings));
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
