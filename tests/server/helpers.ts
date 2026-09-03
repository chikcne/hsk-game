import type { SaveSnapshot } from "../../src/server/saves/validation";
import { createDefaultSave } from "../../src/server/saves/repository";

export function makeSnapshot(): SaveSnapshot {
  const { revision: _revision, savedAt: _savedAt, ...snapshot } = createDefaultSave(
    new Date("2025-01-01T00:00:00.000Z"),
  );
  return snapshot;
}

export function makeSnapshotWithWord(wordId = "word-1"): SaveSnapshot {
  const snapshot = makeSnapshot();
  snapshot.levels["hsk-1"] = {
    deckId: "hsk-1",
    deckFingerprint: "fixture-fingerprint",
    nextSpawnOrdinal: 1,
    schedulerRng: [0, 1, 2, 0xffff_ffff],
    curriculumSeed: "fixture-seed",
    curriculumCursor: 1,
    currentLevelIndex: 0,
    currentLevelWordIds: [wordId],
    activeLearningWordIds: [wordId],
    reviewedOlderWordIds: [],
    firstCompletedAt: null,
    words: {
      [wordId]: {
        phase: "learning",
        stepIndex: 0,
        dueOrdinal: 3,
        dueAt: null,
        stability: 0,
        difficulty: 5,
        lapses: 0,
        lastGrade: null,
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
        nextEligibleSpawn: 3,
      },
    },
    orphanedProgress: {},
  };
  return snapshot;
}
