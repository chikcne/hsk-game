import { describe, expect, it } from "vitest";
import type { DeckId } from "../../src/shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../src/shared/schemas";
import { createBattleDeck } from "../../src/client/data/battleDeck";
import { curriculumFromWordIds } from "../../src/domain/learning";
import { generateChoices, generateChoicesLenient, safeMeaningChoices } from "../../src/domain/session/choices";

/** A small source deck: `wordCount` words whose meanings each start with a
 * distinct letter (the deck's own band of the alphabet, so two decks never
 * share distractor initials), keeping pools compact but colliding-free. */
function sourceDeck(id: DeckId, wordCount = 4, fingerprint = `${id}-fp`): RuntimeDeck {
  const letterOffset = (Number(id.at(-1)) - 1) * 6;
  const words: RuntimeWord[] = Array.from({ length: wordCount }, (_, index) => ({
    id: `card-${id}-${String(index).padStart(2, "0")}`,
    sourceGuids: [],
    displayHanzi: `字${index}`,
    hanziKey: `zi${index}`,
    displayPinyin: `zì ${index}`,
    acceptedPinyin: [`zi ${index}`],
    pinyinSegments: [["zì"], [`${index}`]],
    partOfSpeech: null,
    partOfSpeechKey: index % 2 === 0 ? "verb" : null,
    senseLabel: null,
    meaning: `${String.fromCharCode(97 + letterOffset + index)}meaning ${id} ${index}`,
    meaningKey: `meaning-${index}`,
    audioUrl: "",
  }));
  const meaningIndex = Object.fromEntries(words.map((word) => [word.meaningKey, {
    label: word.meaning,
    wordIds: [word.id],
    hanziKeys: [word.hanziKey],
    partOfSpeechKeys: word.partOfSpeechKey ? [word.partOfSpeechKey] : [],
  }]));
  const meaningKeysByPartOfSpeech: RuntimeDeck["meaningKeysByPartOfSpeech"] = { verb: [] };
  for (const [meaningKey, entry] of Object.entries(meaningIndex)) {
    if (entry.partOfSpeechKeys.length > 0) meaningKeysByPartOfSpeech.verb!.push(meaningKey);
  }
  return {
    schemaVersion: 1, importerVersion: "test", id, hskLevel: Number(id.at(-1)), title: id, fingerprint,
    source: { sharedId: 0, url: "test", packageSha256: fingerprint, sourceNoteCount: words.length, logicalWordCount: words.length },
    curriculum: curriculumFromWordIds(words.map((word) => word.id)),
    words, meaningIndex, meaningKeysByPartOfSpeech,
    allMeaningKeys: words.map((word) => word.meaningKey),
  };
}

describe("createBattleDeck corpus membership", () => {
  it("merges every source deck's words under their card ids with namespaced pools", () => {
    const hsk1 = sourceDeck("hsk-1", 4);
    const hsk2 = sourceDeck("hsk-2", 4);
    const decks = new Map<DeckId, RuntimeDeck>([["hsk-1", hsk1], ["hsk-2", hsk2]]);

    const { deck } = createBattleDeck(decks);

    // Full corpus membership: card ids stay raw (vocab `card_id` maps 1:1)…
    expect(deck.words.map((word) => word.id)).toEqual([
      ...hsk1.words.map((word) => word.id),
      ...hsk2.words.map((word) => word.id),
    ]);
    expect(deck.source.sourceNoteCount).toBe(8);
    expect(deck.source.logicalWordCount).toBe(8);
    // …but distractor pools draw from every loaded source deck, namespaced.
    expect(deck.allMeaningKeys).toHaveLength(8);
    for (const deckId of ["hsk-1", "hsk-2"] as const) {
      for (const meaningKey of hsk1.allMeaningKeys) {
        expect(deck.allMeaningKeys).toContain(`${deckId}:${meaningKey}`);
      }
    }
    expect(deck.meaningIndex["hsk-2:meaning-2"]?.label).toBe(hsk2.meaningIndex["meaning-2"]?.label);
    expect(deck.meaningIndex["hsk-2:meaning-2"]?.hanziKeys).toEqual(["hsk-2:zi2"]);
    expect(deck.meaningKeysByPartOfSpeech["hsk-1:verb"]).toEqual(["hsk-1:meaning-0", "hsk-1:meaning-2"]);
    expect(deck.meaningKeysByPartOfSpeech["hsk-2:verb"]).toEqual(["hsk-2:meaning-0", "hsk-2:meaning-2"]);
    // A member word's own keys are namespaced consistently with the pools.
    expect(deck.words[0]!.meaningKey).toBe("hsk-1:meaning-0");
    expect(deck.words[0]!.hanziKey).toBe("hsk-1:zi0");
    // The runtime curriculum covers every word exactly once, in corpus order.
    const curriculumIds = deck.curriculum.lessons.flatMap((lesson) => lesson.wordIds);
    expect(curriculumIds).toEqual(deck.words.map((word) => word.id));
  });

  it("collapses a duplicate card id to its earliest deck (curriculum rule)", () => {
    const hsk1 = sourceDeck("hsk-1", 2);
    const later = sourceDeck("hsk-2", 2);
    // hsk-2 re-ships hsk-1's first card under its own meaning keys.
    const duplicated: RuntimeWord = { ...hsk1.words[0]!, meaning: "duplicate meaning", meaningKey: "dup" };
    later.words = [duplicated, ...later.words.slice(1)];
    const decks = new Map<DeckId, RuntimeDeck>([["hsk-1", hsk1], ["hsk-2", later]]);

    const { deck } = createBattleDeck(decks);

    const occurrences = deck.words.filter((word) => word.id === hsk1.words[0]!.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.meaning).toBe(hsk1.words[0]!.meaning);
    expect(occurrences[0]!.meaningKey).toBe(`hsk-1:${hsk1.words[0]!.meaningKey}`);
  });

  it("resolves per-deck relative audio URLs against the owning grade", () => {
    const hsk1 = sourceDeck("hsk-1", 1);
    hsk1.words[0]!.audioUrl = "audio/word.mp3";
    const { deck } = createBattleDeck(new Map([["hsk-1", hsk1]]));
    expect(deck.words[0]!.audioUrl).toBe("/game-data/hsk-1/audio/word.mp3");
  });

  it("feeds full choice generation from the merged pools", () => {
    const hsk1 = sourceDeck("hsk-1", 6);
    const hsk2 = sourceDeck("hsk-2", 6);
    const { deck } = createBattleDeck(new Map<DeckId, RuntimeDeck>([["hsk-1", hsk1], ["hsk-2", hsk2]]));
    const word = deck.words[0]!;

    const choices = generateChoices(deck, word, "seed");
    expect(choices).toHaveLength(8);
    expect(choices.filter((choice) => choice.correct)).toHaveLength(1);
    const keys = choices.flatMap((choice) => choice.shortcuts.map((shortcut) => shortcut.key));
    expect(new Set(keys).size).toBe(keys.length); // unique shortcut keys

    // A single-deck map has a smaller pool: the LENIENT path still supplies
    // the correct choice for every word.
    const single = createBattleDeck(new Map([["hsk-1", hsk1]])).deck;
    const singleChoices = safeMeaningChoices(single, single.words[1]!, "seed");
    expect(singleChoices.length).toBeGreaterThanOrEqual(1);
    expect(singleChoices.some((choice) => choice.correct)).toBe(true);
  });
});

describe("defensive choice generation", () => {
  it("generateChoicesLenient degrades to fewer unique choices, always including correct", () => {
    // Two words whose meanings collide on the same shortcut key: the strict
    // generator throws, the lenient one returns what it can, correct first.
    const tiny = sourceDeck("hsk-1", 2);
    const tinyDeck = createBattleDeck(new Map([["hsk-1", tiny]])).deck;
    expect(() => generateChoices(tinyDeck, tinyDeck.words[0]!, "seed")).toThrow(/Not enough meanings/);
    const choices = generateChoicesLenient(tinyDeck, tinyDeck.words[0]!, "seed");
    expect(choices.length).toBeGreaterThanOrEqual(1);
    expect(choices[0]!.correct).toBe(true);
    const keys = choices.flatMap((choice) => choice.shortcuts.map((shortcut) => shortcut.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("safeMeaningChoices NEVER throws and always includes exactly one correct choice", () => {
    const hsk1 = sourceDeck("hsk-1", 5);
    const deck = createBattleDeck(new Map([["hsk-1", hsk1]])).deck;
    for (const word of deck.words) {
      const choices = safeMeaningChoices(deck, word, "seed");
      expect(choices.length).toBeGreaterThanOrEqual(1);
      expect(choices.filter((choice) => choice.correct)).toHaveLength(1);
    }
    // Even a word with an unkeyable meaning cannot throw.
    const broken = { ...deck.words[0]!, meaning: "..." };
    expect(() => safeMeaningChoices(deck, broken, "seed")).not.toThrow();
  });
});
