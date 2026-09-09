import { describe, expect, it } from "vitest";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { createBattleDeck } from "../../src/client/data/battleDeck";
import type { SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { VocabRow } from "../../src/shared/battle";
import { applyMasteryOutcome, battlePools, selectBattleSpawn } from "../../src/domain/battle";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { applyLearnRating, createLearnSession, nextLearnCardId } from "../../src/domain/learn";
import { reviewWordKey } from "../../src/domain/review";
import { generateChoices } from "../../src/domain/session/choices";
import { randomStateFromSeed, Xoshiro128StarStar } from "../../src/domain/random";

const NOW = new Date("2026-01-01T00:00:00Z");
/** The approved tuning, inlined as a fixture (runtime tuning lives only in
 * config/battle.yaml served by the server). */
const CONFIG = {
  learningSlots: 5,
  boundaries: { lowMax: 50, developingMax: 99 },
  masteryDelta: 10,
  curve: { midpoint: 5, shape: 1.3 },
  asymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 },
};

function baseSave(deckOfSave: LearningDeck): SaveFile {
  return {
    schemaVersion: 5, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("runtime"),
    levels: { [deckOfSave.id]: createLevelProgress(deckOfSave) },
    acquiredWords: [],
    learnSessions: {},
    relearnSession: null,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
}

/** Pure mirror of the approved server outcome contract, driving the client
 * pipeline end to end: mastery delta with clamp, time_mastered set once at
 * 100 and never cleared, and the ordered learning-slot refill (append the
 * next unseen curriculum entry whenever fewer than `learningSlots` low rows
 * remain). Curriculum ids arrive as the deck's flattened word order. */
function simulateServerOutcome(
  vocab: readonly VocabRow[],
  curriculumIds: readonly string[],
  cardId: string,
  cleanCorrect: boolean,
): { vocab: VocabRow[]; row: VocabRow; addedRows: VocabRow[] } {
  const rows = vocab.map((row) => ({ ...row }));
  const target = rows.find((row) => row.cardId === cardId)!;
  target.mastery = applyMasteryOutcome(target.mastery, cleanCorrect, CONFIG);
  if (target.mastery === 100 && target.timeMastered === null) {
    target.timeMastered = NOW.toISOString();
  }

  const addedRows: VocabRow[] = [];
  const lowCount = () => rows.filter((row) => row.mastery <= CONFIG.boundaries.lowMax).length;
  const nextId = () => Math.max(0, ...rows.map((row) => row.id)) + 1;
  while (lowCount() < CONFIG.learningSlots) {
    const id = nextId();
    const unseen = curriculumIds.find((candidate) => !rows.some((row) => row.cardId === candidate));
    if (unseen === undefined) break;
    const added: VocabRow = { id, cardId: unseen, mastery: 0, timeAdded: NOW.toISOString(), timeMastered: null };
    rows.push(added);
    addedRows.push(added);
  }
  return { vocab: rows.sort((left, right) => left.id - right.id), row: target, addedRows };
}

describe("playable runtime slice", () => {
  it("creates a Learn session, serves its first card, and records one durable rating", () => {
    const deckOfSave = createDemoDeck("hsk-1");
    const save = baseSave(deckOfSave);
    const created = createLearnSession(deckOfSave, save.levels["hsk-1"]!, NOW, { newCardLimit: DEFAULT_SETTINGS.levelSize, spawnOrdinal: save.spawnOrdinal });
    expect(created.session.wordIds.length).toBeGreaterThan(0);
    expect(created.session.wordIds.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.levelSize);

    const next = nextLearnCardId(created.session, created.level, NOW);
    expect(next.status).toBe("card");
    if (next.status !== "card") return;
    const word = deckOfSave.words.find((item) => item.id === next.wordId)!;
    expect(generateChoices(deckOfSave, word, "enemy-1")).toHaveLength(8);

    const applied = applyLearnRating(
      { ...save, levels: { ...save.levels, "hsk-1": created.level }, learnSessions: { ...save.learnSessions, "hsk-1": created.session } },
      "hsk-1", word.id, "good", NOW,
    );
    const updated = applied.save.levels["hsk-1"]!.words[word.id]!;
    expect(updated.card.reps).toBe(1);
    expect(updated.card.state).toBe("learning");
    expect(updated.learnReviews).toBe(1);
    expect(applied.save.learnSessions["hsk-1"]).not.toBeNull(); // learning card stays in its session
    expect(applied.save.acquiredWords).toEqual([]); // not acquired yet

    // A save/load cycle preserves the active session exactly.
    const restored = JSON.parse(JSON.stringify(applied.save)) as SaveFile;
    expect(restored.learnSessions["hsk-1"]!.wordIds).toEqual(applied.save.learnSessions["hsk-1"]!.wordIds);
    expect(nextLearnCardId(restored.learnSessions["hsk-1"]!, restored.levels["hsk-1"]!, new Date(NOW.getTime() + 60_000)))
      .toEqual(nextLearnCardId(applied.save.learnSessions["hsk-1"]!, applied.save.levels["hsk-1"]!, new Date(NOW.getTime() + 60_000)));
  });

  it("acquires a word exactly once when its card graduates from an Easy first rating", () => {
    const deckOfSave = createDemoDeck("hsk-1");
    const save = baseSave(deckOfSave);
    const created = createLearnSession(deckOfSave, save.levels["hsk-1"]!, NOW, { newCardLimit: 5, spawnOrdinal: 0 });
    const saveWithSession: SaveFile = {
      ...save, levels: { ...save.levels, "hsk-1": created.level }, learnSessions: { ...save.learnSessions, "hsk-1": created.session },
    };
    const wordId = created.session.wordIds[0]!;
    const applied = applyLearnRating(saveWithSession, "hsk-1", wordId, "easy", NOW);
    expect(applied.wordCompleted).toBe(true);
    expect(applied.newlyAcquired).toBe(true);
    expect(applied.save.acquiredWords).toEqual([reviewWordKey("hsk-1", wordId)]);
  });

  it("runs the battle pipeline: seed → live selection → outcomes → ordered refill", () => {
    const deckOfSave = createDemoDeck("hsk-1");
    const curriculumIds = deckOfSave.curriculum.lessons.flatMap((lesson) => lesson.wordIds);

    // 1. First launch: the server seeds curriculum positions 1..5 at mastery 0.
    let vocab: VocabRow[] = curriculumIds.slice(0, 5).map((cardId, index) => ({
      id: index + 1, cardId, mastery: 0, timeAdded: NOW.toISOString(), timeMastered: null,
    }));
    const battleDeck = createBattleDeck(new Map([["hsk-1", deckOfSave as never]]));

    // 2. Live selection from a fresh save: n = 0, so every spawn is a low
    //    seed; the merged corpus deck resolves every vocab card id.
    const rng = new Xoshiro128StarStar(randomStateFromSeed("battle-runtime"));
    const pools = battlePools(vocab, CONFIG);
    expect(pools.low.map((row) => row.cardId)).toEqual(curriculumIds.slice(0, 5));
    for (let draw = 0; draw < 50; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, new Set());
      expect(selection!.category).toBe("low");
      expect(curriculumIds.slice(0, 5)).toContain(selection!.row.cardId);
      expect(battleDeck.deck.words.some((word) => word.id === selection!.row.cardId)).toBe(true);
    }

    // Deterministic under the injected seed: the same state replays the
    // same stream.
    const stateSnapshot = rng.state();
    const first = Array.from({ length: 20 }, () => selectBattleSpawn(vocab, CONFIG, rng, new Set())!.row.cardId);
    const replay = new Xoshiro128StarStar(stateSnapshot);
    const second = Array.from({ length: 20 }, () => selectBattleSpawn(vocab, CONFIG, replay, new Set())!.row.cardId);
    expect(first).toEqual(second);

    // 3. Exclusions: while all five seeds are active nothing may spawn; four
    //    active leaves exactly the idle one.
    const allActive = new Set(vocab.map((row) => row.cardId));
    expect(selectBattleSpawn(vocab, CONFIG, rng, allActive)).toBeNull();
    const fourActive = new Set(vocab.slice(0, 4).map((row) => row.cardId));
    expect(selectBattleSpawn(vocab, CONFIG, rng, fourActive)!.row.cardId).toBe(vocab[4]!.cardId);

    // 4. Ten clean corrects graduate the first seed; each graduation beyond
    //    the low boundary refills the slot with the NEXT unseen curriculum
    //    entry in strict order (positions 6, 7, ...).
    const seedCard = vocab[0]!.cardId;
    for (let step = 0; step < 10; step += 1) {
      const result = simulateServerOutcome(vocab, curriculumIds, seedCard, true);
      vocab = result.vocab;
      // The client's optimistic mirror always agrees with the server row.
      expect(result.row.mastery).toBe(applyMasteryOutcome(step * 10, true, CONFIG));
    }
    expect(vocab.find((row) => row.cardId === seedCard)!.mastery).toBe(100);
    expect(vocab.find((row) => row.cardId === seedCard)!.timeMastered).toBe(NOW.toISOString());
    // One refill: the graduated seed left four low rows, so position 6 joined.
    expect(vocab.map((row) => row.cardId)).toEqual([seedCard, ...curriculumIds.slice(1, 6)]);
    expect(vocab.filter((row) => row.mastery <= CONFIG.boundaries.lowMax)).toHaveLength(5);

    // 5. With one mature row the weights shift: draws now include the
    //    developing category (~10% mature at n = 1), never a benched row.
    const idleSeeds = vocab.filter((row) => row.mastery === 0).map((row) => row.cardId);
    const matureCard = seedCard;
    let matureDraws = 0;
    const drawCounts = new Map<string, number>();
    for (let draw = 0; draw < 4000; draw += 1) {
      const selection = selectBattleSpawn(vocab, CONFIG, rng, new Set())!;
      drawCounts.set(selection.row.cardId, (drawCounts.get(selection.row.cardId) ?? 0) + 1);
      if (selection.row.cardId === matureCard) matureDraws += 1;
    }
    expect(matureDraws / 4000).toBeGreaterThan(0.06);
    expect(matureDraws / 4000).toBeLessThan(0.14);
    for (const cardId of drawCounts.keys()) {
      expect([...idleSeeds, matureCard]).toContain(cardId);
    }

    // 6. Misses decrement mastery and clamp at zero; time_mastered survives
    //    a later miss (never cleared).
    for (let step = 0; step < 12; step += 1) {
      vocab = simulateServerOutcome(vocab, curriculumIds, matureCard, false).vocab;
    }
    const demoted = vocab.find((row) => row.cardId === matureCard)!;
    expect(demoted.mastery).toBe(0);
    expect(demoted.timeMastered).toBe(NOW.toISOString());
    // Demoted back into the low category, it competes by id order again.
    expect(battlePools(vocab, CONFIG).low.map((row) => row.cardId)).toContain(matureCard);
  });
});
