import { describe, expect, it } from "vitest";
import type { DeckId } from "../../src/shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../src/shared/schemas";
import { createReviewDeck } from "../../src/client/data/reviewDeck";
import { generateChoices, generateChoicesLenient, safeMeaningChoices } from "../../src/domain/session/choices";

/** A small source deck: `wordCount` words whose meanings each start with a
 * distinct letter (the deck's own band of the alphabet, so two decks never
 * share distractor initials), keeping pools compact but colliding-free. */
function sourceDeck(id: DeckId, wordCount = 4, fingerprint = `${id}-fp`): RuntimeDeck {
  const letterOffset = (Number(id.at(-1)) - 1) * 6;
  const words: RuntimeWord[] = Array.from({ length: wordCount }, (_, index) => ({
    id: `word-${index}`,
    sourceGuids: [],
    displayHanzi: `字${index}`,
    hanziKey: `zi${index}`,
    displayPinyin: `zì ${index}`,
    acceptedPinyin: [`zi ${index}`],
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
    words, meaningIndex, meaningKeysByPartOfSpeech,
    allMeaningKeys: words.map((word) => word.meaningKey),
  };
}

describe("createReviewDeck distractor pools", () => {
  it("keeps deck.words restricted to the selected keys but merges ALL source meaning pools namespaced", () => {
    const hsk1 = sourceDeck("hsk-1", 4);
    const hsk2 = sourceDeck("hsk-2", 4);
    const decks = new Map<DeckId, RuntimeDeck>([["hsk-1", hsk1], ["hsk-2", hsk2]]);

    const { deck } = createReviewDeck(decks, ["hsk-1:word-0"]);

    // Only the acquired member spawns…
    expect(deck.words.map((word) => word.id)).toEqual(["hsk-1:word-0"]);
    // …but distractors draw from every loaded source deck, namespaced.
    expect(deck.allMeaningKeys).toHaveLength(8);
    for (const deckId of ["hsk-1", "hsk-2"]) {
      for (const meaningKey of hsk1.allMeaningKeys) {
        expect(deck.allMeaningKeys).toContain(`${deckId}:${meaningKey}`);
      }
    }
    expect(deck.meaningIndex["hsk-2:meaning-2"]?.label).toBe(hsk2.meaningIndex["meaning-2"]?.label);
    expect(deck.meaningIndex["hsk-2:meaning-2"]?.hanziKeys).toEqual(["hsk-2:zi2"]);
    expect(deck.meaningKeysByPartOfSpeech["hsk-1:verb"]).toEqual(["hsk-1:meaning-0", "hsk-1:meaning-2"]);
    expect(deck.meaningKeysByPartOfSpeech["hsk-2:verb"]).toEqual(["hsk-2:meaning-0", "hsk-2:meaning-2"]);
    // The member word itself is namespaced consistently with the pools.
    expect(deck.words[0]!.meaningKey).toBe("hsk-1:meaning-0");
    expect(deck.words[0]!.hanziKey).toBe("hsk-1:zi0");
  });

  it("lets a ONE-WORD acquired pool pass full choice generation without throwing", () => {
    const hsk1 = sourceDeck("hsk-1", 6);
    const hsk2 = sourceDeck("hsk-2", 6);
    const decks = new Map<DeckId, RuntimeDeck>([["hsk-1", hsk1], ["hsk-2", hsk2]]);
    const { deck } = createReviewDeck(decks, ["hsk-1:word-0"]);
    const word = deck.words[0]!;

    const choices = generateChoices(deck, word, "seed");
    expect(choices).toHaveLength(8);
    expect(choices.filter((choice) => choice.correct)).toHaveLength(1);
    const keys = choices.flatMap((choice) => choice.shortcuts.map((shortcut) => shortcut.key));
    expect(new Set(keys).size).toBe(keys.length); // unique shortcut keys

    // Same merge also feeds a single-deck map (relearn of one grade): the
    // pool there is smaller, so the LENIENT path supplies the choices.
    const single = createReviewDeck(new Map([["hsk-1", hsk1]]), ["hsk-1:word-1"]).deck;
    const singleChoices = safeMeaningChoices(single, single.words[0]!, "seed");
    expect(singleChoices.length).toBeGreaterThanOrEqual(1);
    expect(singleChoices.some((choice) => choice.correct)).toBe(true);
  });

  it("skips missing words but still merges their source pools", () => {
    const hsk1 = sourceDeck("hsk-1", 3);
    const { deck } = createReviewDeck(new Map([["hsk-1", hsk1]]), ["hsk-1:word-0", "hsk-1:gone"]);
    expect(deck.words.map((word) => word.id)).toEqual(["hsk-1:word-0"]);
    expect(deck.allMeaningKeys).toHaveLength(3);
  });
});

describe("defensive choice generation", () => {
  it("generateChoicesLenient degrades to fewer unique choices, always including correct", () => {
    // Two words whose meanings collide on the same shortcut key: the strict
    // generator throws, the lenient one returns what it can, correct first.
    const tiny = sourceDeck("hsk-1", 2);
    const tinyDeck = createReviewDeck(new Map([["hsk-1", tiny]]), ["hsk-1:word-0"]).deck;
    expect(() => generateChoices(tinyDeck, tinyDeck.words[0]!, "seed")).toThrow(/Not enough meanings/);
    const choices = generateChoicesLenient(tinyDeck, tinyDeck.words[0]!, "seed");
    expect(choices.length).toBeGreaterThanOrEqual(1);
    expect(choices[0]!.correct).toBe(true);
    const keys = choices.flatMap((choice) => choice.shortcuts.map((shortcut) => shortcut.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("safeMeaningChoices NEVER throws and always includes exactly one correct choice", () => {
    const hsk1 = sourceDeck("hsk-1", 5);
    const deck = createReviewDeck(new Map([["hsk-1", hsk1]]), ["hsk-1:word-0"]).deck;
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
