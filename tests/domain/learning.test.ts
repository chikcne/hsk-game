import { describe, expect, it } from "vitest";
import type { LevelProgress, WordProgress } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { randomStateFromSeed } from "../../src/domain/random";
import {
  advanceOrdinal, applyOutcomeToLevels, assertLevelInvariants, countGraduated, createLevelProgress,
  curriculumLessonNumber, curriculumOrder, introduceNewWords, reconcileLevelProgress, spawnNextWord,
  validateLevelInvariants, acquisitionWordIds,
  SESSION_WAIT_HORIZON_MS,
  type LearningDeck,
  type SchedulerSnapshot,
} from "../../src/domain/learning";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const settings = { ...DEFAULT_SETTINGS };
const SNAPSHOT: SchedulerSnapshot = { spawnOrdinal: 0, schedulerRng: randomStateFromSeed("scheduler") };

function deck(count = 200, fingerprint = "fingerprint-a", prefix = "word"): LearningDeck {
  return { id: "hsk-1", fingerprint, words: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(3, "0")}` })) };
}
function freshLevel(sourceDeck = deck(), levelSize = 20): LevelProgress {
  return createLevelProgress(sourceDeck, { curriculumSeed: "curriculum", levelSize, spawnOrdinal: 0 });
}
function updateWord(level: LevelProgress, id: string, patch: Partial<WordProgress>): LevelProgress {
  const progress = level.words[id]; if (!progress) throw new Error(`missing ${id}`);
  return { ...level, words: { ...level.words, [id]: { ...progress, ...patch } } };
}
/** Fast-forwards a word so it is due right now regardless of FSRS scheduling. */
function makeDue(level: LevelProgress, id: string, atMs = NOW - 1000): LevelProgress {
  const progress = level.words[id]!;
  return updateWord(level, id, {
    pinyin: { ...progress.pinyin, due: new Date(atMs).toISOString() },
    meaning: { ...progress.meaning, due: new Date(atMs).toISOString() },
  });
}
const spawnedIds = (result: ReturnType<typeof spawnNextWord>) =>
  result.status === "spawned" ? result.wordId : null;

describe("rolling grade curriculum and scheduler", () => {
  it("introduces the first pool at creation and derives the acquisition pool", () => {
    const source = deck(600);
    const level = freshLevel(source);
    const order = curriculumOrder(source, "curriculum");
    expect(acquisitionWordIds(level)).toHaveLength(20);
    expect(level.curriculumCursor).toBe(20);
    expect(acquisitionWordIds(level).sort()).toEqual(order.slice(0, 20).map((id) => id).sort());
    expect(curriculumLessonNumber(level, 20)).toBe(1);
  });

  it("introduces a new word only when a slot frees up after graduation", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const graduatingId = acquisitionWordIds(level)[0]!;
    // Graduate the word: both components in review stage.
    const graduated: WordProgress = {
      ...level.words[graduatingId]!,
      pinyin: { ...level.words[graduatingId]!.pinyin, state: "review", reps: 2, stability: 3, difficulty: 5, due: new Date(NOW + 86_400_000).toISOString(), lastReview: new Date(NOW).toISOString() },
      meaning: { ...level.words[graduatingId]!.meaning, state: "review", reps: 2, stability: 3, difficulty: 5, due: new Date(NOW + 86_400_000).toISOString(), lastReview: new Date(NOW).toISOString() },
    };
    level = updateWord(level, graduatingId, graduated);
    expect(acquisitionWordIds(level)).toHaveLength(19);

    const { level: refilled, introduced } = introduceNewWords(level, source, 20, 5);
    expect(introduced).toBe(1);
    expect(refilled.curriculumCursor).toBe(21);
    const order = curriculumOrder(source, "curriculum");
    const newId = order[20]!;
    expect(refilled.words[newId]?.introducedAtOrdinal).toBe(5);
  });

  it("spawns only due, cooled-down, introduced words and reserves the spawn", () => {
    const source = deck();
    const level = freshLevel(source);
    const result = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(level.words[result.wordId]?.introducedAtOrdinal).not.toBeNull();
    expect(result.level.words[result.wordId]?.lastSpawnOrdinal).toBe(0);
    expect(result.snapshot.spawnOrdinal).toBe(1);
    expect(result.tier).toBe("new");
  });

  it("never selects a cooling word (hard cooldown, no bypass)", () => {
    const source = deck(40);
    let level = freshLevel(source);
    // Everything due, one in flight: the only candidates are excluded/cooling.
    const first = acquisitionWordIds(level)[0]!;
    const inFlight = new Set(acquisitionWordIds(level).slice(1));
    const result = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings, inFlight);
    // The remaining candidate (first) is not excluded — it must be the spawn.
    expect(spawnedIds(result)).toBe(first);
    // Now exclude it too: nothing may spawn even though words are due.
    const blocked = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings, new Set(acquisitionWordIds(level)));
    expect(blocked.status).toBe("empty");
  });

  it("reports coolingOnly and lets ordinals advance instead of spawning early", () => {
    const source = deck(40);
    let level = freshLevel(source);
    // Answer every word so all are cooling + no longer due immediately.
    for (const id of acquisitionWordIds(level)) {
      const applied = applyOutcomeToLevels(
        { [source.id]: level }, source.id, id,
        { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, new Date(NOW), SNAPSHOT.spawnOrdinal, { pinyinLength: 5 },
      );
      level = applied.levels[source.id]!;
    }
    // All words: due in ~10m (learning step) — beyond the session horizon.
    expect(spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings).status).toBe("complete");

    // Make one word due NOW but leave it ordinal-blocked.
    const first = acquisitionWordIds(level)[0]!;
    level = makeDue(level, first);
    const cooling = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings);
    expect(cooling.status).toBe("empty");
    if (cooling.status !== "empty") return;
    expect(cooling.coolingOnly).toBe(true);

    // Advance ordinals on the empty-field clock until the cooldown elapses.
    let snapshot = SNAPSHOT;
    let result = spawnNextWord(level, source, new Date(NOW), snapshot, settings);
    let guard = 0;
    while (result.status === "empty" && result.coolingOnly && guard < 50) {
      snapshot = advanceOrdinal(snapshot);
      result = spawnNextWord(level, source, new Date(NOW), snapshot, settings);
      guard += 1;
    }
    expect(result.status).toBe("spawned");
    if (result.status === "spawned") expect(result.wordId).toBe(first);
    expect(guard).toBeGreaterThanOrEqual(3); // cooldown was actually respected
  });

  it("ends the session when nothing comes due within the horizon", () => {
    const source = deck(40);
    const base = freshLevel(source);
    let level = base;
    // Push every word far into the future.
    for (const id of acquisitionWordIds(base)) level = makeDue(level, id, NOW + 30 * 86_400_000);
    expect(spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings).status).toBe("complete");

    // One card coming due inside the horizon keeps the session waiting.
    const firstId = acquisitionWordIds(base)[0]!;
    const soon = makeDue(level, firstId, NOW + 60_000);
    expect(spawnNextWord(soon, source, new Date(NOW), SNAPSHOT, settings).status).toBe("empty");
    expect(SESSION_WAIT_HORIZON_MS).toBe(120_000);
  });

  it("prioritizes relearning over learning and new words, earliest due first", () => {
    const source = deck(40);
    let level = freshLevel(source);
    const [relearningId, learningId, newId] = acquisitionWordIds(level);
    const due = new Date(NOW - 1000).toISOString();
    const lastReview = new Date(NOW - 2000).toISOString();
    level = updateWord(level, relearningId!, { pinyin: { ...level.words[relearningId!]!.pinyin, state: "relearning", reps: 3, lapses: 1, difficulty: 5, due, lastReview }, meaning: { ...level.words[relearningId!]!.meaning, state: "review", reps: 3, due, lastReview } });
    level = updateWord(level, learningId!, { pinyin: { ...level.words[learningId!]!.pinyin, state: "learning", reps: 1, due, lastReview }, meaning: { ...level.words[learningId!]!.meaning, state: "new", due, lastReview: null } });
    level = makeDue(level, newId!);
    const result = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.wordId).toBe(relearningId);
    expect(result.tier).toBe("relearning");
  });

  it("serves due graduated words as the lowest maintenance tier", () => {
    const source = deck(20); // whole grade graduated: no introductions remain
    let level = freshLevel(source);
    const maintenanceId = acquisitionWordIds(level)[0]!;
    // Graduate every introduced word; only one comes due right now.
    for (const id of acquisitionWordIds(level)) {
      const due = NOW + 8 * 86_400_000;
      level = updateWord(level, id, {
        pinyin: { ...level.words[id]!.pinyin, state: "review", reps: 2, stability: 3, difficulty: 5, due: new Date(due).toISOString(), lastReview: new Date(due).toISOString() },
        meaning: { ...level.words[id]!.meaning, state: "review", reps: 2, stability: 3, difficulty: 5, due: new Date(due).toISOString(), lastReview: new Date(due).toISOString() },
      });
    }
    level = updateWord(level, maintenanceId, {
      pinyin: { ...level.words[maintenanceId]!.pinyin, due: new Date(NOW - 1000).toISOString() },
    });
    const result = spawnNextWord(level, source, new Date(NOW), SNAPSHOT, settings);
    expect(result.status).toBe("spawned");
    if (result.status !== "spawned") return;
    expect(result.wordId).toBe(maintenanceId);
    expect(result.tier).toBe("review");
  });
});

describe("outcome application, graduation, and grade completion", () => {
  it("applies the outcome cooldown from the current global ordinal", () => {
    const source = deck();
    const level = { ...freshLevel(source) };
    const id = acquisitionWordIds(level)[0]!;
    const result = applyOutcomeToLevels(
      { [source.id]: level }, source.id, id,
      { kind: "wrongPinyin", pinyinMs: 1000 }, new Date(NOW), 12, { pinyinLength: 5 },
    );
    expect(result.progress.nextEligibleSpawn).toBe(15); // 12 + AGAIN_COOLDOWN(3)
    expect(result.progress.pinyin.state).toBe("learning");
    expect(result.struggled).toBe(true);
  });

  it("completes the grade when the final word graduates and records it once", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const finalId = acquisitionWordIds(level)[0]!;
    for (const id of acquisitionWordIds(level)) {
      const due = new Date(NOW + 86_400_000).toISOString();
      const last = new Date(NOW).toISOString();
      level = updateWord(level, id, {
        pinyin: { ...level.words[id]!.pinyin, state: "review", reps: 2, stability: 3, difficulty: 5, due, lastReview: last },
        meaning: { ...level.words[id]!.meaning, state: "review", reps: 2, stability: 3, difficulty: 5, due, lastReview: last },
      });
    }
    level = updateWord(level, finalId, {
      pinyin: { ...level.words[finalId]!.pinyin, state: "relearning", reps: 3, lapses: 1, difficulty: 5, stability: 0.5 },
    });
    expect(countGraduated(level)).toBe(19);

    const result = applyOutcomeToLevels(
      { [source.id]: level }, source.id, finalId,
      { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, new Date(NOW), 0, { pinyinLength: 5 },
    );
    expect(result.transitions).toContain("gradeCompleted");
    expect(result.levels[source.id]!.firstCompletedAt).toBe(new Date(NOW).toISOString());
    expect(countGraduated(result.levels[source.id]!)).toBe(20);
  });

  it("reports regression when a graduated word lapses", () => {
    const source = deck(20);
    let level = freshLevel(source);
    const victim = acquisitionWordIds(level)[0]!;
    for (const id of acquisitionWordIds(level)) {
      const due = new Date(NOW + 86_400_000).toISOString();
      const last = new Date(NOW).toISOString();
      level = updateWord(level, id, {
        pinyin: { ...level.words[id]!.pinyin, state: "review", reps: 2, stability: 3, difficulty: 5, due, lastReview: last },
        meaning: { ...level.words[id]!.meaning, state: "review", reps: 2, stability: 3, difficulty: 5, due, lastReview: last },
      });
    }
    level = { ...level, firstCompletedAt: "2025-12-01T00:00:00.000Z" };
    const result = applyOutcomeToLevels(
      { [source.id]: level }, source.id, victim,
      { kind: "wrongPinyin", pinyinMs: 900 }, new Date(NOW), 0, { pinyinLength: 5 },
    );
    expect(result.transitions).toContain("gradeMasteryRegressed");
    expect(result.levels[source.id]!.firstCompletedAt).toBe("2025-12-01T00:00:00.000Z"); // milestone is permanent
  });
});

describe("reconciliation and invariants", () => {
  it("retains IDs and memory, adds new words to the pool, and orphans removals", () => {
    const oldDeck = deck(30, "old", "stable");
    let level = freshLevel(oldDeck);
    level = updateWord(level, "stable-001", { attempts: 1, completeCorrect: 1 });
    const newDeck: LearningDeck = { id: "hsk-1", fingerprint: "new", words: [...oldDeck.words.slice(1), { id: "added" }] };
    const result = reconcileLevelProgress(level, newDeck, 7);
    expect(result.report).toEqual({ retained: 29, added: 1, removed: 1 });
    expect(result.level.words.added).toBeDefined();
    expect(result.level.words.added?.introducedAtOrdinal).toBe(7);
    expect(result.level.orphanedProgress["stable-000"]).toBeDefined();
    expect(result.level.deckFingerprint).toBe("new");
    expect(countGraduated(result.level)).toBe(0);
    expect(validateLevelInvariants(result.level, newDeck, 7)).toEqual([]);
  });

  it("diagnoses malformed progress", () => {
    const source = deck(30);
    const valid = freshLevel(source);
    assertLevelInvariants(valid, source, 0);
    const id = acquisitionWordIds(valid)[0]!;
    const malformed = updateWord(valid, id, { attempts: 7 });
    const errors = validateLevelInvariants(malformed, source, 0);
    expect(errors.some((error) => error.includes("outcome counters"))).toBe(true);
    expect(() => assertLevelInvariants(malformed, source, 0)).toThrow(/Invalid level progress/);
  });
});
