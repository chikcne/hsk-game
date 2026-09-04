import { describe, expect, it } from "vitest";
import type { SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { applyLearnRating, createLearnSession, nextLearnCardId } from "../../src/domain/learn";
import { reviewWordKey } from "../../src/domain/review";
import { Xoshiro128StarStar, randomStateFromSeed } from "../../src/domain/random";

/**
 * Workload simulation (learn-mode slice): drives the real Learn session
 * engine + FSRS memory over simulated weeks with a synthetic player whose
 * rating quality follows a seeded RNG. Asserts structural health properties
 * rather than exact intervals:
 *
 * - sessions stay finite (every session terminates; learn-ahead cannot loop);
 * - the due backlog never explodes;
 * - memory strengthens over time (cards are acquired into acquired_words);
 * - acquisition happens exactly once per word and preserves order semantics;
 * - a reviewed card never silently regresses to unseen/new state.
 */

const DAY_MS = 86_400_000;
const DECK_SIZE = 60;
const NEW_PER_SESSION = 20;
const SIMULATED_DAYS = 90;

function makeDeck(count = DECK_SIZE): LearningDeck {
  return { id: "hsk-1", fingerprint: "sim", words: Array.from({ length: count }, (_, index) => ({ id: `w${String(index).padStart(3, "0")}` })) };
}

function freshSave(deckOfSave: LearningDeck): SaveFile {
  return {
    schemaVersion: 4, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS, levelSize: NEW_PER_SESSION },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("workload"),
    levels: { "hsk-1": createLevelProgress(deckOfSave, { curriculumSeed: "sim-seed" }) },
    acquiredWords: [],
    learnSessions: {},
    relearnSession: null,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
}

describe("multi-week Learn Mode workload simulation", () => {
  it("acquires a synthetic cohort without unbounded sessions or stuck cards", () => {
    const deckOfSave = makeDeck();
    let save = freshSave(deckOfSave);
    const rng = new Xoshiro128StarStar([42, 7, 1970, 20260101]);

    let maxBacklog = 0;
    let maxSessionRatings = 0;
    let sessions = 0;
    const firstAcquiredDay = new Map<string, number>();
    const acquisitionOrder: string[] = [];

    for (let day = 0; day < SIMULATED_DAYS; day += 1) {
      const dayStart = Date.parse("2026-01-01T00:00:00Z") + day * DAY_MS;

      // A session starts only when something is learnable (mirrors App gating).
      let created;
      try {
        created = createLearnSession(deckOfSave, save.levels["hsk-1"]!, new Date(dayStart), { newCardLimit: NEW_PER_SESSION, spawnOrdinal: save.spawnOrdinal });
      } catch {
        created = null; // all caught up today
      }
      if (created) {
        sessions += 1;
        save = {
          ...save,
          levels: { ...save.levels, "hsk-1": created.level },
          learnSessions: { ...save.learnSessions, "hsk-1": created.session },
        };
        let ratings = 0;
        while (ratings < 500) {
          const session = save.learnSessions["hsk-1"] ?? null;
          if (!session) break;
          const next = nextLearnCardId(session, save.levels["hsk-1"]!, new Date(dayStart + ratings * 60_000));
          if (next.status !== "card") break;
          const roll = rng.nextUnit();
          const rating = roll < 0.12 ? "again" : roll < 0.3 ? "hard" : roll < 0.9 ? "good" : "easy";
          const applied = applyLearnRating(save, "hsk-1", next.wordId, rating, new Date(dayStart + ratings * 60_000));
          save = applied.save;
          if (applied.newlyAcquired) {
            const key = reviewWordKey("hsk-1", next.wordId);
            expect(save.acquiredWords[0]).toBe(key); // newest acquisition is at the front
            expect(save.acquiredWords.includes(key)).toBe(true);
            firstAcquiredDay.set(next.wordId, day);
            acquisitionOrder.push(key);
          }
          ratings += 1;
        }
        expect(ratings).toBeLessThan(500); // every session terminates
        maxSessionRatings = Math.max(maxSessionRatings, ratings);
      }

      // Due backlog for tomorrow: introduced cards due by tomorrow.
      let backlog = 0;
      for (const progress of Object.values(save.levels["hsk-1"]!.words)) {
        if (progress.introducedAtOrdinal === null) continue;
        if (Date.parse(progress.card.due) <= dayStart + DAY_MS) backlog += 1;
      }
      maxBacklog = Math.max(maxBacklog, backlog);
    }

    const words = Object.values(save.levels["hsk-1"]!.words);
    const acquiredCount = save.acquiredWords.length;

    // Health properties.
    expect(sessions).toBeGreaterThan(5); // the engine ran real sessions
    expect(acquiredCount).toBeGreaterThan(DECK_SIZE * 0.5); // most cards acquire within ~3 months
    expect(acquiredCount).toBe(save.acquiredWords.filter((key, index) => save.acquiredWords.indexOf(key) === index).length); // no duplicates
    expect(acquisitionOrder.length).toBe(acquiredCount); // acquisition was observed exactly once per word
    expect(maxBacklog).toBeLessThanOrEqual(DECK_SIZE); // backlog bounded by deck size
    expect(maxSessionRatings).toBeLessThan(500); // sessions end well before the safety net
    for (const word of words) {
      // A reviewed card never regresses to an unseen/new state.
      if (word.card.reps > 0) expect(word.card.state).not.toBe("new");
    }
    // Every word eventually enters the curriculum (sessions capped at 20 new).
    expect(Object.values(save.levels["hsk-1"]!.words).filter((word) => word.introducedAtOrdinal !== null)).toHaveLength(DECK_SIZE);
    expect(save.levels["hsk-1"]!.curriculumCursor).toBe(DECK_SIZE);
    expect(firstAcquiredDay.size).toBe(acquiredCount);
  });
});
