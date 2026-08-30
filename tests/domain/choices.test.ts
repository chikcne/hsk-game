import { describe, expect, it } from "vitest";
import { choiceShortcutForLabel, choiceShortcutsForLabel, generateChoices } from "../../src/domain/session/choices";
import { createDemoDeck } from "../../src/client/data/demoDeck";

describe("meaning choices", () => {
  it("uses the operative word after grammatical scaffolding", () => {
    expect(choiceShortcutForLabel("to drink")).toEqual({ key: "D", index: 3 });
    expect(choiceShortcutForLabel("to get sick")).toEqual({ key: "S", index: 7 });
    expect(choiceShortcutForLabel("to be afraid")).toEqual({ key: "A", index: 6 });
    expect(choiceShortcutForLabel("to make a phone call")).toEqual({ key: "P", index: 10 });
    expect(choiceShortcutForLabel("to keep warm")).toEqual({ key: "W", index: 8 });
    expect(choiceShortcutForLabel("to fall in love")).toEqual({ key: "L", index: 11 });
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
});
