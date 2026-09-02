import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { choiceShortcutForLabel, choiceShortcutsForLabel, generateChoices } from "../../src/domain/session/choices";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { DECK_IDS } from "../../src/shared/constants";
import type { RuntimeDeck } from "../../src/shared/schemas";

const keys = (label: string) => choiceShortcutsForLabel(label).map((shortcut) => shortcut.key).join("");
const compiledDecks = DECK_IDS.map((id) =>
  JSON.parse(readFileSync(new URL(`../../public/game-data/${id}/deck.json`, import.meta.url), "utf8")) as RuntimeDeck);
const everyLabel = [...new Set(compiledDecks.flatMap((deck) =>
  [...deck.words.map((word) => word.meaning.trim()), ...Object.values(deck.meaningIndex).map((entry) => entry.label.trim())]))];

describe("meaning choices", () => {
  it("uses the operative word after grammatical scaffolding", () => {
    expect(choiceShortcutForLabel("to drink")).toEqual({ key: "D", index: 3 });
    expect(choiceShortcutForLabel("to get sick")).toEqual({ key: "S", index: 7 });
    expect(choiceShortcutForLabel("to be afraid")).toEqual({ key: "A", index: 6 });
    expect(choiceShortcutForLabel("to make a phone call")).toEqual({ key: "P", index: 10 });
    expect(choiceShortcutForLabel("to keep warm")).toEqual({ key: "W", index: 8 });
    expect(choiceShortcutForLabel("to fall in love")).toEqual({ key: "L", index: 11 });
    expect(choiceShortcutForLabel("to like")).toEqual({ key: "L", index: 3 });
    expect(choiceShortcutForLabel("from behind cover")).toEqual({ key: "C", index: 12 });
    expect(choiceShortcutForLabel("school")).toEqual({ key: "S", index: 0 });
  });

  it("falls back to a bare light verb within the first gloss", () => {
    expect(choiceShortcutForLabel("to get")).toEqual({ key: "G", index: 3 });
    expect(choiceShortcutForLabel("to get, to obtain")).toEqual({ key: "G", index: 3 });
    expect(choiceShortcutForLabel("to")).toEqual({ key: "T", index: 0 });
  });

  it("creates a shortcut for every comma- or semicolon-separated gloss", () => {
    expect(choiceShortcutsForLabel("to think; to want")).toEqual([
      { key: "T", index: 3 },
      { key: "W", index: 13 },
    ]);
    expect(choiceShortcutsForLabel("to get, to obtain; to be afraid")).toEqual([
      { key: "G", index: 3 },
      { key: "O", index: 11 },
      { key: "A", index: 25 },
    ]);
    expect(choiceShortcutsForLabel("cup, glass")).toEqual([
      { key: "C", index: 0 },
      { key: "G", index: 5 },
    ]);
  });

  it("makes deterministic safe choices with distinct highlighted-letter shortcuts", () => {
    const deck = createDemoDeck("hsk-1");
    const first = generateChoices(deck, deck.words[0]!, "enemy-1");
    const again = generateChoices(deck, deck.words[0]!, "enemy-1");

    expect(first).toEqual(again);
    expect(first).toHaveLength(8);
    expect(first.filter((choice) => choice.correct)).toHaveLength(1);
    expect(new Set(first.map((choice) => choice.label)).size).toBe(8);
    expect(first.filter((choice) => choice.label.startsWith("to ")).length).toBeGreaterThan(1);
    const owners = new Map<string, string>();
    for (const choice of first) {
      for (const shortcut of choice.shortcuts) {
        expect(shortcut.key).toBe(choice.label.charAt(shortcut.index).toUpperCase());
        const owner = owners.get(shortcut.key);
        expect(owner === undefined || owner === choice.label).toBe(true);
        owners.set(shortcut.key, choice.label);
      }
    }
    expect(first.find((choice) => choice.correct)?.shortcuts).toEqual([
      { key: "S", index: 3 },
      { key: "L", index: 13 },
    ]);
  });

  it("ignores parenthetical usage notes, which are not meanings", () => {
    expect(keys("here (formal; southern china)")).toBe("H");
    expect(keys("there (formal; Southern China; written Mandarin)")).toBe("T");
    expect(keys("it (object, animals)")).toBe("I");
    expect(keys("Sunday (formal; written Chinese)")).toBe("S");
    expect(keys("to take (medicine)")).toBe("T");
    expect(keys("to give; (to, for)")).toBe("G");
    expect(keys("to hold, to convene, to conduct (a ceremony, meeting, event)")).toBe("HC");
    // A label that is nothing but a parenthetical still needs a key.
    expect(keys("（in vain, for nothing）")).toBe("VN");
  });

  it("anchors a structural gloss on what is counted, not on the meta-word", () => {
    expect(choiceShortcutForLabel("measure word for books")).toEqual({ key: "B", index: 17 });
    expect(keys("measure word for people")).toBe("P");
    expect(keys("measure word for an indefinite amount")).toBe("I");
    // The enumeration names one measure word, not three meanings.
    expect(keys("measure word for pieces, chunks, money")).toBe("P");
    expect(keys("measure word for trees, plants, and other similar objects")).toBe("T");
    // A semicolon still starts a new gloss.
    expect(keys("measure word for books; volume")).toBe("BV");
    expect(keys("suffix meaning person, one who")).toBe("P");
    expect(keys("particle indicating suggestion, confirmation, or hesitation")).toBe("S");
    expect(keys("prefix for ordinal numbers")).toBe("O");
    expect(keys("auxiliary word (classical)")).toBe("A");
  });

  it("anchors a phrasal verb on its verb and keys the particle second", () => {
    expect(keys("to go up")).toBe("GU");
    expect(keys("to go down")).toBe("GD");
    expect(keys("to go out")).toBe("GO");
    expect(keys("to come out")).toBe("CO");
    expect(keys("to come back")).toBe("CB");
    expect(keys("to give back")).toBe("GB");
    expect(keys("to look back")).toBe("LB");
    expect(keys("to look forward to")).toBe("LF");
    // A prepositional complement is not a particle, and a real object still wins.
    expect(keys("to look at")).toBe("L");
    expect(keys("to get off work")).toBe("W");
    expect(keys("to fall in love")).toBe("L");
  });

  it("treats coordinators and placeholders as scaffolding", () => {
    expect(keys("inside and outside")).toBe("I");
    expect(keys("up and down, high and low")).toBe("UH");
    expect(keys("to come and go")).toBe("C");
    expect(keys("to do as one pleases")).toBe("P");
    expect(keys("to keep someone company")).toBe("C");
    expect(keys("to go to someone's house")).toBe("H");
    expect(keys("to do something ahead of time")).toBe("T");
    // A gloss that opens with a placeholder is about the placeholder.
    expect(keys("one-sided")).toBe("O");
    expect(keys("one by one")).toBe("O");
  });

  it("keys prepositions that are used lexically rather than as scaffolding", () => {
    expect(keys("to resemble, to be like; (as if, such as); (image, statue, portrait)")).toBe("RL");
    expect(keys("down jacket")).toBe("D");
    expect(keys("past years")).toBe("P");
    expect(keys("above-mentioned")).toBe("A");
    expect(keys("per capita")).toBe("P");
    expect(keys("of course")).toBe("O");
    expect(keys("over the years")).toBe("O");
    expect(keys("as if, seem")).toBe("AS");
  });

  it("caps and dedupes the keys one choice may claim", () => {
    expect(keys("he, him")).toBe("H");
    expect(keys("not, no")).toBe("N");
    expect(keys("light, rayl smooth, shiny, used up; bare, expose; only, merely, solely")).toBe("LRS");
    expect(keys("to be certain, to be sure, to affirm; positive, affirmative, definite; surely, certainly, definitely")).toBe("CSA");
    for (const label of everyLabel) expect(choiceShortcutsForLabel(label).length).toBeLessThanOrEqual(3);
  });

  it("marks the letter it keys, for every label in every compiled deck", () => {
    expect(everyLabel.length).toBeGreaterThan(4000);
    for (const label of everyLabel) {
      const shortcuts = choiceShortcutsForLabel(label);
      expect(shortcuts.length, label).toBeGreaterThan(0);
      for (const shortcut of shortcuts) expect(label.charAt(shortcut.index).toUpperCase()).toBe(shortcut.key);
    }
  });

  it("fills a round for every word in every compiled deck", () => {
    for (const deck of compiledDecks) {
      for (const word of deck.words) {
        for (const seed of ["enemy-1", "enemy-2"]) {
          expect(() => generateChoices(deck, word, seed), `${word.displayHanzi} ${seed}`).not.toThrow();
        }
      }
    }
  });

  it("keeps the same-part-of-speech preference through the shuffle", () => {
    const deck = compiledDecks[2]!;
    let distractors = 0;
    let samePartOfSpeech = 0;
    for (const word of deck.words) {
      if (!word.partOfSpeechKey) continue;
      for (const choice of generateChoices(deck, word, `seed-${word.id}`)) {
        if (choice.correct) continue;
        distractors += 1;
        const entry = Object.values(deck.meaningIndex).find((item) => item.label.trim() === choice.label);
        if (entry?.partOfSpeechKeys.includes(word.partOfSpeechKey)) samePartOfSpeech += 1;
      }
    }
    expect(samePartOfSpeech / distractors).toBeGreaterThan(0.8);
  });
});
