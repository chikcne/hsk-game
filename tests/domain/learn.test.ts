import { describe, expect, it } from "vitest";
import type { ComponentMemory, SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { createCardMemory, isCardDue, reviewCardMemory } from "../../src/domain/memory";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { randomStateFromSeed } from "../../src/domain/random";
import { reviewWordKey } from "../../src/domain/review";
import {
  applyLearnRating, acquireWordKey, createLearnSession, formatLearnInterval, nextLearnCardId,
  nextLearnDueAtMs, prepareLearnLaunch, previewLearnCard, remainingLearnWordIds,
} from "../../src/domain/learn";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const NOW_DATE = new Date(NOW);
const LATER = new Date(NOW + 60_000);

function deck(count = 40, fingerprint = "fp-a", prefix = "w"): LearningDeck {
  return { id: "hsk-1", fingerprint, words: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(2, "0")}` })) };
}

function baseSave(deckOfSave: LearningDeck, seed = "curriculum"): SaveFile {
  return {
    schemaVersion: 4, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("learn"),
    levels: { [deckOfSave.id]: createLevelProgress(deckOfSave, { curriculumSeed: seed }) },
    acquiredWords: [],
    learnSessions: {},
    relearnSession: null,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
}

/** Introduces exactly one session of new words so tests can manipulate due
 * cards afterwards. */
function startSession(save: SaveFile, deckOfSave: LearningDeck, now = NOW_DATE, newCardLimit = 5) {
  const created = createLearnSession(deckOfSave, save.levels[deckOfSave.id]!, now, { newCardLimit, spawnOrdinal: save.spawnOrdinal });
  return { ...save, levels: { ...save.levels, [deckOfSave.id]: created.level }, learnSessions: { ...save.learnSessions, [deckOfSave.id]: created.session } };
}

function patchCard(save: SaveFile, wordId: string, card: Partial<ComponentMemory>, deckId: "hsk-1" = "hsk-1"): SaveFile {
  const level = save.levels[deckId]!;
  return { ...save, levels: { ...save.levels, [deckId]: { ...level, words: { ...level.words, [wordId]: { ...level.words[wordId]!, card: { ...level.words[wordId]!.card, ...card } } } } } };
}

const reviewCard = (dueMs: number): ComponentMemory => ({
  state: "review", reps: 3, stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 3, learningSteps: 0, lapses: 0,
  lastReview: new Date(NOW - 86_400_000).toISOString(), due: new Date(dueMs).toISOString(),
});

describe("learn session creation", () => {
  it("collects every due introduced word plus up to the new-card cap, due words first", () => {
    const source = deck(30);
    let save = baseSave(source);
    // Simulate a prior session that introduced 3 words, since graduated.
    const first = createLearnSession(source, save.levels["hsk-1"]!, NOW_DATE, { newCardLimit: 3, spawnOrdinal: 0 });
    save = { ...save, levels: { ...save.levels, "hsk-1": first.level }, learnSessions: { ...save.learnSessions, "hsk-1": null } };

    const level = save.levels["hsk-1"]!;
    const introduced = Object.entries(level.words).filter(([, word]) => word.introducedAtOrdinal !== null).map(([id]) => id);
    expect(introduced).toHaveLength(3);
    const [dueGraduate, future1, future2] = introduced;
    save = patchCard(save, dueGraduate!, reviewCard(NOW - 1000));
    save = patchCard(save, future1!, reviewCard(NOW + 7 * 86_400_000));
    save = patchCard(save, future2!, reviewCard(NOW + 9 * 86_400_000));

    const { level: nextLevel, session } = createLearnSession(source, save.levels["hsk-1"]!, NOW_DATE, { newCardLimit: 5, spawnOrdinal: 1 });

    // Exactly the due graduate (not the future ones) plus 5 fresh words.
    expect(session.wordIds).toContain(dueGraduate);
    expect(session.wordIds).not.toContain(future1);
    expect(session.wordIds).not.toContain(future2);
    expect(session.wordIds).toHaveLength(6);
    expect(session.wordIds[0]).toBe(dueGraduate); // due words first
    const newMembers = session.wordIds.slice(1);
    for (const id of newMembers) {
      expect(nextLevel.words[id]!.introducedAtOrdinal).toBe(1);
      expect(nextLevel.words[id]!.card.reps).toBe(0);
    }
    expect(nextLevel.curriculumCursor).toBe(8);
    expect(session.deckId).toBe("hsk-1");
    expect(session.deckFingerprint).toBe("fp-a");
    expect(session.startedAt).toBe(NOW_DATE.toISOString());
    const firstCard = nextLearnCardId(session, nextLevel, NOW_DATE);
    expect(firstCard.status).toBe("card");
    if (firstCard.status === "card") expect(session.currentWordId).toBe(firstCard.wordId);
  });

  it("throws when nothing is due and no new words remain, and reports the next due time", () => {
    const source = deck(4);
    let save = baseSave(source);
    const level = save.levels["hsk-1"]!;
    const words: typeof level.words = {};
    for (const [id, word] of Object.entries(level.words)) {
      words[id] = { ...word, introducedAtOrdinal: 0, card: reviewCard(NOW + 10 * 86_400_000) };
    }
    save = { ...save, levels: { ...save.levels, "hsk-1": { ...level, words } } };
    expect(() => createLearnSession(source, save.levels["hsk-1"]!, NOW_DATE, { newCardLimit: 5, spawnOrdinal: 0 })).toThrow(RangeError);
    expect(nextLearnDueAtMs(save.levels["hsk-1"]!, NOW_DATE)).toBe(NOW + 10 * 86_400_000);
  });

  it("caps new words at the remaining curriculum when the deck runs out", () => {
    const source = deck(4);
    const save = baseSave(source);
    const { session } = createLearnSession(source, save.levels["hsk-1"]!, NOW_DATE, { newCardLimit: 20, spawnOrdinal: 0 });
    expect(session.wordIds).toHaveLength(4);
  });
});

describe("explicit ratings, previews, and single-card memory", () => {
  it("applies the four self-ratings to the one card and bumps the rating counter", () => {
    const source = deck(10);
    const save = startSession(baseSave(source), source);
    const wordId = save.learnSessions["hsk-1"]!.wordIds[0]!;
    const before = save.levels["hsk-1"]!.words[wordId]!;

    const again = applyLearnRating(save, "hsk-1", wordId, "again", NOW_DATE);
    const againWord = again.save.levels["hsk-1"]!.words[wordId]!;
    expect(againWord.card.state).toBe("learning");
    expect(againWord.card.due).toBe(new Date(NOW + 60_000).toISOString()); // ~1m learning step
    expect(againWord.learnReviews).toBe(before.learnReviews + 1);
    expect(againWord.lastSeenAt).toBe(NOW_DATE.toISOString());

    const easy = applyLearnRating(save, "hsk-1", wordId, "easy", NOW_DATE);
    const easyWord = easy.save.levels["hsk-1"]!.words[wordId]!;
    expect(easyWord.card.state).toBe("review");
    expect(easyWord.card.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(easy.newlyAcquired).toBe(true);

    const hard = applyLearnRating(save, "hsk-1", wordId, "hard", NOW_DATE);
    expect(hard.save.levels["hsk-1"]!.words[wordId]!.card.state).toBe("learning");
    const good = applyLearnRating(save, "hsk-1", wordId, "good", NOW_DATE);
    expect(good.save.levels["hsk-1"]!.words[wordId]!.card.state).toBe("learning");

    // The original save is never mutated.
    expect(save.levels["hsk-1"]!.words[wordId]!.card.reps).toBe(0);
  });

  it("previews each rating's next card state without mutating the current one", () => {
    const card = createCardMemory();
    const again = previewLearnCard(card, "again", NOW_DATE);
    const easy = previewLearnCard(card, "easy", NOW_DATE);
    expect(again.state).toBe("learning");
    expect(again.due).toBe(new Date(NOW + 60_000).toISOString());
    expect(easy.state).toBe("review");
    expect(card.reps).toBe(0); // untouched
    expect(again).toEqual(reviewCardMemory(card, "again", NOW_DATE));
  });

  it("formats interval previews in minutes, hours, and days", () => {
    expect(formatLearnInterval(0)).toBe("NOW");
    expect(formatLearnInterval(60_000)).toBe("1m");
    expect(formatLearnInterval(9.5 * 60_000)).toBe("10m");
    expect(formatLearnInterval(6 * 3_600_000)).toBe("6.0h");
    expect(formatLearnInterval(8 * 86_400_000)).toBe("8.0d");
    expect(formatLearnInterval(45 * 86_400_000)).toBe("45d");
  });
});

describe("learn-ahead ordering", () => {
  function sessionOf(save: SaveFile) {
    return save.learnSessions["hsk-1"]!;
  }
  /** Patches every member card so only the test's dues decide ordering. */
  function withDues(save: SaveFile, duesMs: Record<string, number>): SaveFile {
    for (const [id, dueMs] of Object.entries(duesMs)) {
      save = patchCard(save, id, { state: "learning", reps: 1, due: new Date(dueMs).toISOString(), lastReview: new Date(NOW).toISOString() });
    }
    return save;
  }

  it("serves the earliest due remaining card, ties by stable ID", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const members = sessionOf(save).wordIds;
    const [first, second, third] = members;
    const rest = members.slice(3);
    const dues: Record<string, number> = { [first!]: NOW + 600_000, [second!]: NOW + 60_000, [third!]: NOW + 3_600_000 };
    for (const [index, id] of rest.entries()) dues[id] = NOW + (10 + index) * 60_000;
    save = withDues(save, dues);
    expect(nextLearnCardId(sessionOf(save), save.levels["hsk-1"]!, NOW_DATE)).toEqual({ status: "card", wordId: second, dueNow: false }); // earliest, still future

    // Identical dues break on stable word ID.
    for (const id of [first, second, third]) save = patchCard(save, id!, { due: new Date(NOW + 60_000).toISOString() });
    const tieWinner = [first, second, third].sort()[0]!;
    expect(nextLearnCardId(sessionOf(save), save.levels["hsk-1"]!, NOW_DATE)).toEqual({ status: "card", wordId: tieWinner, dueNow: false });
  });

  it("uses Anki-style learn-ahead: the earliest future card is served rather than waiting", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const members = sessionOf(save).wordIds;
    const dues: Record<string, number> = {};
    for (const [index, id] of members.entries()) dues[id] = NOW + (5 + index * 10) * 60_000;
    save = withDues(save, dues);
    const expected = members.slice().sort((left, right) => dues[left]! - dues[right]!)[0]!;
    expect(nextLearnCardId(sessionOf(save), save.levels["hsk-1"]!, NOW_DATE)).toEqual({ status: "card", wordId: expected, dueNow: false });
  });

  it("drops completed members immediately: a review-state card is no longer served", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const wordId = sessionOf(save).wordIds[0]!;
    save = applyLearnRating(save, "hsk-1", wordId, "easy", NOW_DATE).save;
    expect(remainingLearnWordIds(sessionOf(save), save.levels["hsk-1"]!)).not.toContain(wordId);
    const next = nextLearnCardId(sessionOf(save), save.levels["hsk-1"]!, NOW_DATE);
    expect(next.status).toBe("card");
    if (next.status === "card") expect(next.wordId).not.toBe(wordId);
  });
});

describe("resume exactness", () => {
  it("persists and advances the exact displayed word pointer with each rating", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const displayed = save.learnSessions["hsk-1"]!.currentWordId!;

    const applied = applyLearnRating(save, "hsk-1", displayed, "easy", NOW_DATE);
    const nextSession = applied.save.learnSessions["hsk-1"]!;
    expect(nextSession.currentWordId).not.toBe(displayed);
    expect(nextSession.wordIds).toContain(nextSession.currentWordId);
    expect(nextSession.completedWordIds).not.toContain(nextSession.currentWordId);

    const restored = JSON.parse(JSON.stringify(applied.save)) as SaveFile;
    expect(restored.learnSessions["hsk-1"]!.currentWordId).toBe(nextSession.currentWordId);
  });

  it("preserves a persisted displayed word instead of recalculating it on launch", () => {
    const source = deck(10);
    const save = startSession(baseSave(source), source);
    const session = save.learnSessions["hsk-1"]!;
    const persisted = session.wordIds.find((id) => id !== session.currentWordId)!;
    const withPointer: SaveFile = {
      ...save,
      learnSessions: { ...save.learnSessions, "hsk-1": { ...session, currentWordId: persisted } },
    };

    const launch = prepareLearnLaunch(withPointer, source, LATER, { levelSize: 5, newLevelSeed: "unused" });
    expect(launch.session.currentWordId).toBe(persisted);
    expect(launch.changed).toBe(false);
  });


  it("reloads the same session, membership, and next card from a persisted save", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const [a, b] = save.learnSessions["hsk-1"]!.wordIds;
    save = applyLearnRating(save, "hsk-1", a!, "good", NOW_DATE).save;
    save = applyLearnRating(save, "hsk-1", b!, "again", NOW_DATE).save;

    const restored = JSON.parse(JSON.stringify(save)) as SaveFile;
    const at = new Date(NOW + 120_000);
    const live = nextLearnCardId(save.learnSessions["hsk-1"]!, save.levels["hsk-1"]!, at);
    const resumed = nextLearnCardId(restored.learnSessions["hsk-1"]!, restored.levels["hsk-1"]!, at);
    expect(resumed).toEqual(live);
    expect(live.status).toBe("card");
    expect(resumed.status).toBe("card");
    expect(restored.learnSessions["hsk-1"]!.wordIds).toEqual(save.learnSessions["hsk-1"]!.wordIds);
    expect(restored.levels["hsk-1"]!.words[a!]!.card).toEqual(save.levels["hsk-1"]!.words[a!]!.card);

    // Continuing the restored save produces the identical third rating result.
    const liveId = live.status === "card" ? live.wordId : "";
    const resumedId = resumed.status === "card" ? resumed.wordId : "";
    expect(applyLearnRating(restored, "hsk-1", resumedId, "good", at).save).toEqual(applyLearnRating(save, "hsk-1", liveId, "good", at).save);
  });
});

describe("acquisition transition, order, and dedupe", () => {
  it("enters the word once, at the front, when its card first reaches review", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const [a, b] = save.learnSessions["hsk-1"]!.wordIds;
    save = applyLearnRating(save, "hsk-1", a!, "easy", NOW_DATE).save;
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", a!)]);

    save = applyLearnRating(save, "hsk-1", b!, "good", NOW_DATE).save; // learning, not acquired
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", a!)]);
    save = applyLearnRating(save, "hsk-1", b!, "good", LATER).save;   // graduates now
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", b!), reviewWordKey("hsk-1", a!)]); // newest first

    // Later ordinary ratings never reorder or duplicate.
    save = applyLearnRating(save, "hsk-1", a!, "good", LATER).save;
    save = applyLearnRating(save, "hsk-1", b!, "easy", LATER).save;
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", b!), reviewWordKey("hsk-1", a!)]);
  });

  it("keeps a lapsed acquired word in the table while it repairs through relearning", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source);
    const a = save.learnSessions["hsk-1"]!.wordIds[0]!;
    save = applyLearnRating(save, "hsk-1", a!, "easy", NOW_DATE).save; // -> review, acquired
    save = applyLearnRating(save, "hsk-1", a!, "again", NOW_DATE).save; // review -> relearning
    expect(save.levels["hsk-1"]!.words[a!]!.card.state).toBe("relearning");
    expect(save.levels["hsk-1"]!.words[a!]!.card.lapses).toBe(1);
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", a!)]); // never removed
    save = applyLearnRating(save, "hsk-1", a!, "good", LATER).save;  // back to review
    expect(save.acquiredWords).toEqual([reviewWordKey("hsk-1", a!)]); // no duplicate
  });

  it("dedupes at the table level", () => {
    expect(acquireWordKey(["hsk-1:a", "hsk-1:b"], "hsk-1:a")).toEqual({ next: ["hsk-1:a", "hsk-1:b"], added: false });
    expect(acquireWordKey(["hsk-1:b"], "hsk-1:a")).toEqual({ next: ["hsk-1:a", "hsk-1:b"], added: true });
  });
});

describe("session completion", () => {
  it("clears the active session only after every member reaches review", () => {
    const source = deck(10);
    let save = startSession(baseSave(source), source, NOW_DATE, 3);
    const members = save.learnSessions["hsk-1"]!.wordIds;
    expect(members).toHaveLength(3);

    save = applyLearnRating(save, "hsk-1", members[0]!, "easy", NOW_DATE).save;
    expect(save.learnSessions["hsk-1"]).not.toBeNull();
    save = applyLearnRating(save, "hsk-1", members[1]!, "good", NOW_DATE).save; // learning: stays
    expect(save.learnSessions["hsk-1"]).not.toBeNull();
    save = applyLearnRating(save, "hsk-1", members[1]!, "good", LATER).save;    // graduates
    save = applyLearnRating(save, "hsk-1", members[2]!, "easy", NOW_DATE).save;
    expect(save.learnSessions["hsk-1"]).toBeNull(); // cleared: nothing left to resume
  });

  it("keeps a session alive for an Again on a due review card until it repairs", () => {
    const source = deck(10);
    let save = baseSave(source);
    const level = save.levels["hsk-1"]!;
    // All words introduced, review-state, and due: they all enter the session.
    const words: typeof level.words = {};
    for (const [id, word] of Object.entries(level.words)) {
      words[id] = { ...word, introducedAtOrdinal: 0, card: reviewCard(NOW - 1000) };
    }
    save = { ...save, levels: { ...save.levels, "hsk-1": { ...level, words } } };
    save = startSession(save, source);
    const members = save.learnSessions["hsk-1"]!.wordIds;
    expect(members).toHaveLength(10);

    // The first served card (all dues tied; stable ID wins) lapses.
    const firstPick = nextLearnCardId(save.learnSessions["hsk-1"]!, save.levels["hsk-1"]!, NOW_DATE);
    expect(firstPick.status).toBe("card");
    const victim = firstPick.status === "card" ? firstPick.wordId : "";
    save = applyLearnRating(save, "hsk-1", victim, "again", NOW_DATE).save;
    expect(save.levels["hsk-1"]!.words[victim]!.card.state).toBe("relearning");
    expect(save.learnSessions["hsk-1"]).not.toBeNull();

    // Pass everything else; the lapsed repair is only served once it is the
    // last remaining member — via learn-ahead, since its due is ~10m ahead.
    let running = save;
    let guard = 0;
    while (guard < 30) {
      const step = nextLearnCardId(running.learnSessions["hsk-1"]!, running.levels["hsk-1"]!, NOW_DATE);
      if (step.status !== "card") break;
      if (step.wordId === victim) {
        expect(step.dueNow).toBe(false); // learn-ahead: nothing else remains
        break;
      }
      running = applyLearnRating(running, "hsk-1", step.wordId, "easy", NOW_DATE).save;
      guard += 1;
    }
    expect(guard).toBe(9); // every healthy member needed exactly one pass
    const finished = applyLearnRating(running, "hsk-1", victim, "good", LATER).save;
    expect(finished.levels["hsk-1"]!.words[victim]!.card.state).toBe("review");
    expect(finished.learnSessions["hsk-1"]).toBeNull();
  });

  it("exposes card due-ness through the shared memory helper", () => {
    const card = createCardMemory();
    expect(card.state).toBe("new");
    expect(isCardDue(card, new Date(0))).toBe(true);
  });
});

describe("launch planning (prepareLearnLaunch)", () => {
  it("persists the created session's level so the SECOND batch introduces different words", () => {
    const source = deck(12);
    const save = baseSave(source);

    // First launch: creates a session AND its level record together.
    const first = prepareLearnLaunch(save, source, NOW_DATE, { levelSize: 5, newLevelSeed: "seed" });
    expect(first.changed).toBe(true);
    let running: SaveFile = {
      ...save,
      levels: first.levels,
      learnSessions: { ...save.learnSessions, "hsk-1": first.session },
    };
    const firstBatch = first.session.wordIds;
    expect(firstBatch).toHaveLength(5);
    const firstLevel = running.levels["hsk-1"]!;
    expect(firstLevel.curriculumCursor).toBe(5);
    for (const id of firstBatch) expect(firstLevel.words[id]!.introducedAtOrdinal).not.toBeNull();

    // Complete the whole first batch.
    for (const id of firstBatch) {
      running = applyLearnRating(running, "hsk-1", id, "easy", NOW_DATE).save;
    }
    expect(running.learnSessions["hsk-1"]).toBeNull();

    // Second launch: the persisted cursor/introductions force NEW words.
    const second = prepareLearnLaunch(running, source, LATER, { levelSize: 5, newLevelSeed: "seed" });
    const secondBatch = second.session.wordIds;
    expect(secondBatch).toHaveLength(5);
    for (const id of firstBatch) expect(secondBatch).not.toContain(id);
    expect(second.levels["hsk-1"]!.curriculumCursor).toBe(10);
  });

  it("resumes an existing session without rewriting the level (changed only via session identity)", () => {
    const source = deck(8);
    const save = startSession(baseSave(source), source);
    const launch = prepareLearnLaunch(save, source, NOW_DATE, { levelSize: 5, newLevelSeed: "seed" });
    expect(launch.session).toBe(save.learnSessions["hsk-1"]);
    expect(launch.levels).toBe(save.levels);
    expect(launch.changed).toBe(false);
  });

  it("invalidates a stale session when the deck fingerprint changed, in the same plan", () => {
    const source = deck(8);
    const save = startSession(baseSave(source), source);
    const updated: LearningDeck = { id: "hsk-1", fingerprint: "fp-b", words: [...source.words, ...Array.from({ length: 8 }, (_, index) => ({ id: `added-${index}` }))] };
    const launch = prepareLearnLaunch(save, updated, NOW_DATE, { levelSize: 3, newLevelSeed: "seed" });
    expect(launch.session).not.toBeNull();
    expect(launch.session.deckFingerprint).toBe("fp-b");
    expect(launch.levels["hsk-1"]!.deckFingerprint).toBe("fp-b");
    expect(launch.changed).toBe(true);
    // Reconciled additions are unintroduced, so the levelSize cap holds:
    // at most `levelSize` of the 8 added words join this first session.
    const addedMembers = launch.session.wordIds.filter((id) => id.startsWith("added-"));
    expect(addedMembers.length).toBe(3);
    // Cursor = 5 prior introductions + the 3 this session just introduced.
    expect(launch.levels["hsk-1"]!.curriculumCursor).toBe(8);
  });

  it("throws the caught-up RangeError only after earlier launches were persisted correctly", () => {
    const source = deck(5);
    const save = baseSave(source);
    const first = prepareLearnLaunch(save, source, NOW_DATE, { levelSize: 5, newLevelSeed: "seed" });
    let running: SaveFile = { ...save, levels: first.levels, learnSessions: { ...save.learnSessions, "hsk-1": first.session } };
    for (const id of first.session.wordIds) running = applyLearnRating(running, "hsk-1", id, "easy", NOW_DATE).save;
    expect(() => prepareLearnLaunch(running, source, NOW_DATE, { levelSize: 5, newLevelSeed: "seed" })).toThrow(RangeError);
  });
});

describe("grade completion milestone (firstCompletedAt)", () => {
  it("is stamped exactly once when every grade word is in review, and lapses preserve it", () => {
    const source = deck(3);
    let save = startSession(baseSave(source), source, NOW_DATE, 3);
    const members = save.learnSessions["hsk-1"]!.wordIds;

    save = applyLearnRating(save, "hsk-1", members[0]!, "easy", NOW_DATE).save;
    expect(save.levels["hsk-1"]!.firstCompletedAt).toBeNull(); // one word still new
    save = applyLearnRating(save, "hsk-1", members[1]!, "easy", NOW_DATE).save;
    expect(save.levels["hsk-1"]!.firstCompletedAt).toBeNull();
    const completingAt = new Date(NOW + 1000);
    save = applyLearnRating(save, "hsk-1", members[2]!, "easy", completingAt).save;
    expect(save.levels["hsk-1"]!.firstCompletedAt).toBe(completingAt.toISOString());

    // A later lapse (Again) leaves the stamp untouched…
    const lapseAt = new Date(NOW + 2000);
    save = applyLearnRating(save, "hsk-1", members[0]!, "again", lapseAt).save;
    expect(save.levels["hsk-1"]!.words[members[0]!]!.card.state).toBe("relearning");
    expect(save.levels["hsk-1"]!.firstCompletedAt).toBe(completingAt.toISOString());

    // …and repairing back to review does not restamp it either.
    const repairedAt = new Date(NOW + 3000);
    save = applyLearnRating(save, "hsk-1", members[0]!, "good", repairedAt).save;
    expect(save.levels["hsk-1"]!.words[members[0]!]!.card.state).toBe("review");
    expect(save.levels["hsk-1"]!.firstCompletedAt).toBe(completingAt.toISOString());
  });
});
