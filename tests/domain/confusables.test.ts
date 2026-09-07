import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { areConfusableMeanings, indexConfusableGroups } from "../../src/domain/session/confusables";
import { generateChoices, generateChoicesEffect, generateChoicesLenient, type MeaningChoice } from "../../src/domain/session/choices";
import { createReviewDeck } from "../../src/client/data/reviewDeck";
import { curriculumFromWordIds } from "../../src/domain/learning";
import shippedConfusables from "../../src/shared/data/confusable-meanings.json";
import type { DeckId } from "../../src/shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../src/shared/schemas";

/** The 说 regression case from designs/confusable_distractors.md: 说话 "to talk"
 * is a near-synonym of 说's answer "to speak, to say" and useless as a
 * discrimination test. The group here is synthetic — the shipped artifact's
 * contents belong to the data pipeline and must never be assumed by a test. */
const VOCABULARY = [
  { hanzi: "说", meaning: "to speak, to say", meaningKey: "to speak to say" },
  { hanzi: "说话", meaning: "to talk", meaningKey: "to talk" },
  { hanzi: "吃", meaning: "to eat", meaningKey: "to eat" },
  { hanzi: "喝", meaning: "to drink", meaningKey: "to drink" },
  { hanzi: "水", meaning: "water", meaningKey: "water" },
  { hanzi: "火", meaning: "fire", meaningKey: "fire" },
  { hanzi: "人", meaning: "person", meaningKey: "person" },
  { hanzi: "书", meaning: "book", meaningKey: "book" },
  { hanzi: "车", meaning: "car", meaningKey: "car" },
  { hanzi: "房子", meaning: "house", meaningKey: "house" },
] as const;
const SPEAK_GROUP = { id: "speak-say-talk", meaningKeys: ["to speak to say", "to talk"] };
const FILLER_KEYS = ["to eat", "to drink", "water", "fire", "person", "book", "car", "house"];
const labels = (choices: MeaningChoice[]) => choices.map((choice) => choice.label);

function fixtureDeck(excludedMeaningKeys: readonly string[] = []): RuntimeDeck {
  const words: RuntimeWord[] = VOCABULARY
    .filter((entry) => !excludedMeaningKeys.includes(entry.meaningKey))
    .map((entry, index) => ({
      id: `word-${index}`, sourceGuids: [], displayHanzi: entry.hanzi, hanziKey: entry.hanzi,
      displayPinyin: `pinyin ${index}`, acceptedPinyin: [`pinyin ${index}`], pinyinSegments: [[`pinyin ${index}`]],
      partOfSpeech: null, partOfSpeechKey: null, senseLabel: null,
      meaning: entry.meaning, meaningKey: entry.meaningKey, audioUrl: "",
    }));
  const meaningIndex = Object.fromEntries(words.map((word) => [word.meaningKey, {
    label: word.meaning, wordIds: [word.id], hanziKeys: [word.hanziKey], partOfSpeechKeys: [],
  }]));
  return {
    schemaVersion: 1, importerVersion: "test", id: "hsk-1" as DeckId, hskLevel: 1, title: "confusable fixture",
    fingerprint: "confusable-fixture", source: { sharedId: 0, url: "test", packageSha256: "confusable-fixture", sourceNoteCount: words.length, logicalWordCount: words.length },
    curriculum: curriculumFromWordIds(words.map((word) => word.id)),
    words, meaningIndex, meaningKeysByPartOfSpeech: {}, allMeaningKeys: words.map((word) => word.meaningKey),
  };
}

const plentiful = fixtureDeck();
const starvedStrict = fixtureDeck(["house", "car"]);        // 6 fillers: only the confusable tier completes the round
const starvedLenient = fixtureDeck(["house", "book", "car"]); // 5 fillers: even tier 3 cannot reach eight
const answer = plentiful.words[0]!;
const seeds = ["enemy-1", "enemy-2", "enemy-3", "enemy-4", "enemy-5", "enemy-6"];

// Every test installs the artifact state it assumes, so none depends on what the
// data pipeline has shipped into confusable-meanings.json at the time it runs.
afterEach(() => indexConfusableGroups(shippedConfusables));

describe("areConfusableMeanings", () => {
  beforeEach(() => indexConfusableGroups({ schemaVersion: 1, groups: [SPEAK_GROUP, { id: "multi", meaningKeys: ["water", "fire", "to talk"] }] }));

  it("is true exactly for two keys sharing a group, in either argument order", () => {
    expect(areConfusableMeanings("to speak to say", "to talk")).toBe(true);
    expect(areConfusableMeanings("to talk", "to speak to say")).toBe(true);
    expect(areConfusableMeanings("water", "fire")).toBe(true);
    expect(areConfusableMeanings("to speak to say", "water")).toBe(false);
  });

  it("follows a key through several groups", () => {
    expect(areConfusableMeanings("to eat", "to talk")).toBe(false);
    expect(areConfusableMeanings("to talk", "water")).toBe(true);
  });

  it("is false for unknown keys or a key against itself", () => {
    expect(areConfusableMeanings("to speak to say", "to say")).toBe(false);
    expect(areConfusableMeanings("to speak to say", "to speak to say")).toBe(false);
  });

  it("matches the grade-namespaced spelling Review Mode's merged deck uses", () => {
    expect(areConfusableMeanings("hsk-1:to speak to say", "hsk-1:to talk")).toBe(true);
    expect(areConfusableMeanings("hsk-3:to speak to say", "hsk-5:to talk")).toBe(true);
    expect(areConfusableMeanings("hsk-1:to speak to say", "to eat")).toBe(false);
  });

  it("reads nothing out of a malformed artifact", () => {
    const garbage = [
      null, "nope", {}, { schemaVersion: 1 }, { schemaVersion: 2, groups: [SPEAK_GROUP] },
      { schemaVersion: 1, groups: "speak" }, { schemaVersion: 1, groups: [null, {}] },
      { schemaVersion: 1, groups: [{ id: "g", meaningKeys: "to talk" }] },
      { schemaVersion: 1, groups: [{ id: "g", meaningKeys: ["to speak to say", 42] }] },
    ];
    for (const artifact of garbage) {
      indexConfusableGroups(artifact);
      expect(areConfusableMeanings("to speak to say", "to talk"), JSON.stringify(artifact)).toBe(false);
    }
  });
});

describe("generateChoices confusable tiering", () => {
  beforeEach(() => indexConfusableGroups({ schemaVersion: 1, groups: [SPEAK_GROUP] }));

  it("leaves the output byte-identical under an empty artifact (golden captured pre-change)", () => {
    indexConfusableGroups({ schemaVersion: 1, groups: [] });
    expect(labels(generateChoices(plentiful, answer, "enemy-1")))
      .toEqual(["book", "to talk", "house", "fire", "to drink", "person", "car", "to speak, to say"]);
    expect(labels(generateChoicesLenient(starvedLenient, answer, "enemy-1")))
      .toEqual(["to speak, to say", "to talk", "to eat", "to drink", "water", "fire", "person"]);
  });

  it("never shows the confusable while eight non-confusable slots exist", () => {
    for (const seed of seeds) {
      const choices = generateChoices(plentiful, answer, seed);
      expect(labels(choices), seed).not.toContain("to talk");
      expect(choices, seed).toHaveLength(8);
      expect(choices.filter((choice) => choice.correct), seed).toHaveLength(1);
      expect(new Set(choices.map((choice) => choice.label)).size, seed).toBe(8);
      for (const choice of choices.filter((choice) => !choice.correct)) {
        expect(FILLER_KEYS, seed).toContain(choice.label);
      }
    }
  });

  it("still fills from the confusable tier when the pool starves", () => {
    for (const seed of seeds) {
      const choices = generateChoices(starvedStrict, answer, seed);
      expect(choices, seed).toHaveLength(8);
      expect(labels(choices), seed).toContain("to talk");
      expect(choices.filter((choice) => choice.correct), seed).toHaveLength(1);
    }
  });

  it("appends confusables last on the lenient degrade path, without dropping them", () => {
    // Genuinely starved: even the confusable tier cannot reach eight, so the
    // strict contract fails and lenient's catch-all is what runs.
    expect(() => generateChoices(starvedLenient, answer, "enemy-1")).toThrow(/Not enough meanings/);
    expect(labels(generateChoicesLenient(starvedLenient, answer, "enemy-1")))
      .toEqual(["to speak, to say", "to eat", "to drink", "water", "fire", "person", "to talk"]);
  });

  it("is deterministic for a fixed seed and agrees between the Effect and sync paths", () => {
    const first = generateChoices(plentiful, answer, "enemy-2");
    expect(generateChoices(plentiful, answer, "enemy-2")).toEqual(first);
    expect(Effect.runSync(generateChoicesEffect(plentiful, answer, "enemy-2"))).toEqual(first);
  });

  it("demotes through the grade-namespaced keys of a merged Review Mode deck", () => {
    const { deck: merged } = createReviewDeck(new Map<DeckId, RuntimeDeck>([["hsk-1", plentiful]]), ["hsk-1:word-0"]);
    expect(merged.words[0]!.meaningKey).toBe("hsk-1:to speak to say");
    for (const seed of seeds) {
      const choices = generateChoices(merged, merged.words[0]!, seed);
      expect(labels(choices), seed).not.toContain("to talk");
      expect(choices, seed).toHaveLength(8);
    }
  });
});
