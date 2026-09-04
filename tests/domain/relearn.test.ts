import { describe, expect, it } from "vitest";
import type { SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { randomStateFromSeed } from "../../src/domain/random";
import { reviewWordKey } from "../../src/domain/review";
import { applyRelearnRating, createRelearnSession, nextRelearnKey } from "../../src/domain/relearn";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const NOW_DATE = new Date(NOW);
const LATER = new Date(NOW + 60_000);

function deck(count = 10): LearningDeck {
  return { id: "hsk-1", fingerprint: "fp-a", words: Array.from({ length: count }, (_, index) => ({ id: `w-${index}` })) };
}

/** A save with the grade fully acquired (all cards review-state) plus the
 * given keys selected into THE active relearn session. */
function baseSave(keys: string[], cardsDueMs: Record<string, number> = {}): SaveFile {
  const deckOfSave = deck();
  const level = createLevelProgress(deckOfSave, { curriculumSeed: "seed" });
  const words = { ...level.words };
  for (let index = 0; index < deckOfSave.words.length; index += 1) {
    const id = deckOfSave.words[index]!.id;
    words[id] = {
      ...words[id]!,
      introducedAtOrdinal: 0,
      learnReviews: 3,
      card: {
        state: "review", reps: 3, lapses: 0, stability: 4, difficulty: 5,
        elapsedDays: 1, scheduledDays: 3, learningSteps: 0,
        due: new Date(NOW + 86_400_000).toISOString(),
        lastReview: new Date(NOW - 86_400_000).toISOString(),
      },
    };
  }
  const session = createRelearnSession(keys, NOW_DATE);
  for (const [key, dueMs] of Object.entries(cardsDueMs)) {
    const state = session.cards[key];
    if (!state) continue;
    state.card = {
      ...state.card,
      state: "learning", reps: 1, lastReview: new Date(NOW).toISOString(),
      due: new Date(dueMs).toISOString(),
    };
    state.reviews = 1;
  }
  return {
    schemaVersion: 4, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("relearn"),
    levels: { "hsk-1": { ...level, words } },
    acquiredWords: keys.length > 0 ? keys : [reviewWordKey("hsk-1", "w-0")],
    learnSessions: {},
    relearnSession: session,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
}

describe("relearn session creation", () => {
  it("stores fresh independent cards and counters inside the session", () => {
    const session = createRelearnSession(["hsk-1:a", "hsk-2:b"], NOW_DATE);
    expect(session.startedAt).toBe(NOW_DATE.toISOString());
    expect(session.wordKeys).toEqual(["hsk-1:a", "hsk-2:b"]);
    for (const key of session.wordKeys) {
      expect(session.cards[key]!.card.state).toBe("new");
      expect(session.cards[key]!.card.reps).toBe(0);
      expect(session.cards[key]!.card.lastReview).toBeNull();
      expect(session.cards[key]!.reviews).toBe(0);
    }
  });

  it("rejects empty or duplicated selections", () => {
    expect(() => createRelearnSession([], NOW_DATE)).toThrow(RangeError);
    expect(() => createRelearnSession(["hsk-1:a", "hsk-1:a"], NOW_DATE)).toThrow(RangeError);
  });
});

describe("independent ratings never touch the main Learn cards", () => {
  it("advances only the session card; save.levels is byte-identical", () => {
    const key = "hsk-1:w-0";
    const save = baseSave([key]);
    const before = JSON.stringify(save.levels);
    const applied = applyRelearnRating(save, key, "good", NOW_DATE);
    expect(applied.save.relearnSession!.cards[key]!.card.state).toBe("learning");
    expect(applied.save.relearnSession!.cards[key]!.card.due).toBe(new Date(NOW + 600_000).toISOString());
    expect(applied.save.relearnSession!.cards[key]!.reviews).toBe(1);
    expect(JSON.stringify(applied.save.levels)).toBe(before); // main cards untouched
    expect(applied.keyFinished).toBe(false);
    expect(applied.sessionCompleted).toBe(false);
    expect(applied.reacquired).toBe(false);
    expect(save.relearnSession!.cards[key]!.card.reps).toBe(0); // input untouched
  });

  it("serves the earliest due member with learn-ahead, ties by selection order", () => {
    const a = "hsk-1:w-0";
    const b = "hsk-1:w-1";
    const c = "hsk-1:w-2";
    const save = baseSave([a, b, c], { [a]: NOW + 600_000, [b]: NOW - 60_000, [c]: NOW + 600_000 });
    const next = nextRelearnKey(save.relearnSession!, NOW_DATE);
    expect(next).toEqual({ status: "card", wordKey: b, dueNow: true });

    // All-future cards: the earliest is still served (learn-ahead).
    const future = baseSave([a, b, c], { [a]: NOW + 600_000, [b]: NOW + 300_000, [c]: NOW + 900_000 });
    expect(nextRelearnKey(future.relearnSession!, NOW_DATE)).toEqual({ status: "card", wordKey: b, dueNow: false });
  });

  it("reports complete only when no members remain", () => {
    const save = baseSave(["hsk-1:w-0"]);
    const empty = { ...save.relearnSession!, wordKeys: [], cards: {} };
    expect(nextRelearnKey(empty, NOW_DATE)).toEqual({ status: "complete" });
  });
});

describe("completion, move-to-front, and session clearing", () => {
  it("finishes a word when its independent card reaches review: key removed and prepended", () => {
    const a = "hsk-1:w-0";
    const b = "hsk-1:w-1";
    let save = baseSave([a, b]);
    save = { ...save, acquiredWords: [b, a] }; // b is currently newest

    const applied = applyRelearnRating(save, a, "easy", NOW_DATE); // new -> review
    expect(applied.keyFinished).toBe(true);
    expect(applied.reacquired).toBe(true);
    expect(applied.save.acquiredWords).toEqual([a, b]); // a moved to front
    expect(applied.save.relearnSession!.wordKeys).toEqual([b]);
    expect(applied.save.relearnSession!.cards[a]).toBeUndefined(); // card removed with the member
    expect(applied.sessionCompleted).toBe(false);
  });

  it("keeps a learning member in the session until a later passing rating", () => {
    const key = "hsk-1:w-0";
    let save = baseSave([key]);
    save = applyRelearnRating(save, key, "good", NOW_DATE).save; // new -> learning (~10m)
    expect(save.relearnSession).not.toBeNull();
    expect(save.acquiredWords).toEqual([key]); // unchanged position for now
    const finished = applyRelearnRating(save, key, "good", LATER); // learning -> review
    expect(finished.keyFinished).toBe(true);
    expect(finished.sessionCompleted).toBe(true);
    expect(finished.save.relearnSession).toBeNull(); // last member done: session cleared
    expect(finished.save.acquiredWords).toEqual([key]); // still exactly once
  });

  it("requeues nothing: a second rating for a finished key is rejected", () => {
    const key = "hsk-1:w-0";
    let save = baseSave([key]);
    save = applyRelearnRating(save, key, "easy", NOW_DATE).save;
    expect(save.relearnSession).toBeNull();
    // The session cleared, so any further rating has nothing to apply to.
    expect(() => applyRelearnRating(save, key, "good", NOW_DATE)).toThrow(/No active relearn session/);
  });

  it("multi-word sessions complete only after every independent card reaches review", () => {
    const a = "hsk-1:w-0";
    const b = "hsk-1:w-1";
    let save = baseSave([a, b]);
    save = applyRelearnRating(save, a, "easy", NOW_DATE).save; // a finished
    expect(save.relearnSession).not.toBeNull();
    save = applyRelearnRating(save, b, "again", NOW_DATE).save; // b -> learning
    expect(save.relearnSession).not.toBeNull();
    save = applyRelearnRating(save, b, "easy", LATER).save; // b -> review via learning? no: new->learning on again... 
    // (b was new; again made it learning; easy from learning graduates)
    expect(save.relearnSession).toBeNull();
    expect(save.acquiredWords[0]).toBe(b); // b newest
    expect(save.acquiredWords[1]).toBe(a);
  });

  it("requires an active session and membership", () => {
    const save = baseSave(["hsk-1:w-0"]);
    expect(() => applyRelearnRating({ ...save, relearnSession: null }, "hsk-1:w-0", "good", NOW_DATE)).toThrow(/No active/);
    expect(() => applyRelearnRating(save, "hsk-1:w-9", "good", NOW_DATE)).toThrow(/not a member/);
  });
});

describe("exact resume", () => {
  it("reloads the same session, membership, and next card from a persisted save", () => {
    const a = "hsk-1:w-0";
    const b = "hsk-1:w-1";
    let save = baseSave([a, b]);
    save = applyRelearnRating(save, a, "good", NOW_DATE).save;
    save = applyRelearnRating(save, b, "again", NOW_DATE).save;

    const restored = JSON.parse(JSON.stringify(save)) as SaveFile;
    const at = new Date(NOW + 120_000);
    expect(nextRelearnKey(restored.relearnSession!, at)).toEqual(nextRelearnKey(save.relearnSession!, at));
    expect(restored.relearnSession!.wordKeys).toEqual(save.relearnSession!.wordKeys);
    expect(restored.relearnSession!.cards).toEqual(save.relearnSession!.cards);

    // Continuing the restored save produces the identical next application.
    const liveNext = nextRelearnKey(save.relearnSession!, at);
    if (liveNext.status !== "card") throw new Error("expected a card");
    expect(applyRelearnRating(restored, liveNext.wordKey, "good", at).save)
      .toEqual(applyRelearnRating(save, liveNext.wordKey, "good", at).save);
  });
});
