import { describe, expect, it } from "vitest";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { createReviewDeck } from "../../src/client/data/reviewDeck";
import type { SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS, REVIEW_REPAIR_DELAY_SPAWNS } from "../../src/shared/constants";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { applyLearnRating, createLearnSession, nextLearnCardId } from "../../src/domain/learn";
import { applyRelearnRating, createRelearnSession, nextRelearnKey } from "../../src/domain/relearn";
import {
  applyReviewOutcome, buildReviewPlanFromSnapshot, createReviewSession as createSpawnSession,
  decideReviewSpawn, reserveReviewSpawn, reviewWordKey,
} from "../../src/domain/review";
import { generateChoices } from "../../src/domain/session/choices";
import { randomStateFromSeed } from "../../src/domain/random";

const NOW = new Date("2026-01-01T00:00:00Z");

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

  it("runs the acquired_words review pipeline: plan → battle reducer → relearn → move-to-front", () => {
    const deckOfSave = createDemoDeck("hsk-1");
    let save = baseSave(deckOfSave);

    // 1. Learn and acquire the 20-word minimum (Easy ratings graduate immediately).
    const created = createLearnSession(deckOfSave, save.levels["hsk-1"]!, NOW, { newCardLimit: 20, spawnOrdinal: 0 });
    save = { ...save, levels: { ...save.levels, "hsk-1": created.level }, learnSessions: { ...save.learnSessions, "hsk-1": created.session } };
    let ordinal = save.spawnOrdinal;
    for (const wordId of created.session.wordIds) {
      save = applyLearnRating(save, "hsk-1", wordId, "easy", NOW).save;
      ordinal += 1;
    }
    expect(save.acquiredWords).toHaveLength(20);
    expect(save.learnSessions["hsk-1"]).toBeNull();

    // 2. The review deck presents exactly the acquired log — regardless of
    //    any later main-card state change.
    const merged = createReviewDeck(new Map([["hsk-1", deckOfSave as never]]), save.acquiredWords);
    expect(merged.deck.words.map((word) => word.id)).toEqual(save.acquiredWords);

    // 3. At the minimum pool size, the base plan scales to 20/100 of the
    // configured target and consumes the RNG. Four words are New (twice
    // guaranteed); the other 16 are Recent (once guaranteed + filler).
    const before = save.schedulerRng;
    const plan = buildReviewPlanFromSnapshot(save.acquiredWords, save.settings.reviewSessionLength, { spawnOrdinal: ordinal, schedulerRng: save.schedulerRng });
    expect(plan.spawns).toHaveLength(DEFAULT_SETTINGS.reviewSessionLength * 20 / 100);
    expect(plan.snapshot.schedulerRng).not.toEqual(before);
    for (let rank = 0; rank < save.acquiredWords.length; rank += 1) {
      const minimumOccurrences = rank < 4 ? 2 : 1;
      expect(plan.spawns.filter((spawn) => spawn === save.acquiredWords[rank]).length).toBeGreaterThanOrEqual(minimumOccurrences);
    }
    expect(new Set(plan.spawns)).toEqual(new Set(save.acquiredWords));

    // 4. Battle reducer: clean encounters throughout, then miss the FINAL
    //    base spawn so the forced endgame retry must fire (an earlier miss
    //    would typically be cleared by the word's own later base
    //    occurrences, which is equally valid per the spec).
    let battle = createSpawnSession(plan.spawns);
    let resolved = 0;
    const active = new Set<string>();
    let missedKey: string | null = null;
    while (true) {
      const decision = decideReviewSpawn(battle, active);
      if (decision.kind === "complete") break;
      if (decision.kind !== "spawn") throw new Error("unexpected wait");
      battle = reserveReviewSpawn(battle, decision);
      resolved += 1;
      const miss = resolved === plan.spawns.length; // miss exactly the last base spawn
      if (miss) missedKey = decision.wordKey;
      battle = applyReviewOutcome(battle, decision.wordKey, !miss).session;
    }
    expect(missedKey).toBe(plan.spawns[plan.spawns.length - 1]);
    expect(battle.cursor).toBe(plan.spawns.length);
    expect(battle.obligations.size).toBe(0);
    // Exactly one additive retry beyond the slider target: the forced repair.
    expect(battle.repairsServed).toBe(1);
    expect(resolved).toBe(plan.spawns.length + 1);
    expect(REVIEW_REPAIR_DELAY_SPAWNS).toBe(10);

    // 5. Relearn the missed word: independent card, then move-to-front.
    save = { ...save, spawnOrdinal: plan.snapshot.spawnOrdinal, schedulerRng: plan.snapshot.schedulerRng };
    save = { ...save, relearnSession: createRelearnSession([missedKey!], NOW) };
    const next = nextRelearnKey(save.relearnSession!, NOW);
    expect(next.status).toBe("card");
    const applied = applyRelearnRating(save, missedKey!, "easy", NOW);
    save = applied.save;
    expect(applied.keyFinished).toBe(true);
    expect(applied.sessionCompleted).toBe(true);
    expect(save.relearnSession).toBeNull();
    expect(save.acquiredWords[0]).toBe(missedKey); // moved to newest/front
    expect(save.acquiredWords.filter((key) => key === missedKey)).toHaveLength(1); // exactly once
    // The main Learn card never changed during review/relearn: it still has
    // only the one original Learn rating.
    const missedId = missedKey!.slice("hsk-1:".length);
    expect(save.levels["hsk-1"]!.words[missedId]!.card.reps).toBe(1);
  });
});
