import { describe, expect, it } from "vitest";
import type { WordProgress } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import {
  applyWordOutcome, componentFamiliarity, createComponentMemory, isGraduated, isMemoryDue,
  wordFamiliarity,
} from "../../src/domain/memory";
import { createWordProgress } from "../../src/domain/learning";

const NOW = "2026-01-01T00:00:00.000Z";

describe("automatic FSRS rating mapping", () => {
  it("grades revealed pinyin as Again even when the meaning choice succeeds", () => {
    const word = createWordProgress();
    const autocompleted = applyWordOutcome(
      word,
      { kind: "correct", pinyinMs: 12_000, meaningMs: 900, pinyinAutocompleted: true },
      NOW,
      { pinyinAutocompleted: true, pinyinLength: 5 },
    );
    expect(autocompleted.ratings.pinyin).toBe("again");
    expect(autocompleted.ratings.meaning).toBe("good");
    expect(autocompleted.progress.pinyin.state).toBe("learning");
    expect(autocompleted.progress.meaning.reps).toBe(1);
    expect(autocompleted.struggled).toBe(true);
    expect(autocompleted.cooldownPhrases).toBe(3);
  });

  it("normalizes pinyin latency per character: fast Easy, effortful Hard, normal Good", () => {
    const easy = applyWordOutcome(createWordProgress(), { kind: "correct", pinyinMs: 2000, meaningMs: 800 }, NOW, { pinyinLength: 5 });
    expect(easy.ratings.pinyin).toBe("good"); // 400 ms/char, but first exposure caps Easy
    const easyVeteran = applyWordOutcome({ ...createWordProgress(), pinyin: { ...createComponentMemory(), reps: 1 }, meaning: { ...createComponentMemory(), reps: 1 } }, { kind: "correct", pinyinMs: 2000, meaningMs: 800 }, NOW, { pinyinLength: 5 });
    expect(easyVeteran.ratings.pinyin).toBe("easy");

    const longAnswer = applyWordOutcome(createWordProgress(), { kind: "correct", pinyinMs: 16_000, meaningMs: 800 }, NOW, { pinyinLength: 8 });
    expect(longAnswer.ratings.pinyin).toBe("good"); // 2000 ms/char: slow in total, fine per char
    const hard = applyWordOutcome(createWordProgress(), { kind: "correct", pinyinMs: 21_000, meaningMs: 800 }, NOW, { pinyinLength: 7 });
    expect(hard.ratings.pinyin).toBe("hard"); // 3000 ms/char
    expect(hard.struggled).toBe(true);
    expect(hard.progress.pinyin.state).toBe("learning"); // Hard is still a pass, never a lapse
  });

  it("splits pinyin and meaning evidence for wrong-meaning answers", () => {
    const word = createWordProgress();
    const result = applyWordOutcome(word, { kind: "wrongMeaning", pinyinMs: 1500, meaningMs: 4000 }, NOW, { pinyinLength: 5 });
    expect(result.ratings.pinyin).toBe("good");
    expect(result.ratings.meaning).toBe("again");
    expect(result.progress.pinyin.reps).toBe(1);
    expect(result.progress.meaning.state).toBe("learning");
    expect(result.progress.wrongMeaning).toBe(1);
    expect(result.cooldownPhrases).toBe(3);
  });

  it("grades wrong pinyin as Again without touching the meaning component", () => {
    const word = createWordProgress();
    const result = applyWordOutcome(word, { kind: "wrongPinyin", pinyinMs: 1200 }, NOW, { pinyinLength: 5 });
    expect(result.ratings.pinyin).toBe("again");
    expect(result.ratings.meaning).toBeNull();
    expect(result.progress.meaning.reps).toBe(0);
    expect(result.progress.pinyin.lapses).toBe(0); // first exposure is a learning step, not a lapse
    expect(result.progress.wrongPinyin).toBe(1);
  });

  it("maps a correct meaning pick slower than 5s to Hard", () => {
    const word = createWordProgress();
    const slow = applyWordOutcome(word, { kind: "correct", pinyinMs: 2000, meaningMs: 6000 }, NOW, { pinyinLength: 5 });
    expect(slow.ratings.meaning).toBe("hard");
    const quick = applyWordOutcome(word, { kind: "correct", pinyinMs: 2000, meaningMs: 1500 }, NOW, { pinyinLength: 5 });
    expect(quick.ratings.meaning).toBe("good");
  });
});

describe("graduation and due-ness", () => {
  it("graduates only when both components reach review stage", () => {
    const fresh = createWordProgress();
    expect(isGraduated(fresh)).toBe(false);
    const reviewed = applyWordOutcome(fresh, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, { pinyinLength: 5 });
    expect(isGraduated(reviewed.progress)).toBe(false); // learning, not review
  });

  it("marks due-ness from the weaker component", () => {
    const fresh = createWordProgress();
    expect(isMemoryDue(fresh, new Date(0))).toBe(true); // new cards are due immediately
    const reviewed = applyWordOutcome(fresh, { kind: "correct", pinyinMs: 2000, meaningMs: 1000 }, NOW, { pinyinLength: 5 });
    expect(isMemoryDue(reviewed.progress, new Date(NOW))).toBe(false);
    expect(isMemoryDue(reviewed.progress, new Date(Date.parse(NOW) + 11 * 60_000))).toBe(true);
  });

  it("derives familiarity from memory state for arcade speed and pressure", () => {
    const fresh = createWordProgress();
    expect(wordFamiliarity(fresh)).toBe(0);
    expect(componentFamiliarity(fresh.pinyin)).toBe(0);
    const learning = componentFamiliarity({ ...createComponentMemory(), state: "learning", reps: 1 });
    expect(learning).toBeGreaterThan(0);
    const reviewOneWeek = componentFamiliarity({ ...createComponentMemory(), state: "review", stability: 7, reps: 2 });
    const reviewOneYear = componentFamiliarity({ ...createComponentMemory(), state: "review", stability: 365, reps: 5 });
    expect(reviewOneWeek).toBeGreaterThan(learning);
    expect(reviewOneYear).toBeGreaterThan(reviewOneWeek);
    expect(reviewOneYear).toBeLessThanOrEqual(1);
  });
});

describe("counter bookkeeping", () => {
  it("maintains outcome counters and pinyin timing stats", () => {
    let progress: WordProgress = createWordProgress();
    progress = applyWordOutcome(progress, { kind: "correct", pinyinMs: 1000, meaningMs: 50_000 }, NOW, { pinyinLength: 5 }).progress;
    progress = applyWordOutcome(progress, { kind: "wrongMeaning", pinyinMs: 2000, meaningMs: 1 }, NOW, { pinyinLength: 5 }).progress;
    expect(progress.attempts).toBe(2);
    expect(progress.totalPinyinMs).toBe(3000);
    expect(progress.fastestPinyinMs).toBe(1000);
    expect(progress.lastSeenAt).toBe(NOW);
    expect(progress.attempts).toBe(progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed);
    expect(DEFAULT_SETTINGS.levelSize).toBeGreaterThan(0); // settings still carry the arcade knob
  });
});
