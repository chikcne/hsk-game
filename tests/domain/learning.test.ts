import { describe, expect, it } from "vitest";
import type { WordProgress } from "../../src/shared/schemas";
import {
  countGraduated, createLevelProgress, curriculumLessonNumber, curriculumOrder,
  reconcileLevelProgress, validateLevelInvariants, assertLevelInvariants,
  type LearningDeck,
} from "../../src/domain/learning";
import { createCardMemory, isCardAcquired } from "../../src/domain/memory";
import { createLearnSession } from "../../src/domain/learn";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function deck(count = 200, fingerprint = "fingerprint-a", prefix = "word"): LearningDeck {
  return { id: "hsk-1", fingerprint, words: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(3, "0")}` })) };
}
function freshLevel(sourceDeck = deck()): ReturnType<typeof createLevelProgress> {
  return createLevelProgress(sourceDeck, { curriculumSeed: "curriculum" });
}
function updateWord(level: ReturnType<typeof createLevelProgress>, id: string, patch: Partial<WordProgress>) {
  const progress = level.words[id]; if (!progress) throw new Error(`missing ${id}`);
  return { ...level, words: { ...level.words, [id]: { ...progress, ...patch } } };
}
function graduate(level: ReturnType<typeof createLevelProgress>, id: string, dueMs = NOW + 86_400_000) {
  const progress = level.words[id]!;
  return updateWord(level, id, {
    card: { ...progress.card, state: "review", reps: 2, stability: 3, difficulty: 5, lastReview: new Date(NOW).toISOString(), due: new Date(dueMs).toISOString() },
  });
}

describe("curriculum order and level creation", () => {
  it("starts a grade fully unintroduced with a stable deterministic order", () => {
    const source = deck(600);
    const level = freshLevel(source);
    expect(level.curriculumCursor).toBe(0);
    expect(Object.values(level.words).every((word) => word.introducedAtOrdinal === null)).toBe(true);
    expect(Object.values(level.words).every((word) => word.card.reps === 0)).toBe(true);
    expect(curriculumLessonNumber(level, 20)).toBe(1);

    const order = curriculumOrder(source, "curriculum");
    expect(new Set(order).size).toBe(600);
    expect(order).toEqual(curriculumOrder(source, "curriculum"));
    expect(order).not.toEqual(source.words.map((word) => word.id)); // actually shuffled
    expect(curriculumOrder(source, "other-seed")).not.toEqual(order);
  });

  it("introduces words only through Learn sessions and advances the cursor", () => {
    const source = deck(40);
    const level = freshLevel(source);
    const { level: afterSession } = createLearnSession(source, level, new Date(NOW), { newCardLimit: 20, spawnOrdinal: 5 });
    const introduced = Object.values(afterSession.words).filter((word) => word.introducedAtOrdinal !== null);
    expect(introduced).toHaveLength(20);
    expect(afterSession.curriculumCursor).toBe(20);
    expect(introduced.every((word) => word.introducedAtOrdinal === 5)).toBe(true);
  });
});

describe("graduation counting", () => {
  it("counts only cards in the acquired states", () => {
    const source = deck(20);
    let level = freshLevel(source);
    expect(countGraduated(level)).toBe(0);
    const first = curriculumOrder(source, "curriculum")[0]!;
    level = graduate(level, first);
    expect(countGraduated(level)).toBe(1);
    expect(isCardAcquired(level.words[first]!.card)).toBe(true);

    // A lapse pulls the word back out of the acquired count.
    level = updateWord(level, first, {
      card: { ...level.words[first]!.card, state: "relearning", stability: 0.5, lapses: 1, due: new Date(NOW).toISOString() },
    });
    expect(countGraduated(level)).toBe(0);
    expect(isCardAcquired(level.words[first]!.card)).toBe(true); // still acquired history-wise
  });
});

describe("reconciliation and invariants", () => {
  it("retains IDs and memory, adds new words, and orphans removals", () => {
    const oldDeck = deck(30, "old", "stable");
    let level = freshLevel(oldDeck);
    const first = curriculumOrder(oldDeck, "curriculum")[0]!;
    const { level: introduced } = createLearnSession(oldDeck, level, new Date(NOW), { newCardLimit: 5, spawnOrdinal: 0 });
    level = updateWord(introduced, first, { learnReviews: 3, lastSeenAt: new Date(NOW).toISOString() });
    const newDeck: LearningDeck = { id: "hsk-1", fingerprint: "new", words: [...oldDeck.words.slice(1), { id: "added" }] };
    const result = reconcileLevelProgress(level, newDeck, 7);
    expect(result.report).toEqual({ retained: 29, added: 1, removed: 1 });
    expect(result.level.words.added).toBeDefined();
    // Deck-update additions are UNINTRODUCED: the next Learn sessions
    // introduce them through the normal levelSize gate instead of dumping
    // the whole diff into one session.
    expect(result.level.words.added?.introducedAtOrdinal).toBeNull();
    expect(result.level.words.added?.card.state).toBe("new");
    // The updated word rides along with its memory; the deck-ordered first
    // word is the removal that becomes an orphan.
    expect(result.level.words[first]!.learnReviews).toBe(3);
    expect(result.level.orphanedProgress["stable-000"]).toBeDefined();
    expect(result.level.deckFingerprint).toBe("new");
    expect(validateLevelInvariants(result.level, newDeck, 7)).toEqual([]);
  });

  it("diagnoses malformed progress", () => {
    const source = deck(30);
    const valid = freshLevel(source);
    assertLevelInvariants(valid, source, 0);
    const id = source.words[0]!.id;
    const malformed = updateWord(valid, id, { learnReviews: -1 });
    const errors = validateLevelInvariants(malformed, source, 0);
    expect(errors.some((error) => error.includes("learnReviews"))).toBe(true);
    expect(() => assertLevelInvariants(malformed, source, 0)).toThrow(/Invalid level progress/);

    const futureIntro = updateWord(valid, id, { introducedAtOrdinal: 5 });
    expect(validateLevelInvariants(futureIntro, source, 4).some((error) => error.includes("future"))).toBe(true);
  });

  it("rejects a level whose word set no longer matches the deck", () => {
    const source = deck(5);
    const level = freshLevel(source);
    const shrunk: LearningDeck = { id: "hsk-1", fingerprint: "fingerprint-a", words: source.words.slice(1) };
    const errors = validateLevelInvariants(level, shrunk, 0);
    expect(errors.some((error) => error.includes("unknown current word ID"))).toBe(true);
  });

  it("creates fresh cards for new progress records", () => {
    const memory = createCardMemory();
    expect(memory.state).toBe("new");
    expect(memory.reps).toBe(0);
    expect(Date.parse(memory.due)).toBeLessThanOrEqual(0); // due immediately
  });
});
