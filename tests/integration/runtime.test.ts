import { describe, expect, it } from "vitest";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { createLevelProgress, spawnNextWord, applyOutcomeToLevel } from "../../src/domain/learning";
import { randomStateFromSeed } from "../../src/domain/random";
import { generateChoices } from "../../src/domain/session/choices";

describe("playable runtime slice", () => {
  it("schedules a word, creates choices, and records one durable outcome", () => {
    const deck = createDemoDeck("hsk-1");
    const level = createLevelProgress(deck, { schedulerRng: randomStateFromSeed("schedule"), curriculumSeed: "curriculum" });
    const spawn = spawnNextWord(level, deck);
    expect(spawn.status).toBe("spawned");
    if (spawn.status !== "spawned") return;
    const word = deck.words.find((item) => item.id === spawn.wordId)!;
    expect(generateChoices(deck, word, "enemy-1")).toHaveLength(8);
    const result = applyOutcomeToLevel(spawn.level, deck, word.id, { kind: "correct", pinyinMs: 1200, meaningMs: 900 }, new Date("2026-01-01T00:00:00Z"));
    expect(result.progress.attempts).toBe(1);
    expect(result.progress.appearanceWeight).toBe(21);
    expect(result.level.nextSpawnOrdinal).toBe(1);
  });
});
