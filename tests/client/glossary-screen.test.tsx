import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { GlossaryScreen, buildGlossaryEntries, buildGlossaryIndex } from "../../src/client/app/GlossaryScreen";
import { GradeMenu } from "../../src/client/app/App";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { createLevelProgress, type LearningDeck } from "../../src/domain/learning";
import { randomStateFromSeed } from "../../src/domain/random";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { SaveFile } from "../../src/shared/schemas";

function fixture() {
  const hsk1 = createDemoDeck("hsk-1");
  const hsk2 = createDemoDeck("hsk-2");
  const level = createLevelProgress(hsk1 as unknown as LearningDeck);
  const later = hsk1.words[0]!;
  const earlier = hsk1.words[1]!;
  level.words[later.id] = {
    ...level.words[later.id]!,
    introducedAtOrdinal: 9,
    learnReviews: 1,
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    card: { ...level.words[later.id]!.card, state: "learning", reps: 1 },
  };
  level.words[earlier.id] = {
    ...level.words[earlier.id]!,
    introducedAtOrdinal: 2,
    learnReviews: 3,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    card: { ...level.words[earlier.id]!.card, state: "review", reps: 3 },
  };
  const save: SaveFile = {
    schemaVersion: 5,
    profileId: "default",
    revision: 0,
    savedAt: new Date(0).toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 10,
    schedulerRng: randomStateFromSeed("glossary"),
    levels: { "hsk-1": level },
    acquiredWords: [`hsk-1:${earlier.id}`],
    learnSessions: {},
    relearnSession: null,
    lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
  };
  const decks = [{ deckId: "hsk-1" as const, deck: hsk1 }, { deckId: "hsk-2" as const, deck: hsk2 }];
  return { save, decks, earlier, later };
}

describe("GlossaryScreen", () => {
  test("sorts revealed words by encounter ordinal and keeps the full unrevealed catalogue concealed", () => {
    const { save, decks, earlier, later } = fixture();
    const entries = buildGlossaryEntries(save, decks);
    expect(entries[0]).toMatchObject({ key: `hsk-1:${earlier.id}`, revealed: true, encounterNumber: 1, mastery: 100 });
    expect(entries[1]).toMatchObject({ key: `hsk-1:${later.id}`, revealed: true, encounterNumber: 2 });
    expect(entries.slice(2)).toHaveLength(decks.reduce((sum, item) => sum + item.deck.words.length, 0) - 2);
    expect(entries.slice(2).every((entry) => !entry.revealed && entry.encounterNumber === null)).toBe(true);
  });

  test("derives the drawer lookup and summary counts in one pass over the entries", () => {
    const { save, decks, earlier } = fixture();
    const entries = buildGlossaryEntries(save, decks);
    const index = buildGlossaryIndex(entries);
    expect(index.encountered).toBe(2);
    expect(index.mastered).toBe(1);
    expect(index.byKey.size).toBe(entries.length);
    expect(entries.every((entry) => index.byKey.get(entry.key) === entry)).toBe(true);
    expect(index.byKey.get(`hsk-1:${earlier.id}`)).toBe(entries[0]);
  });

  test("renders the derived encountered and mastered totals in the summary", () => {
    const { save, decks } = fixture();
    const total = decks.reduce((sum, item) => sum + item.deck.words.length, 0);
    const html = renderToStaticMarkup(<GlossaryScreen save={save} decks={decks} strokeData={new Map()} onExit={vi.fn()} />);
    expect(html).toContain("<dt>ENCOUNTERED</dt><dd>2</dd>");
    expect(html).toContain("<dt>MASTERED</dt><dd>1</dd>");
    expect(html).toContain(`aria-label="Glossary with 2 encountered words and ${total - 2} concealed words"`);
  });

  test("draws revealed tile hanzi as vector outlines with no visible font text", () => {
    const { save, decks } = fixture();
    const stroke = {
      strokes: ["M 100 900 L 900 100"],
      medians: [[[100, 900], [900, 100]]] as [number, number][][],
    };
    // The fixture's two revealed words are 你 and 学习: three characters total.
    const strokeData = new Map([["你", stroke], ["学", stroke], ["习", stroke]]);
    const html = renderToStaticMarkup(<GlossaryScreen save={save} decks={decks} strokeData={strokeData} onExit={vi.fn()} />);
    expect(html.match(/class="hanzi-glyph"/g)).toHaveLength(3);
    expect(html).toContain('data-word-length="1"');
    expect(html).toContain('data-word-length="2"');
    expect(html).not.toContain("vector-text-accessible");
  });

  test("renders interactive faces only for encountered words and jade backs for the rest", () => {
    const { save, decks } = fixture();
    const gradeDecks = [decks[0]!];
    const html = renderToStaticMarkup(<GlossaryScreen save={save} decks={gradeDecks} strokeData={new Map()} onExit={vi.fn()} />);
    expect(html).not.toContain("ENCOUNTER GLOSSARY");
    expect(html).not.toContain("ALL TILES");
    expect(html.match(/class=\"legend-dot /g)).toHaveLength(4);
    expect(html).not.toContain("legend-tile");
    expect(html.match(/class=\"mahjong-tile tile-face/g)).toHaveLength(2);
    expect(html.match(/class=\"mahjong-tile tile-back/g)).toHaveLength(gradeDecks[0]!.deck.words.length - 2);
    expect(html.match(/<div class=\"mahjong-tile tile-back\" aria-hidden=\"true\"><\/div>/g)).toHaveLength(gradeDecks[0]!.deck.words.length - 2);
    expect(html).toContain("Return to glossary grade selection");
    expect(html).toContain("MASTERED");
  });

  test("reuses the Select Grade submenu for glossary grade selection", () => {
    const { save } = fixture();
    const html = renderToStaticMarkup(<GradeMenu
      save={save}
      selected="hsk-1"
      strokeData={new Map()}
      reducedMotion={false}
      purpose="glossary"
      onSelect={vi.fn()}
      onChoose={vi.fn()}
      onReturn={vi.fn()}
    />);
    expect(html).toContain('class="scroll-menu grade-menu"');
    expect(html).toContain('class="scroll-column return-column');
    expect(html).toContain('aria-label="Return to the main menu"');
    expect(html).toContain(`aria-label="HSK 1, 2 of ${Object.keys(save.levels["hsk-1"]!.words).length} words encountered"`);
    expect(html.match(/class="scroll-column level/g)).toHaveLength(6);
  });
});
