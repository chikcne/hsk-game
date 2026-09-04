import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeckCatalog } from "../../src/server/saves/manifests";
import {
  RevisionConflictError,
  SaveRepository,
} from "../../src/server/saves/repository";
import { parseSaveSnapshot } from "../../src/server/saves/validation";
import type { AtomicWriteStage } from "../../src/server/saves/atomic-writer";
import { makeSnapshot, makeSnapshotWithAcquiredWord, makeSnapshotWithRelearn, makeSnapshotWithSession, makeSnapshotWithWord, makeWordProgress, makeAcquiredReviewCard } from "./helpers";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hanzi-saves-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}

describe("SaveRepository", () => {
  it("returns a valid first-run default and assigns server revisions", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({
      directory,
      now: clock("2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z"),
    });
    await repository.initialize();

    const initial = await repository.load();
    expect(initial.firstRun).toBe(true);
    expect(initial.save.revision).toBe(0);

    const written = await repository.save(0, makeSnapshot());
    expect(written).toMatchObject({ revision: 1, savedAt: "2025-01-02T00:00:00.000Z" });
    const source = await readFile(join(directory, "default.json"), "utf8");
    expect(source.endsWith("\n")).toBe(true);
    expect(JSON.parse(source)).toEqual(written);
  });

  it("rejects a stale revision without changing disk", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory });
    await repository.initialize();
    await repository.save(0, makeSnapshot());

    await expect(repository.save(0, makeSnapshot())).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await repository.load()).save.revision).toBe(1);
  });

  it("serializes concurrent writes so only one expected revision wins", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory });
    await repository.initialize();

    const results = await Promise.allSettled([
      repository.save(0, makeSnapshot()),
      repository.save(0, { ...makeSnapshot(), settings: { ...makeSnapshot().settings, masterVolume: 0.2 } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await repository.load()).save.revision).toBe(1);
  });

  for (const stage of ["afterTempOpen", "afterPartialWrite", "afterFlush", "beforeRename"] as const) {
    it(`keeps the original readable after a ${stage} failure`, async () => {
      const directory = await temporaryDirectory();
      const initial = new SaveRepository({ directory });
      await initial.initialize();
      await initial.save(0, makeSnapshot());

      const failing = new SaveRepository({
        directory,
        writer: { faultInjector: (current: AtomicWriteStage) => {
          if (current === stage) throw new Error(`injected ${stage}`);
        } },
      });
      await failing.initialize();
      const changed = makeSnapshot();
      changed.settings.masterVolume = 0.1;
      await expect(failing.save(1, changed)).rejects.toThrow(`injected ${stage}`);

      const verifier = new SaveRepository({ directory });
      await verifier.initialize();
      expect((await verifier.load()).save).toMatchObject({ revision: 1, settings: { masterVolume: 0.8 } });
      expect((await readdir(directory)).some((name) => name.startsWith("default.json.tmp-"))).toBe(false);
    });
  }

  it("cleans stale temporary files on startup", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "default.json.tmp-99-stale"), "partial");
    await writeFile(join(directory, "unrelated.tmp"), "keep");
    const repository = new SaveRepository({ directory });
    await repository.initialize();
    expect(await readdir(directory)).toEqual(["unrelated.tmp"]);
  });

  it("starts fresh when the main save is malformed and replaces it on the next PUT", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "default.json"), "not json");
    const repository = new SaveRepository({ directory });
    await repository.initialize();

    const loaded = await repository.load();
    expect(loaded.firstRun).toBe(true);
    expect(loaded.save.revision).toBe(0);
    // No recovery copies: the malformed file is simply replaced.
    await expect(repository.save(0, makeSnapshot())).resolves.toMatchObject({ revision: 1 });
    expect((await repository.load()).firstRun).toBe(false);
    expect((await readdir(directory)).some((name) => name.includes("corrupt"))).toBe(false);
  });
});

describe("save validation", () => {
  it("rejects unsupported save schema versions", () => {
    const raw = { ...makeSnapshot(), schemaVersion: 1 };
    expect(() => parseSaveSnapshot(raw)).toThrow();
  });

  it("enforces the card memory invariants of the single-card model", () => {
    const snapshot = makeSnapshotWithWord();
    snapshot.levels["hsk-1"]!.words["word-1"]!.card.state = "review";
    expect(() => parseSaveSnapshot(snapshot)).toThrow(/last review/); // review card without lastReview
  });

  it("enforces learn session invariants", () => {
    const snapshot = makeSnapshotWithSession("hsk-1", ["word-1"]);
    expect(() => parseSaveSnapshot(snapshot)).not.toThrow();

    const unknownMember = makeSnapshotWithSession("hsk-1", ["word-1"]);
    unknownMember.learnSessions["hsk-1"]!.wordIds = ["word-1", "ghost"];
    expect(() => parseSaveSnapshot(unknownMember)).toThrow(/member word/);

    const wrongFingerprint = makeSnapshotWithSession("hsk-1", ["word-1"]);
    wrongFingerprint.learnSessions["hsk-1"]!.deckFingerprint = "other";
    expect(() => parseSaveSnapshot(wrongFingerprint)).toThrow(/deck fingerprint/);
  });

  it("validates learn session entries even when their grade has no level record", () => {
    const orphaned = makeSnapshotWithSession("hsk-1", ["word-1"]);
    delete orphaned.levels["hsk-1"];
    // Structurally sound without a level: dedupe and completion rules hold.
    expect(() => parseSaveSnapshot(orphaned)).not.toThrow();

    orphaned.learnSessions["hsk-1"]!.wordIds = ["word-1", "word-1"];
    expect(() => parseSaveSnapshot(orphaned)).toThrow(/duplicate word IDs/);

    const ghostCompletion = makeSnapshotWithSession("hsk-1", ["word-1"]);
    delete ghostCompletion.levels["hsk-1"];
    ghostCompletion.learnSessions["hsk-1"]!.completedWordIds = ["ghost"];
    expect(() => parseSaveSnapshot(ghostCompletion)).toThrow(/completed word must be a session member/);
  });

  it("enforces introducedAtOrdinal against the save's spawn ordinal and cursor coherence", () => {
    const future = makeSnapshotWithWord();
    future.levels["hsk-1"]!.words["word-1"]!.introducedAtOrdinal = 5; // spawnOrdinal is 0
    expect(() => parseSaveSnapshot(future)).toThrow(/introducedAtOrdinal/);

    const futureOrphan = makeSnapshotWithWord();
    futureOrphan.levels["hsk-1"]!.orphanedProgress = {
      gone: { ...makeWordProgress(5), card: makeAcquiredReviewCard() },
    };
    expect(() => parseSaveSnapshot(futureOrphan)).toThrow(/introducedAtOrdinal/);

    // Without a catalog the cursor must at least cover every introduced word.
    const cursorBehind = makeSnapshotWithWord();
    cursorBehind.levels["hsk-1"]!.curriculumCursor = 0; // word-1 IS introduced (ordinal 0)
    expect(() => parseSaveSnapshot(cursorBehind)).toThrow(/cannot be smaller than the introduced word count/);

    // With a catalog the cursor must EQUAL the introduced count exactly.
    const catalog: DeckCatalog = new Map([
      ["hsk-1", { fingerprint: "fixture-fingerprint", wordIds: new Set(["word-1"]) }],
    ]);
    const coherent = makeSnapshotWithWord();
    expect(() => parseSaveSnapshot(coherent, catalog)).not.toThrow(); // cursor 1 === 1 introduced
    const incoherent = makeSnapshotWithWord();
    incoherent.levels["hsk-1"]!.words["word-1"]!.introducedAtOrdinal = null;
    expect(() => parseSaveSnapshot(incoherent, catalog)).toThrow(/must equal the introduced word count/);
  });

  it("accepts a coherent active relearn session and enforces its invariants", () => {
    const snapshot = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    expect(() => parseSaveSnapshot(snapshot)).not.toThrow();

    // Two members from different grades with independent fresh cards.
    const crossGrade = makeSnapshotWithRelearn(["hsk-1:word-1", "hsk-2:other"]);
    crossGrade.levels["hsk-2"] = {
      ...crossGrade.levels["hsk-1"]!,
      deckId: "hsk-2",
    };
    crossGrade.levels["hsk-2"]!.words = {
      other: { ...crossGrade.levels["hsk-1"]!.words["word-1"]! },
    };
    crossGrade.acquiredWords = ["hsk-2:other", "hsk-1:word-1"];
    expect(() => parseSaveSnapshot(crossGrade)).not.toThrow();

    const duplicateKeys = makeSnapshotWithRelearn(["hsk-1:word-1", "hsk-1:word-1"]);
    expect(() => parseSaveSnapshot(duplicateKeys)).toThrow(/duplicate/);

    const missingCard = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    delete missingCard.relearnSession!.cards["hsk-1:word-1"];
    expect(() => parseSaveSnapshot(missingCard)).toThrow(/missing its independent card/);

    const orphanCard = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    orphanCard.relearnSession!.cards["hsk-1:ghost"] = {
      card: orphanCard.relearnSession!.cards["hsk-1:word-1"]!.card,
      reviews: 0,
    };
    expect(() => parseSaveSnapshot(orphanCard)).toThrow(/no session member/);

    const notAcquired = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    notAcquired.acquiredWords = [];
    expect(() => parseSaveSnapshot(notAcquired)).toThrow(/acquired word/);

    // A member whose independent card is ALREADY review must have been
    // removed at rating time — persisting one is a runtime leak.
    const finishedMember = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    finishedMember.relearnSession!.cards["hsk-1:word-1"] = {
      card: { ...finishedMember.relearnSession!.cards["hsk-1:word-1"]!.card, state: "review", reps: 2, stability: 3, difficulty: 5, lastReview: "2024-12-29T00:00:00.000Z" },
      reviews: 1,
    };
    expect(() => parseSaveSnapshot(finishedMember)).toThrow(/must have been removed/);

    // …while learning/relearning independent cards are legal mid-session.
    const midSession = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    midSession.relearnSession!.cards["hsk-1:word-1"] = {
      card: { ...midSession.relearnSession!.cards["hsk-1:word-1"]!.card, state: "learning", reps: 1, stability: 3, difficulty: 5, lastReview: "2024-12-29T00:00:00.000Z" },
      reviews: 1,
    };
    expect(() => parseSaveSnapshot(midSession)).not.toThrow();

    const badFormat = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    badFormat.relearnSession!.wordKeys = ["noseparator"];
    badFormat.relearnSession!.cards = {};
    expect(() => parseSaveSnapshot(badFormat)).toThrow(/<deckId>:<wordId>/);

    // Independent cards follow the same memory-shape rules but are never
    // compared against the member's main Learn card.
    const ratedIndependently = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    ratedIndependently.relearnSession!.cards["hsk-1:word-1"] = {
      card: {
        state: "learning", due: "2025-01-01T10:00:00.000Z", stability: 0.5, difficulty: 6,
        elapsedDays: 0, scheduledDays: 0.01, learningSteps: 1, reps: 1, lapses: 0,
        lastReview: "2025-01-01T00:00:00.000Z",
      },
      reviews: 1,
    };
    expect(() => parseSaveSnapshot(ratedIndependently)).not.toThrow();

    const ratedWithoutCounter = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    ratedWithoutCounter.relearnSession!.cards["hsk-1:word-1"]!.card = {
      ...ratedWithoutCounter.relearnSession!.cards["hsk-1:word-1"]!.card,
      state: "learning", reps: 1, lastReview: "2025-01-01T00:00:00.000Z",
    };
    expect(() => parseSaveSnapshot(ratedWithoutCounter)).toThrow(/at least one rating/);

    const newCardWithReviews = makeSnapshotWithRelearn(["hsk-1:word-1"]);
    newCardWithReviews.relearnSession!.cards["hsk-1:word-1"]!.reviews = 2;
    expect(() => parseSaveSnapshot(newCardWithReviews)).toThrow(/cannot have reviews/);
  });

  it("enforces acquired_words coherence", () => {
    const snapshot = makeSnapshotWithWord("word-1");
    snapshot.levels["hsk-1"]!.words["word-1"]!.card = {
      state: "review", due: "2025-01-01T00:00:00.000Z", stability: 3, difficulty: 5,
      elapsedDays: 0, scheduledDays: 3, learningSteps: 0, reps: 2, lapses: 0,
      lastReview: "2024-12-29T00:00:00.000Z",
    };
    snapshot.levels["hsk-1"]!.words["word-1"]!.learnReviews = 1;
    snapshot.acquiredWords = ["hsk-1:word-1"];
    expect(() => parseSaveSnapshot(snapshot)).not.toThrow();

    const duplicate = makeSnapshotWithWord("word-1");
    duplicate.acquiredWords = ["hsk-1:word-1", "hsk-1:word-1"];
    expect(() => parseSaveSnapshot(duplicate)).toThrow(/duplicate/);

    const badKey = makeSnapshot();
    badKey.acquiredWords = ["not-a-key"];
    expect(() => parseSaveSnapshot(badKey)).toThrow(/deckId/);

    const unearned = makeSnapshotWithWord("word-1"); // card is still new
    unearned.acquiredWords = ["hsk-1:word-1"];
    expect(() => parseSaveSnapshot(unearned)).toThrow(/review or relearning/);
  });

  it("starts fresh on an old schema instead of migrating it", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory, now: clock("2025-06-01T00:00:00.000Z") });
    await repository.initialize();
    await writeFile(join(directory, "default.json"), JSON.stringify({
      schemaVersion: 3, profileId: "default", revision: 4, savedAt: "2025-05-01T00:00:00.000Z",
      settings: { spawnIntervalMs: 5000, enemySpeedMultiplier: 0.9, levelSize: 20, masterVolume: 0.8, reducedMotion: false },
      spawnOrdinal: 2,
      schedulerRng: [1, 2, 3, 4],
      levels: {},
      lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
    }));
    const loaded = await repository.load();
    expect(loaded.firstRun).toBe(true);
    expect(loaded.save.revision).toBe(0);
    // Old data is neither migrated nor preserved in copy files.
    expect(await readdir(directory)).toEqual(["default.json"]);
  });

  it("rejects scheduler states that domain constructors cannot use", () => {
    const zeroRng = makeSnapshot();
    zeroRng.schedulerRng = [0, 0, 0, 0];
    expect(() => parseSaveSnapshot(zeroRng)).toThrow(/must not be all zero/);

    const invalidCard = makeSnapshotWithWord();
    invalidCard.levels["hsk-1"]!.words["word-1"]!.card = {
      ...invalidCard.levels["hsk-1"]!.words["word-1"]!.card,
      state: "review",
      reps: 3,
      stability: 3,
      difficulty: 0,
      lastReview: "2024-12-29T00:00:00.000Z",
    };
    expect(() => parseSaveSnapshot(invalidCard)).toThrow(/difficulty of at least 1/);

    const reversedDates = makeSnapshotWithWord();
    reversedDates.levels["hsk-1"]!.words["word-1"]!.card = {
      ...reversedDates.levels["hsk-1"]!.words["word-1"]!.card,
      state: "review",
      reps: 3,
      stability: 3,
      difficulty: 5,
      due: "2025-01-01T00:00:00.000Z",
      lastReview: "2099-01-01T00:00:00.000Z",
    };
    expect(() => parseSaveSnapshot(reversedDates)).toThrow(/must not precede/);
  });

  it("rejects unknown current word IDs when a generated manifest is available", () => {
    const catalog: DeckCatalog = new Map([
      ["hsk-1", { fingerprint: "fixture-fingerprint", wordIds: new Set(["known"]) }],
    ]);
    expect(() => parseSaveSnapshot(makeSnapshotWithWord("unknown"), catalog)).toThrow(/not present/);
    expect(() => parseSaveSnapshot(makeSnapshotWithWord("known"), catalog)).not.toThrow();
  });

  it("loads an old deck fingerprint for reconciliation", async () => {
    const directory = await temporaryDirectory();
    const oldSnapshot = makeSnapshotWithWord("removed-word");
    const persisted = {
      ...oldSnapshot,
      revision: 3,
      savedAt: "2025-01-01T00:00:00.000Z",
    };
    await writeFile(join(directory, "default.json"), JSON.stringify(persisted));
    const catalog: DeckCatalog = new Map([
      ["hsk-1", { fingerprint: "new-fingerprint", wordIds: new Set(["new-word"]) }],
    ]);
    const repository = new SaveRepository({ directory, catalog });
    await repository.initialize();

    expect((await repository.load()).save.levels["hsk-1"]?.words).toHaveProperty("removed-word");
    await expect(repository.save(3, oldSnapshot)).rejects.toThrow(/not present/);
  });

  it("rejects unknown keys instead of silently stripping them", () => {
    expect(() => parseSaveSnapshot({ ...makeSnapshot(), surprise: true })).toThrow();
  });
});
