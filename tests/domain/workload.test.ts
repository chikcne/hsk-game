import { describe, expect, it } from "vitest";
import type { LevelsMap, SchedulerSnapshot } from "../../src/domain/learning";
import {
  advanceOrdinal, applyOutcomeToLevels, countGraduated, createLevelProgress,
  spawnNextWord, type LearningDeck,
} from "../../src/domain/learning";
import { Xoshiro128StarStar } from "../../src/domain/random";
import { componentRetrievability } from "../../src/domain/memory";

/**
 * Workload simulation (priority-plan item 6, first slice): drives the real
 * scheduler + FSRS memory over simulated weeks with a synthetic player whose
 * recall probability equals the current retrievability of each component.
 * Asserts structural health properties rather than exact intervals:
 *
 * - sessions stay finite (no infinite queues, no filler grading);
 * - the due backlog never explodes;
 * - memory strengthens over time (stability grows, cards graduate);
 * - a lapse never silently resets a card to "new".
 */

const DAY_MS = 86_400_000;
const DECK_SIZE = 60;
const LEVEL_SIZE = 20;
const SIMULATED_DAYS = 90;

function makeDeck(count = DECK_SIZE): LearningDeck {
  return { id: "hsk-1", fingerprint: "sim", words: Array.from({ length: count }, (_, index) => ({ id: `w${String(index).padStart(3, "0")}` })) };
}

function pinyinLengthOf(wordId: string): number {
  return 5; // uniform synthetic answer length
}

describe("multi-week workload simulation", () => {
  it("graduates a synthetic cohort without unbounded backlogs or stuck cards", () => {
    const deck = makeDeck();
    let levels: LevelsMap = { "hsk-1": createLevelProgress(deck, { curriculumSeed: "sim-seed", levelSize: LEVEL_SIZE, spawnOrdinal: 0 }) };
    let snapshot: SchedulerSnapshot = { spawnOrdinal: 0, schedulerRng: [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef] };
    const rng = new Xoshiro128StarStar([42, 7, 1970, 20260101]);

    let maxBacklog = 0;
    let maxSessionSpawns = 0;
    let maxStalls = 0;
    let correct = 0;
    let attempts = 0;
    let seen = 0;
    const everStabilityAtFirstReview = new Map<string, number>();

    for (let day = 0; day < SIMULATED_DAYS; day += 1) {
      const sessionStart = Date.parse("2026-01-01T00:00:00Z") + day * DAY_MS;
      const now = () => new Date(sessionStart);
      let spawns = 0;
      let stalls = 0;
      const maxSpawnsPerSession = 400;

      while (spawns < maxSpawnsPerSession) {
        const inFlight = new Set<string>();
        const result = spawnNextWord(levels["hsk-1"]!, deck, now(), snapshot, { ...{ spawnIntervalMs: 5000, enemySpeedMultiplier: 0.9, levelSize: LEVEL_SIZE, masterVolume: 0.8, reducedMotion: false } }, inFlight);
        if (result.status === "complete") break;
        if (result.status === "empty") {
          if (!result.coolingOnly) break; // nothing due within the horizon: session over
          // Empty field with due-but-cooling words: advance cooldown ordinals
          // like the game's empty-field clock does.
          stalls += 1;
          if (stalls > 40) break; // safety net; must not trigger in healthy runs
          snapshot = advanceOrdinal(snapshot);
          continue;
        }
        stalls = 0;
        spawns += 1;
        snapshot = result.snapshot;
        const wordId = result.wordId;
        if (!everStabilityAtFirstReview.has(wordId) && result.unseen) {
          everStabilityAtFirstReview.set(wordId, 0);
          seen += 1;
        }

        // Synthetic player: recall probability = retrievability per component.
        const progress = result.level.words[wordId]!;
        const pinyinOk = rng.nextUnit() < Math.max(0.05, componentRetrievability(progress.pinyin, now()) || (progress.pinyin.reps === 0 ? 0.6 : 0.05));
        const meaningOk = pinyinOk && rng.nextUnit() < 0.85;
        const outcome = !pinyinOk
          ? { kind: "wrongPinyin", pinyinMs: 2500 } as const
          : meaningOk
            ? { kind: "correct", pinyinMs: 2000, meaningMs: 1500 } as const
            : { kind: "wrongMeaning", pinyinMs: 2000, meaningMs: 4000 } as const;
        attempts += 1;
        if (outcome.kind === "correct") correct += 1;

        const applied = applyOutcomeToLevels(
          levels, "hsk-1", wordId, outcome, now(), snapshot.spawnOrdinal, { pinyinLength: pinyinLengthOf(wordId) },
        );
        levels = applied.levels;
      }
      maxSessionSpawns = Math.max(maxSessionSpawns, spawns);
      maxStalls = Math.max(maxStalls, stalls);

      // Due backlog for tomorrow: cards whose weaker component is due by now.
      let backlog = 0;
      for (const progress of Object.values(levels["hsk-1"]!.words)) {
        const dueMs = Math.min(Date.parse(progress.pinyin.due), Date.parse(progress.meaning.due));
        if (progress.introducedAtOrdinal !== null && dueMs <= sessionStart + DAY_MS) backlog += 1;
      }
      maxBacklog = Math.max(maxBacklog, backlog);

      // End-of-day rollover: nothing else to do, next session is a new day.
    }

    const finalLevel = levels["hsk-1"]!;
    const words = Object.values(finalLevel.words);
    const graduated = countGraduated(finalLevel);
    const stabilities = words.filter((w) => w.pinyin.state === "review").map((w) => w.pinyin.stability);
    const medianStability = stabilities.sort((a, b) => a - b)[Math.floor(stabilities.length / 2)] ?? 0;
    const accuracy = attempts > 0 ? correct / attempts : 0;
    const neverSeen = words.filter((w) => w.pinyin.reps === 0 && w.meaning.reps === 0).length;

    // Health properties.
    expect(seen).toBeGreaterThan(DECK_SIZE * 0.5); // the curriculum actually advances
    expect(graduated).toBeGreaterThan(DECK_SIZE * 0.5); // most cards graduate within ~3 months    expect(medianStability).toBeGreaterThan(1); // graduated cards hold multi-day stability
    expect(maxBacklog).toBeLessThanOrEqual(DECK_SIZE); // backlog bounded by deck size
    expect(maxSessionSpawns).toBeLessThan(400); // sessions terminate well before the safety net
    expect(maxStalls).toBeLessThanOrEqual(40); // cooldown stalls always resolved
    expect(accuracy).toBeGreaterThan(0.6); // retrievability-driven player mostly succeeds
    for (const word of words) {
      // A reviewed card never regresses to an unseen state.
      if (word.introducedAtOrdinal !== null) {
        expect(word.pinyin.reps).toBeGreaterThanOrEqual(0);
        if (word.pinyin.reps > 0) expect(word.pinyin.state).not.toBe("new");
        if (word.meaning.reps > 0) expect(word.meaning.state).not.toBe("new");
      }
    }
    expect(neverSeen).toBeLessThan(DECK_SIZE * 0.5); // graduation-paced introductions still cover most of the deck
  });
});
