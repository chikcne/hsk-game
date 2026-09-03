import { describe, expect, it } from "vitest";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { applyOutcomeToLevels, createLevelProgress, spawnNextWord, type SchedulerSnapshot } from "../../src/domain/learning";
import { randomStateFromSeed } from "../../src/domain/random";
import { generateChoices } from "../../src/domain/session/choices";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";

describe("playable runtime slice", () => {
  it("schedules a word, creates choices, and records one durable FSRS outcome", () => {
    const deck = createDemoDeck("hsk-1");
    const snapshot: SchedulerSnapshot = { spawnOrdinal: 0, schedulerRng: randomStateFromSeed("schedule") };
    const level = createLevelProgress(deck, {
      curriculumSeed: "curriculum",
      levelSize: DEFAULT_SETTINGS.levelSize,
      spawnOrdinal: snapshot.spawnOrdinal,
    });
    const now = new Date("2026-01-01T00:00:00Z");
    const spawn = spawnNextWord(level, deck, now, snapshot, DEFAULT_SETTINGS);
    expect(spawn.status).toBe("spawned");
    if (spawn.status !== "spawned") return;
    const word = deck.words.find((item) => item.id === spawn.wordId)!;
    expect(generateChoices(deck, word, "enemy-1")).toHaveLength(8);

    const result = applyOutcomeToLevels(
      { "hsk-1": spawn.level },
      "hsk-1",
      word.id,
      { kind: "correct", pinyinMs: 1200, meaningMs: 900 },
      now,
      spawn.snapshot.spawnOrdinal,
      { pinyinLength: 5 },
    );
    expect(result.progress.attempts).toBe(1);
    expect(result.progress.pinyin.reps).toBe(1);
    expect(result.progress.pinyin.state).toBe("learning");
    expect(result.progress.meaning.reps).toBe(1);
    expect(result.progress.nextEligibleSpawn).toBeGreaterThan(spawn.snapshot.spawnOrdinal);
  });
});
