import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { RelearnScreen } from "../../src/client/app/RelearnScreen";
import type { RuntimeDeck, SaveFile } from "../../src/shared/schemas";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { createRelearnSession } from "../../src/domain/relearn";
import { randomStateFromSeed } from "../../src/domain/random";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { createReviewDeck } from "../../src/client/data/reviewDeck";
import { reviewWordKey } from "../../src/domain/review";
import type { StrokeCharacterData, StrokeDataMap } from "../../src/client/data/strokeData";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const vector: StrokeCharacterData = { strokes: ["M 0 0 L 10 10 Z"], medians: [[[0, 0], [10, 10]]] };
const strokeData: StrokeDataMap = new Map([["你", vector], ["好", vector], ["什", vector], ["么", vector], ["学", vector], ["习", vector]]);
const deck = createDemoDeck("hsk-1") as unknown as LearningDeck;

function baseSaveWithSession(wordIndices: number[]): { save: SaveFile; mergedDeck: RuntimeDeck } {
  const level = createLevelProgress(deck);
  const keys = wordIndices.map((index) => reviewWordKey("hsk-1", deck.words[index]!.id));
  const save: SaveFile = {
    schemaVersion: 5, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: randomStateFromSeed("relearn-screen"),
    levels: { "hsk-1": level },
    acquiredWords: keys,
    learnSessions: {},
    relearnSession: createRelearnSession(keys, new Date(NOW)),
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
  // The screen consumes the merged key-scoped deck exactly as App builds it.
  const mergedDeck = createReviewDeck(new Map([["hsk-1" as const, createDemoDeck("hsk-1")]]), keys).deck;
  return { save, mergedDeck };
}

function renderRelearn(save: SaveFile, mergedDeck: RuntimeDeck) {
  return renderToStaticMarkup(<RelearnScreen
    save={save}
    deck={mergedDeck}
    strokeData={strokeData}
    settings={{ ...DEFAULT_SETTINGS }}
    saveStatus="saved"
    onRate={vi.fn()}
    onExit={vi.fn()}
    onSettings={vi.fn()}
  />);
}

describe("RelearnScreen markup", () => {
  test("renders the relearn HUD with remaining count and the writing card", () => {
    const { save, mergedDeck } = baseSaveWithSession([0, 1]);
    const html = renderRelearn(save, mergedDeck);
    expect(html).toContain("RE-LEARN");
    expect(html).toMatch(/2 TO GO/);
    expect(html).toContain("PROGRESS SAVED");
    expect(html).toContain("GRADES");
    expect(html).toContain("writing-card");
    expect(html).toContain("writing-pinyin");
    expect(html).toContain("writing-meaning");
  });

  test("a member's first relearn presentation starts in writing mode without an automatic demo", () => {
    const { save, mergedDeck } = baseSaveWithSession([0]);
    const html = renderRelearn(save, mergedDeck);
    expect(html).toContain('data-writing-mode="writing"');
    expect(html).toContain("SHOW DEMO");
    expect(html).not.toContain('data-writing-mode="demo-loop"');
  });

  test("an empty session renders the completion summary instead of a card", () => {
    const { save, mergedDeck } = baseSaveWithSession([0]);
    const summary = renderRelearn({ ...save, relearnSession: null }, mergedDeck);
    expect(summary).toContain("RE-LEARN COMPLETE");
    expect(summary).toContain("RETURN TO GRADES");
    expect(summary).not.toContain("writing-card");
  });
});
