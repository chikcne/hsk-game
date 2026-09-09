import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { GlossaryScreen, buildGlossaryEntries, buildGlossaryIndex } from "../../src/client/app/GlossaryScreen";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { VocabRow } from "../../src/shared/battle";

function fixture() {
  const hsk1 = createDemoDeck("hsk-1");
  const hsk2 = createDemoDeck("hsk-2");
  // Curriculum positions 1 and 2 revealed: position 2 (earlier deck word) is
  // mastered at 100, position 1 sits mid-mastery.
  const later = hsk1.words[0]!;
  const earlier = hsk1.words[1]!;
  const vocab: VocabRow[] = [
    { id: 1, cardId: later.id, mastery: 40, timeAdded: "2026-01-01T00:00:00.000Z", timeMastered: null },
    { id: 2, cardId: earlier.id, mastery: 100, timeAdded: "2025-12-31T00:00:00.000Z", timeMastered: "2026-01-02T00:00:00.000Z" },
  ];
  const decks = [{ deckId: "hsk-1" as const, deck: hsk1 }, { deckId: "hsk-2" as const, deck: hsk2 }];
  return { vocab, decks, earlier, later };
}

describe("GlossaryScreen", () => {
  test("sorts revealed words by curriculum position and keeps the unrevealed catalogue concealed", () => {
    const { vocab, decks, earlier, later } = fixture();
    const entries = buildGlossaryEntries(vocab, decks);
    expect(entries[0]).toMatchObject({ key: `hsk-1:${later.id}`, revealed: true, encounterNumber: 1, mastery: 40 });
    expect(entries[1]).toMatchObject({ key: `hsk-1:${earlier.id}`, revealed: true, encounterNumber: 2, mastery: 100 });
    expect(entries.slice(2)).toHaveLength(decks.reduce((sum, item) => sum + item.deck.words.length, 0) - 2);
    expect(entries.slice(2).every((entry) => !entry.revealed && entry.encounterNumber === null)).toBe(true);
  });

  test("derives the drawer lookup and summary counts in one pass over the entries", () => {
    const { vocab, decks, earlier } = fixture();
    const entries = buildGlossaryEntries(vocab, decks);
    const index = buildGlossaryIndex(entries);
    expect(index.encountered).toBe(2);
    expect(index.mastered).toBe(1);
    expect(index.byKey.size).toBe(entries.length);
    expect(entries.every((entry) => index.byKey.get(entry.key) === entry)).toBe(true);
    expect(index.byKey.get(`hsk-1:${earlier.id}`)).toBe(entries[1]);
  });

  test("keeps one duplicate card in its earliest DECK_IDS deck and counts it once", () => {
    const hsk1 = createDemoDeck("hsk-1");
    const hsk2 = createDemoDeck("hsk-2");
    const duplicateId = hsk1.words[0]!.id;
    hsk2.words[0] = { ...hsk2.words[0]!, id: duplicateId };
    const vocab: VocabRow[] = [{
      id: 1,
      cardId: duplicateId,
      mastery: 100,
      timeAdded: "2026-01-01T00:00:00.000Z",
      timeMastered: "2026-01-02T00:00:00.000Z",
    }];

    // Deliberately reverse the input: precedence is DECK_IDS, not caller order.
    const entries = buildGlossaryEntries(vocab, [
      { deckId: "hsk-2", deck: hsk2 },
      { deckId: "hsk-1", deck: hsk1 },
    ]);
    const duplicates = entries.filter((entry) => entry.word.id === duplicateId);
    const index = buildGlossaryIndex(entries);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ deckId: "hsk-1", revealed: true, mastery: 100 });
    expect(entries).toHaveLength(hsk1.words.length + hsk2.words.length - 1);
    expect(index.encountered).toBe(1);
    expect(index.mastered).toBe(1);
  });

  test("renders the derived encountered and mastered totals in the summary", () => {
    const { vocab, decks } = fixture();
    const total = decks.reduce((sum, item) => sum + item.deck.words.length, 0);
    const html = renderToStaticMarkup(<GlossaryScreen settings={{ ...DEFAULT_SETTINGS }} vocab={vocab} decks={decks} strokeData={new Map()} onExit={vi.fn()} />);
    expect(html).toContain("<dt>ENCOUNTERED</dt><dd>2</dd>");
    expect(html).toContain("<dt>MASTERED</dt><dd>1</dd>");
    expect(html).toContain(`aria-label="Glossary with 2 encountered words and ${total - 2} concealed words"`);
  });

  test("draws revealed tile hanzi as vector outlines with no visible font text", () => {
    const { vocab, decks } = fixture();
    const stroke = {
      strokes: ["M 100 900 L 900 100"],
      medians: [[[100, 900], [900, 100]]] as [number, number][][],
    };
    // The fixture's two revealed words are 你 and 学习: three characters total.
    const strokeData = new Map([["你", stroke], ["学", stroke], ["习", stroke]]);
    const html = renderToStaticMarkup(<GlossaryScreen settings={{ ...DEFAULT_SETTINGS }} vocab={vocab} decks={decks} strokeData={strokeData} onExit={vi.fn()} />);
    expect(html.match(/class="hanzi-glyph"/g)).toHaveLength(3);
    expect(html).toContain('data-word-length="1"');
    expect(html).toContain('data-word-length="2"');
    expect(html).not.toContain("vector-text-accessible");
  });

  test("renders interactive faces only for vocabulary words and jade backs for the rest", () => {
    const { vocab, decks } = fixture();
    const gradeDecks = [decks[0]!];
    const html = renderToStaticMarkup(<GlossaryScreen settings={{ ...DEFAULT_SETTINGS }} vocab={vocab} decks={gradeDecks} strokeData={new Map()} onExit={vi.fn()} />);
    expect(html).not.toContain("ENCOUNTER GLOSSARY");
    expect(html).not.toContain("ALL TILES");
    expect(html.match(/class=\"legend-dot /g)).toHaveLength(4);
    expect(html).not.toContain("legend-tile");
    expect(html.match(/class=\"mahjong-tile tile-face/g)).toHaveLength(2);
    expect(html.match(/class=\"mahjong-tile tile-back/g)).toHaveLength(gradeDecks[0]!.deck.words.length - 2);
    expect(html).toContain("Return to the main menu");
    expect(html).toContain("MASTERED");
  });
});
