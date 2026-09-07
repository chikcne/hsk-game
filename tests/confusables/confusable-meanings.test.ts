import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactJson, buildConfusableGroups } from "../../tools/confusables/generate";
import confusableOverrides from "../../tools/confusables/overrides.json";
import { normalizedKey } from "../../tools/import-decks/normalize/text";

const repositoryRoot = join(__dirname, "..", "..");
const artifactPath = join(repositoryRoot, "src", "shared", "data", "confusable-meanings.json");

type Card = { hanzi: string; meaning: string; level: number };

const cards: Card[] = [];
for (const grade of readdirSync(join(repositoryRoot, "cards")).sort()) {
  if (!grade.startsWith("hsk-")) continue;
  for (const name of readdirSync(join(repositoryRoot, "cards", grade)).sort()) {
    if (!name.endsWith(".acard")) continue;
    const parsed = JSON.parse(readFileSync(join(repositoryRoot, "cards", grade, name), "utf8")) as Card;
    cards.push({ hanzi: parsed.hanzi, meaning: parsed.meaning, level: parsed.level });
  }
}

const corpusKeys = new Set(cards.map((card) => normalizedKey(card.meaning)));
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  schemaVersion: number;
  groups: Array<{ id: string; meaningKeys: string[] }>;
};
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// One rebuild, shared by the shape and staleness tests: the O(corpus²) pair
// scan runs at collection time, outside per-test timeouts.
const regenerated = artifactJson(buildConfusableGroups(cards, confusableOverrides));

describe("confusable-meanings artifact", () => {
  it("matches the fixed runtime contract shape", () => {
    expect(artifact.schemaVersion).toBe(1);
    expect(Array.isArray(artifact.groups)).toBe(true);
    const ids = artifact.groups.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, `group id ${id} must be kebab-case`).toMatch(KEBAB_CASE);
    expect([...ids].sort()).toEqual(ids);
    for (const group of artifact.groups) {
      expect(group.meaningKeys.length, `${group.id} needs at least 2 keys`).toBeGreaterThanOrEqual(2);
      expect(new Set(group.meaningKeys).size).toBe(group.meaningKeys.length);
      expect([...group.meaningKeys].sort()).toEqual(group.meaningKeys);
    }
  });

  it("only references meaning keys that exist in the card corpus", () => {
    const unknown: string[] = [];
    for (const group of artifact.groups) {
      for (const key of group.meaningKeys) {
        if (!corpusKeys.has(key)) unknown.push(`${group.id}: ${key}`);
      }
    }
    expect(unknown, `keys absent from cards/ (as ${normalizedKey.name} of a card meaning):\n  ${unknown.join("\n  ")}`).toEqual([]);
  });

  it("regenerates byte-identically from the corpus and overrides", () => {
    expect(regenerated).toBe(readFileSync(artifactPath, "utf8"));
  });

  it("never emits a group larger than 12 keys (cliques, not connected components)", () => {
    const oversized = artifact.groups.filter((group) => group.meaningKeys.length > 12);
    expect(oversized.map((group) => `${group.id} [${group.meaningKeys.length}]`)).toEqual([]);
  });

  it("is not transitively closed: unrelated class members share no group", () => {
    const sameGroup = (left: string, right: string) =>
      artifact.groups.some((group) => group.meaningKeys.includes(left) && group.meaningKeys.includes(right));
    // Chain-collapse canaries from the union-find era: seem ~ as if ~ if ~
    // only if ~ only merely must NOT put love/if, must/afraid, or
    // only-merely/think in one group.
    expect(sameGroup("to love", "if")).toBe(false);
    expect(sameGroup("must", "to be afraid")).toBe(false);
    expect(sameGroup("only merely", "to think")).toBe(false);
    // according-based-answer chain: answers/bases do not join way/method.
    expect(sameGroup("answer solution", "method")).toBe(false);
    expect(sameGroup("base foundation", "way solution")).toBe(false);
  });

  it("keeps 说 and 说话 out of each other's distractor pools", () => {
    const groupOf = (key: string) => artifact.groups.find((group) => group.meaningKeys.includes(key));
    const speakGroup = groupOf("to speak to say");
    expect(speakGroup).toBeDefined();
    expect(speakGroup!.meaningKeys).toContain("to talk");
    expect(groupOf("to talk")).toBe(speakGroup);
  });

  it("covers the HSK1 modal and motion confusables the heuristics target", () => {
    const sameGroup = (left: string, right: string) =>
      artifact.groups.some((group) => group.meaningKeys.includes(left) && group.meaningKeys.includes(right));
    expect(sameGroup("to go", "to walk")).toBe(true);
    expect(sameGroup("can to be able to", "can be able to")).toBe(true);
    expect(sameGroup("happy glad", "happy")).toBe(true);
    expect(sameGroup("to look after to watch", "to see")).toBe(true);
    expect(sameGroup("to know", "to understand")).toBe(true);
  });

  it("groups at most the corpus' meaning keys, never inventing pairs of one", () => {
    const grouped = new Set(artifact.groups.flatMap((group) => group.meaningKeys));
    expect(grouped.size).toBeLessThanOrEqual(corpusKeys.size);
    for (const key of grouped) expect(corpusKeys.has(key)).toBe(true);
  });
});
