import type { SaveSnapshot } from "../../src/server/saves/validation";
import { createDefaultSave } from "../../src/server/saves/repository";
import type { ComponentMemory, WordProgress } from "../../src/shared/schemas";

export function makeMemory(state: ComponentMemory["state"] = "new"): ComponentMemory {
  return {
    state, due: "2025-01-01T00:00:00.000Z", stability: state === "new" ? 0 : 3, difficulty: state === "new" ? 0 : 5,
    elapsedDays: 0, scheduledDays: state === "new" ? 0 : 3, learningSteps: 0,
    reps: state === "new" ? 0 : 3, lapses: 0,
    lastReview: state === "new" ? null : "2024-12-29T00:00:00.000Z",
  };
}

export function makeWordProgress(): WordProgress {
  return {
    pinyin: makeMemory(),
    meaning: makeMemory(),
    attempts: 0,
    completeCorrect: 0,
    wrongPinyin: 0,
    wrongMeaning: 0,
    landed: 0,
    totalThinkingMs: 0,
    fastestCorrectMs: null,
    totalPinyinMs: 0,
    fastestPinyinMs: null,
    lastPinyinMs: null,
    lastOutcome: null,
    lastSeenAt: null,
    introducedAtOrdinal: 0,
    lastSpawnOrdinal: 0,
    nextEligibleSpawn: 11,
  };
}

export function makeSnapshot(): SaveSnapshot {
  const { revision: _revision, savedAt: _savedAt, ...snapshot } = createDefaultSave(
    new Date("2025-01-01T00:00:00.000Z"),
  );
  return snapshot;
}

export function makeSnapshotWithWord(wordId = "word-1"): SaveSnapshot {
  const snapshot = makeSnapshot();
  snapshot.spawnOrdinal = 1; // the word's lastSpawnOrdinal(0) must precede the current ordinal
  snapshot.levels["hsk-1"] = {
    deckId: "hsk-1",
    deckFingerprint: "fixture-fingerprint",
    curriculumSeed: "fixture-seed",
    curriculumCursor: 1,
    firstCompletedAt: null,
    words: {
      [wordId]: makeWordProgress(),
    },
    orphanedProgress: {},
  };
  return snapshot;
}
