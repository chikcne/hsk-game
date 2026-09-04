import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { LearnScreen } from "../../src/client/app/LearnScreen";
import type { SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { createLearnSession, nextLearnCardId } from "../../src/domain/learn";
import { randomStateFromSeed } from "../../src/domain/random";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import type { StrokeCharacterData, StrokeDataMap } from "../../src/client/data/strokeData";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const vector: StrokeCharacterData = { strokes: ["M 0 0 L 10 10 Z"], medians: [[[0, 0], [10, 10]]] };
const strokeData: StrokeDataMap = new Map([["你", vector], ["好", vector], ["什", vector], ["么", vector]]);
const deck = createDemoDeck("hsk-1") as unknown as LearningDeck & { words: Array<{ id: string; displayHanzi: string; displayPinyin: string; meaning: string }> };
const runtimeDeck = createDemoDeck("hsk-1");

function baseSave(): SaveFile {
  return {
    schemaVersion: 4, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("learn-screen"),
    levels: { "hsk-1": createLevelProgress(deck, { curriculumSeed: "curriculum" }) },
    acquiredWords: [],
    learnSessions: {},
    relearnSession: null,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
}

function withSession(save: SaveFile, newCardLimit = 2) {
  const created = createLearnSession(deck, save.levels["hsk-1"]!, new Date(NOW), { newCardLimit, spawnOrdinal: 0 });
  return { ...save, levels: { ...save.levels, "hsk-1": created.level }, learnSessions: { ...save.learnSessions, "hsk-1": created.session } };
}

function renderLearn(save: SaveFile) {
  return renderToStaticMarkup(<LearnScreen
    save={save}
    deck={runtimeDeck}
    strokeData={strokeData}
    settings={{ ...DEFAULT_SETTINGS }}
    saveStatus="saved"
    onRate={vi.fn()}
    onExit={vi.fn()}
    onAgain={vi.fn()}
    onSettings={vi.fn()}
  />);
}

describe("LearnScreen markup", () => {
  test("renders the session HUD with grade, remaining count, and save state above the writing card", () => {
    const html = renderLearn(withSession(baseSave()));
    expect(html).toContain("HSK 1 · LEARN");
    expect(html).toMatch(/2 TO GO/); // two session members remain
    expect(html).toContain("PROGRESS SAVED");
    expect(html).toContain("GRADES");
    expect(html).toContain("writing-card");
    expect(html).toContain("writing-pinyin");
    expect(html).toContain("writing-meaning");
  });

  test("a never-reviewed card mounts in looping-demo mode; a reviewed one offers Show Demo", () => {
    let save = withSession(baseSave(), 2);
    // The session's first new card has never been reviewed: looping demo.
    expect(renderLearn(save)).toContain('data-writing-mode="demo-loop"');

    // Review the currently served card: its next appearance must mount in
    // writing mode with a Show Demo control instead of the looping demo.
    const session = save.learnSessions["hsk-1"]!;
    const level = save.levels["hsk-1"]!;
    const next = nextLearnCardId(session, level, new Date(NOW));
    if (next.status !== "card") throw new Error("expected a card");
    const served = level.words[next.wordId]!;
    save = { ...save, levels: { ...save.levels, "hsk-1": { ...level, words: { ...level.words, [next.wordId]: { ...served, card: { ...served.card, state: "learning", reps: 2, lastReview: new Date(NOW).toISOString() } } } } } };
    const html = renderLearn(save);
    expect(html).toContain('data-writing-mode="writing"');
    expect(html).toContain("SHOW DEMO");
    expect(html).not.toContain("TAP TO BEGIN");
  });

  test("a completed session renders the Learn summary instead of a card", () => {
    const save = baseSave(); // no active session for the grade
    const html = renderLearn(save);
    expect(html).toContain("LEARN COMPLETE");
    expect(html).toContain("RETURN TO GRADES");
    expect(html).toContain("LEARN AGAIN");
    expect(html).not.toContain("writing-card");
  });

  test("the screen describes the active word for assistive technology", () => {
    const html = renderLearn(withSession(baseSave()));
    expect(html).toContain('aria-label="Write \u4ec0\u4e48 (sh\u00e9nme)"');
    expect(html).toContain("PROGRESS SAVED");
  });
});

describe("Learn HUD lesson math", () => {
  test("uses the shared curriculumLessonNumber (floor), not a ceiling", () => {
    // 3 introduced words at levelSize 2: floor(3/2) = lesson 1 (a ceiling
    // would misleadingly report lesson 2 before the second lesson exists).
    const save = withSession(baseSave(), 3);
    const level = { ...save.levels["hsk-1"]!, curriculumCursor: 3 };
    const html = renderLearn({ ...save, settings: { ...DEFAULT_SETTINGS, levelSize: 2 }, levels: { ...save.levels, "hsk-1": level } });
    expect(html).toMatch(/LESSON 1</);
    expect(html).not.toMatch(/LESSON 2</);
  });
});
