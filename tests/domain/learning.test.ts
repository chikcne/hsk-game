import { describe, expect, it } from "vitest";
import type { LevelProgress, WordProgress } from "../../src/shared/schemas";
import { randomStateFromSeed, Xoshiro128StarStar } from "../../src/domain/random";
import {
  applyOutcome,
  applyOutcomeToLevel,
  assertLevelInvariants,
  correctWeightDecrease,
  countMastered,
  createLevelProgress,
  createWordProgress,
  curriculumOrder,
  effectiveAppearanceWeight,
  eligibleAge,
  eligibleTier,
  isEligible,
  isLiveMastered,
  reconcileLevelProgress,
  spawnNextWord,
  validateLevelInvariants,
  type LearningDeck,
} from "../../src/domain/learning";

const NOW = "2026-01-02T03:04:05.000Z";

function deck(count = 200, fingerprint = "fingerprint-a", prefix = "word"): LearningDeck {
  return {
    id: "hsk-1",
    fingerprint,
    words: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(3, "0")}` })),
  };
}

function freshLevel(sourceDeck = deck()): LevelProgress {
  return createLevelProgress(sourceDeck, {
    schedulerRng: randomStateFromSeed("scheduler"),
    curriculumSeed: "curriculum",
  });
}

function updateWord(
  level: LevelProgress,
  id: string,
  patch: Partial<WordProgress>,
): LevelProgress {
  const progress = level.words[id];
  if (progress === undefined) throw new Error(`missing ${id}`);
  return { ...level, words: { ...level.words, [id]: { ...progress, ...patch } } };
}

function runSchedule(start: LevelProgress, sourceDeck: LearningDeck, count: number): { level: LevelProgress; ids: string[] } {
  let level = start;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = spawnNextWord(level, sourceDeck);
    if (result.status !== "spawned") throw new Error(`unexpected no candidate at ${index}`);
    level = result.level;
    ids.push(result.wordId);
  }
  return { level, ids };
}

describe("curriculum and scheduler", () => {
  it("introduces a deterministic unique set of 30 and refills the next unseen word", () => {
    const sourceDeck = deck();
    const first = freshLevel(sourceDeck);
    const second = freshLevel(sourceDeck);
    expect(first.activeLearningWordIds).toHaveLength(30);
    expect(new Set(first.activeLearningWordIds).size).toBe(30);
    expect(second.activeLearningWordIds).toEqual(first.activeLearningWordIds);
    expect(first.activeLearningWordIds).toEqual(curriculumOrder(sourceDeck, "curriculum").slice(0, 30));
    expect(Object.values(first.words).filter((word) => word.introducedAtOrdinal !== null)).toHaveLength(30);

    const masteredId = first.activeLearningWordIds[0]!;
    const result = applyOutcomeToLevel(
      updateWord(first, masteredId, { appearanceWeight: 5 }),
      sourceDeck,
      masteredId,
      { kind: "correct", pinyinMs: 6000, meaningMs: 6000 },
      NOW,
    );
    expect(result.progress.appearanceWeight).toBe(1);
    expect(result.level.activeLearningWordIds).toHaveLength(30);
    expect(result.level.activeLearningWordIds).not.toContain(masteredId);
    expect(new Set(result.level.activeLearningWordIds).size).toBe(30);
    expect(Object.values(result.level.words).filter((word) => word.introducedAtOrdinal !== null)).toHaveLength(31);
  });

  it("uses exact absolute cooldown semantics", () => {
    let progress = { ...createWordProgress(), introducedAtOrdinal: 0, lastSpawnOrdinal: 100, nextEligibleSpawn: 111 };
    for (let ordinal = 101; ordinal <= 110; ordinal += 1) expect(isEligible(progress, ordinal)).toBe(false);
    expect(isEligible(progress, 111)).toBe(true);
    progress = { ...progress, nextEligibleSpawn: 126 };
    for (let ordinal = 101; ordinal <= 125; ordinal += 1) expect(isEligible(progress, ordinal)).toBe(false);
    expect(isEligible(progress, 126)).toBe(true);
  });

  it("prioritizes repair, then learning, then introduced mastered fallback", () => {
    let level = freshLevel();
    const [repairId, learningId] = level.activeLearningWordIds;
    if (repairId === undefined || learningId === undefined) throw new Error("fixture");
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { nextEligibleSpawn: 100 });
    level = updateWord(level, repairId, { nextEligibleSpawn: 0, reinforcementRemaining: 3 });
    level = updateWord(level, learningId, { nextEligibleSpawn: 0 });
    expect(eligibleTier(level)?.tier).toBe("repair");
    expect(eligibleTier(level)?.candidates.map((entry) => entry.id)).toEqual([repairId]);

    level = updateWord(level, repairId, { reinforcementRemaining: 0 });
    expect(eligibleTier(level)?.tier).toBe("learning");
    expect(eligibleTier(level)?.candidates.map((entry) => entry.id).sort()).toEqual([learningId, repairId].sort());

    level = updateWord(level, repairId, { nextEligibleSpawn: 100 });
    level = updateWord(level, learningId, { nextEligibleSpawn: 100 });
    const fallbackId = Object.keys(level.words).find((id) => !level.activeLearningWordIds.includes(id))!;
    level = updateWord(level, fallbackId, {
      appearanceWeight: 1,
      reinforcementRemaining: 0,
      introducedAtOrdinal: 0,
    });
    expect(eligibleTier(level)?.tier).toBe("fallback");
    expect(eligibleTier(level)?.candidates.map((entry) => entry.id)).toEqual([fallbackId]);
  });

  it("never selects unintroduced words and reports corruption without violating cooldown", () => {
    let level = freshLevel();
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { nextEligibleSpawn: 50 });
    const result = spawnNextWord(level, deck());
    expect(result.status).toBe("noEligibleWord");
    if (result.status === "noEligibleWord") {
      expect(result.spawnOrdinal).toBe(0);
      expect(result.diagnostics.coolingCount).toBe(30);
      expect(result.level.nextSpawnOrdinal).toBe(0);
    }
  });

  it("enforces cooldown over a 100,000-spawn seeded simulation", () => {
    const sourceDeck = deck();
    let level = freshLevel(sourceDeck);
    const last = new Map<string, number>();
    for (let index = 0; index < 100_000; index += 1) {
      const result = spawnNextWord(level, sourceDeck);
      if (result.status !== "spawned") throw new Error(`no candidate at ${index}`);
      const previous = last.get(result.wordId);
      if (previous !== undefined) expect(result.spawnOrdinal - previous - 1).toBeGreaterThanOrEqual(10);
      last.set(result.wordId, result.spawnOrdinal);
      level = result.level;
    }
    expect(level.nextSpawnOrdinal).toBe(100_000);
    expect(validateLevelInvariants(level, sourceDeck)).toEqual([]);
  }, 20_000);

  it("resumes to an identical schedule from serialized state", () => {
    const sourceDeck = deck();
    const initial = freshLevel(sourceDeck);
    const uninterrupted = runSchedule(initial, sourceDeck, 4000);
    const firstHalf = runSchedule(initial, sourceDeck, 2000);
    const loaded = JSON.parse(JSON.stringify(firstHalf.level)) as LevelProgress;
    const secondHalf = runSchedule(loaded, sourceDeck, 2000);
    expect([...firstHalf.ids, ...secondHalf.ids]).toEqual(uninterrupted.ids);
    expect(secondHalf.level).toEqual(uninterrupted.level);
  });

  it("weights equal-age candidates and caps age boost", () => {
    const sourceDeck = deck();
    let level = freshLevel(sourceDeck);
    const [heavy, light] = level.activeLearningWordIds;
    if (heavy === undefined || light === undefined) throw new Error("fixture");
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { nextEligibleSpawn: 1_000_000 });
    let heavySelections = 0;
    for (let trial = 0; trial < 5000; trial += 1) {
      const origin = Math.max(0, level.nextSpawnOrdinal - 1);
      level = updateWord(level, heavy, { appearanceWeight: 100, nextEligibleSpawn: 0, lastSpawnOrdinal: origin });
      level = updateWord(level, light, { appearanceWeight: 10, nextEligibleSpawn: 0, lastSpawnOrdinal: origin });
      const result = spawnNextWord(level, sourceDeck);
      if (result.status !== "spawned") throw new Error("fixture");
      if (result.wordId === heavy) heavySelections += 1;
      level = result.level;
    }
    expect(heavySelections).toBeGreaterThan(4300);
    expect(heavySelections).toBeLessThan(4800);

    const progress = { ...createWordProgress(), introducedAtOrdinal: 0, lastSpawnOrdinal: 0 };
    expect(eligibleAge(progress, 25)).toBe(0);
    expect(effectiveAppearanceWeight(progress, 25)).toBe(70);
    expect(effectiveAppearanceWeight(progress, 10_000)).toBe(175);
  });

  it("uses deterministic anti-starvation ordering before lottery", () => {
    const sourceDeck = deck();
    let level = { ...freshLevel(sourceDeck), nextSpawnOrdinal: 200 };
    const [starvedLow, starvedHigh, ordinary] = level.activeLearningWordIds;
    if (starvedLow === undefined || starvedHigh === undefined || ordinary === undefined) throw new Error("fixture");
    for (const id of level.activeLearningWordIds) level = updateWord(level, id, { nextEligibleSpawn: 999 });
    level = updateWord(level, starvedLow, { appearanceWeight: 10, lastSpawnOrdinal: 25, nextEligibleSpawn: 36 });
    level = updateWord(level, starvedHigh, { appearanceWeight: 80, lastSpawnOrdinal: 25, nextEligibleSpawn: 36 });
    level = updateWord(level, ordinary, { appearanceWeight: 100, lastSpawnOrdinal: 100, nextEligibleSpawn: 111 });
    const result = spawnNextWord(level, sourceDeck, new Xoshiro128StarStar(randomStateFromSeed("ignored-lottery")));
    expect(result.status).toBe("spawned");
    if (result.status === "spawned") expect(result.wordId).toBe(starvedHigh);
  });
});

describe("mastery updates and completion", () => {
  it("implements speed boundaries and midpoint", () => {
    expect(correctWeightDecrease(2500)).toBe(16);
    expect(correctWeightDecrease(7250)).toBe(10);
    expect(correctWeightDecrease(12_000)).toBe(4);
    expect(correctWeightDecrease(99_000)).toBe(4);
    expect(() => correctWeightDecrease(-1)).toThrow(/nonnegative/);
  });

  it("updates correct counters, timing, lower bound, and repairs immutably", () => {
    const source = { ...createWordProgress(), appearanceWeight: 10, reinforcementRemaining: 3 as const };
    const first = applyOutcome(source, { kind: "correct", pinyinMs: 1000, meaningMs: 1000 }, NOW);
    expect(first.progress).toMatchObject({
      appearanceWeight: 1,
      attempts: 1,
      completeCorrect: 1,
      totalThinkingMs: 2000,
      fastestCorrectMs: 2000,
      reinforcementRemaining: 0,
      lastOutcome: "correct",
      lastSeenAt: NOW,
    });
    expect(source.attempts).toBe(0);
    const second = applyOutcome(
      { ...createWordProgress(), appearanceWeight: 80, reinforcementRemaining: 3 },
      { kind: "correct", pinyinMs: 6000, meaningMs: 6000 },
      NOW,
    );
    expect(second.progress.appearanceWeight).toBe(76);
    expect(second.progress.reinforcementRemaining).toBe(2);
  });

  it.each([
    ["wrongPinyin", { kind: "wrongPinyin", pinyinMs: 1000 } as const, 30],
    ["wrongMeaning", { kind: "wrongMeaning", pinyinMs: 1000, meaningMs: 2000 } as const, 30],
    ["landed", { kind: "landed", activeThinkingMs: null } as const, 35],
  ])("applies capped %s penalties and three repairs", (_label, outcome, increase) => {
    const update = applyOutcome({ ...createWordProgress(), appearanceWeight: 80 }, outcome, NOW);
    expect(update.progress.appearanceWeight).toBe(100);
    expect(update.progress.reinforcementRemaining).toBe(3);
    expect(update.weightDelta).toBe(20);
    const lapse = applyOutcome({ ...createWordProgress(), appearanceWeight: 1 }, outcome, NOW);
    expect(lapse.progress.appearanceWeight).toBe(1 + increase);
    expect(lapse.relapsed).toBe(true);
  });

  it("maintains the attempts outcome-counter invariant across arbitrary sequences", () => {
    let progress = createWordProgress();
    const outcomes = [
      { kind: "correct", pinyinMs: 100, meaningMs: 200 } as const,
      { kind: "wrongPinyin", pinyinMs: 300 } as const,
      { kind: "wrongMeaning", pinyinMs: 100, meaningMs: 500 } as const,
      { kind: "landed", activeThinkingMs: 900 } as const,
    ];
    for (let index = 0; index < 1000; index += 1) {
      progress = applyOutcome(progress, outcomes[index % outcomes.length]!, NOW).progress;
      expect(progress.attempts).toBe(
        progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed,
      );
    }
  });

  it("sets completion once, preserves it on later correct, and reports regression", () => {
    const sourceDeck = deck(26);
    let level = freshLevel(sourceDeck);
    for (const id of Object.keys(level.words)) {
      level = updateWord(level, id, { appearanceWeight: 1, reinforcementRemaining: 0 });
    }
    const finalId = Object.keys(level.words)[0]!;
    level = updateWord(level, finalId, { appearanceWeight: 5 });
    level = { ...level, activeLearningWordIds: [finalId], curriculumCursor: 26 };
    const completed = applyOutcomeToLevel(
      level,
      sourceDeck,
      finalId,
      { kind: "correct", pinyinMs: 6000, meaningMs: 6000 },
      NOW,
    );
    expect(completed.transitions).toEqual(["levelCompleted"]);
    expect(completed.level.firstCompletedAt).toBe(NOW);
    expect(isLiveMastered(completed.level)).toBe(true);
    expect(countMastered(completed.level)).toBe(26);

    const later = applyOutcomeToLevel(
      completed.level,
      sourceDeck,
      finalId,
      { kind: "correct", pinyinMs: 100, meaningMs: 100 },
      "2027-01-01T00:00:00Z",
    );
    expect(later.level.firstCompletedAt).toBe(NOW);
    expect(later.transitions).toEqual([]);

    const regressed = applyOutcomeToLevel(
      later.level,
      sourceDeck,
      finalId,
      { kind: "landed", activeThinkingMs: null },
      "2028-01-01T00:00:00Z",
    );
    expect(regressed.transitions).toEqual(["levelMasteryRegressed"]);
    expect(regressed.level.firstCompletedAt).toBe(NOW);
    expect(regressed.progress.appearanceWeight).toBe(36);
    expect(regressed.progress.reinforcementRemaining).toBe(3);
    expect(regressed.level.activeLearningWordIds).toContain(finalId);
  });
});

describe("reconciliation and invariants", () => {
  it("retains stable IDs, initializes additions, and orphans removals", () => {
    const oldDeck = deck(30, "old", "stable");
    let level = freshLevel(oldDeck);
    level = updateWord(level, "stable-001", { attempts: 1, completeCorrect: 1 });
    level = { ...level, firstCompletedAt: NOW };
    const newDeck: LearningDeck = {
      id: "hsk-1",
      fingerprint: "new",
      words: [...oldDeck.words.slice(1), { id: "added" }],
    };
    const result = reconcileLevelProgress(level, newDeck);
    expect(result.report).toEqual({ retained: 29, added: 1, removed: 1 });
    expect(result.level.words["stable-001"]?.attempts).toBe(1);
    expect(result.level.words.added).toMatchObject({ appearanceWeight: 70, attempts: 0 });
    expect(result.level.orphanedProgress["stable-000"]).toBeDefined();
    expect(result.level.firstCompletedAt).toBe(NOW);
    expect(result.level.deckFingerprint).toBe("new");
    expect(validateLevelInvariants(result.level, newDeck)).toEqual([]);
  });

  it("diagnoses malformed progress and assertion reports all failures", () => {
    const sourceDeck = deck(30);
    const valid = freshLevel(sourceDeck);
    expect(validateLevelInvariants(valid, sourceDeck)).toEqual([]);
    assertLevelInvariants(valid, sourceDeck);

    const id = valid.activeLearningWordIds[0]!;
    const malformed = updateWord(valid, id, {
      attempts: 7,
      appearanceWeight: 1,
      reinforcementRemaining: 3,
      lastSpawnOrdinal: 0,
      nextEligibleSpawn: 5,
    });
    const errors = validateLevelInvariants(malformed, sourceDeck);
    expect(errors.some((error) => error.includes("outcome counters"))).toBe(true);
    expect(errors.some((error) => error.includes("zero at weight 1"))).toBe(true);
    expect(errors.some((error) => error.includes("ten-other-spawns"))).toBe(true);
    expect(errors.some((error) => error.includes("mastered word is active"))).toBe(true);
    expect(() => assertLevelInvariants(malformed, sourceDeck)).toThrow(/Invalid level progress/);
  });
});
