import type { SaveSnapshot } from "../../src/server/saves/validation";
import { createDefaultSave } from "../../src/server/saves/repository";
import type { ComponentMemory, LevelProgress, WordProgress } from "../../src/shared/schemas";

export function makeMemory(state: ComponentMemory["state"] = "new"): ComponentMemory {
  return {
    state, due: "2025-01-01T00:00:00.000Z", stability: state === "new" ? 0 : 3, difficulty: state === "new" ? 0 : 5,
    elapsedDays: 0, scheduledDays: state === "new" ? 0 : 3, learningSteps: 0,
    reps: state === "new" ? 0 : 3, lapses: 0,
    lastReview: state === "new" ? null : "2024-12-29T00:00:00.000Z",
  };
}

export function makeWordProgress(introducedAtOrdinal: number | null = 0): WordProgress {
  return {
    card: makeMemory(),
    learnReviews: 0,
    lastSeenAt: null,
    introducedAtOrdinal,
  };
}

export function makeLevel(deckId: LevelProgress["deckId"], words: Record<string, WordProgress> = {}): LevelProgress {
  return {
    deckId,
    deckFingerprint: "fixture-fingerprint",
    curriculumCursor: Object.keys(words).length,
    firstCompletedAt: null,
    words,
    orphanedProgress: {},
  };
}

export function makeSnapshot(): SaveSnapshot {
  const { revision: _revision, savedAt: _savedAt, ...snapshot } = createDefaultSave(
    new Date("2025-01-01T00:00:00.000Z"),
  );
  return snapshot;
}

export function makeAcquiredReviewCard(): ComponentMemory {
  return {
    state: "review", due: "2025-01-01T00:00:00.000Z", stability: 3, difficulty: 5,
    elapsedDays: 0, scheduledDays: 3, learningSteps: 0, reps: 2, lapses: 0,
    lastReview: "2024-12-29T00:00:00.000Z",
  };
}

export function makeSnapshotWithAcquiredWord(wordId = "word-1"): SaveSnapshot {
  const snapshot = makeSnapshotWithWord(wordId);
  snapshot.levels["hsk-1"]!.words[wordId]!.card = makeAcquiredReviewCard();
  snapshot.levels["hsk-1"]!.words[wordId]!.learnReviews = 1;
  snapshot.acquiredWords = [`hsk-1:${wordId}`];
  return snapshot;
}

export function makeSnapshotWithRelearn(wordKeys: string[] = ["hsk-1:word-1"]): SaveSnapshot {
  const snapshot = makeSnapshotWithAcquiredWord(wordKeys[0]!.split(":")[1]!);
  snapshot.relearnSession = {
    startedAt: "2025-01-01T00:00:00.000Z",
    wordKeys,
    cards: Object.fromEntries(wordKeys.map((key) => [key, {
      card: makeMemory(),
      reviews: 0,
    }])),
  };
  return snapshot;
}

export function makeSnapshotWithWord(wordId = "word-1"): SaveSnapshot {
  const snapshot = makeSnapshot();
  snapshot.levels["hsk-1"] = makeLevel("hsk-1", { [wordId]: makeWordProgress() });
  return snapshot;
}

export function makeSnapshotWithSession(deckId: LevelProgress["deckId"], wordIds: string[]): SaveSnapshot {
  const snapshot = makeSnapshot();
  snapshot.levels[deckId] = makeLevel(deckId, Object.fromEntries(wordIds.map((id) => [id, makeWordProgress()])));
  snapshot.learnSessions[deckId] = {
    deckId,
    deckFingerprint: "fixture-fingerprint",
    startedAt: "2025-01-01T00:00:00.000Z",
    wordIds,
    completedWordIds: [],
    currentWordId: wordIds[0]!,
  };
  return snapshot;
}
