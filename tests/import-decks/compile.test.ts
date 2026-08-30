import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeDeckSchema } from "../../src/shared/schemas";
import { parseMediaMap } from "../../tools/import-decks/archive/media";
import { compileDecks } from "../../tools/import-decks/compile/compiler";
import { stableJson } from "../../tools/import-decks/compile/stable-json";
import { buildMeaningIndexes, normalizeAndDedupe } from "../../tools/import-decks/normalize/words";
import type { RawNote } from "../../tools/import-decks/raw-types";

const entries = [
  ["一", "yī", "one"], ["二", "èr", "two"], ["三", "sān", "three"],
  ["四", "sì", "four"], ["五", "wǔ", "five"], ["六", "liù", "six"],
  ["七", "qī", "seven"], ["八", "bā", "eight"], ["九", "jiǔ", "nine"],
] as const;

function note(id: number, guid: string, hanzi: string, pinyin: string, meaning: string): RawNote {
  return {
    id, guid, modelId: 1,
    fields: {
      hanzi, pinyin, partOfSpeech: "<b>number</b>", meaning,
      sentenceHanzi: `${hanzi}个`, sentencePinyin: `${pinyin} ge`, sentenceMeaning: `${meaning} item`,
      audioHanzi: `[sound:${guid}.mp3]`, audioSentence: "", image: "",
    },
  };
}

function fixture() {
  const notes = entries.map(([hanzi, pinyin, meaning], index) => note(index + 1, `g${index + 1}`, hanzi, pinyin, meaning));
  notes.push(note(99, "duplicate-guid", "一", "yī", "one"));
  const mediaValue: Record<string, string> = {};
  notes.forEach((item, index) => { mediaValue[String(index)] = `${item.guid}.mp3`; });
  return { notes, media: parseMediaMap(mediaValue) };
}

describe("runtime deck compilation primitives", () => {
  it("uses semantic hashes, merges only exact duplicates, and builds safe sorted indexes", () => {
    const { notes, media } = fixture();
    const result = normalizeAndDedupe(notes, media, {});
    expect(result.words).toHaveLength(9);
    const one = result.words.find((word) => word.displayHanzi === "一")!;
    const expectedId = createHash("sha256").update("word-v1\0一\0yī\0one").digest("hex").slice(0, 24);
    expect(one.id).toBe(expectedId);
    expect(one.sourceGuids).toEqual(["duplicate-guid", "g1"]);
    expect(one.audioFilename).toBe("g1.mp3");
    expect(result.audit.exactDuplicateGroups).toEqual([{ wordId: expectedId, sourceGuids: ["duplicate-guid", "g1"] }]);

    const runtimeWords = result.words.map(({ audioFilename: _audio, sourceNoteId: _source, ...word }) => ({ ...word, audioUrl: `audio/${word.id}.mp3` }));
    const indexes = buildMeaningIndexes(runtimeWords);
    expect(indexes.allMeaningKeys).toEqual([...indexes.allMeaningKeys].sort());
    expect(indexes.minimumSafeDistractors).toBe(8);
    expect(indexes.meaningIndex.one).toMatchObject({ label: "one", wordIds: [expectedId], hanziKeys: ["一"] });
    expect(indexes.meaningKeysByPartOfSpeech.number).toHaveLength(9);

    expect(() => RuntimeDeckSchema.parse({
      schemaVersion: 1, importerVersion: "test", id: "hsk-1", hskLevel: 1, title: "fixture", fingerprint: "f",
      source: { sharedId: 1, url: "https://example.test", packageSha256: "a".repeat(64), sourceNoteCount: 10, logicalWordCount: 9 },
      words: runtimeWords, meaningIndex: indexes.meaningIndex,
      meaningKeysByPartOfSpeech: indexes.meaningKeysByPartOfSpeech, allMeaningKeys: indexes.allMeaningKeys,
    })).not.toThrow();
  });

  it("blocks a deck without seven safe distractors", () => {
    const { notes, media } = fixture();
    const words = normalizeAndDedupe(notes.slice(0, 7), media, {}).words;
    expect(() => buildMeaningIndexes(words)).toThrow(/only 6 safe meaning distractors/u);
  });

  it("serializes object keys deterministically without changing array order", () => {
    expect(stableJson({ z: 1, a: { y: 2, b: 3 }, list: ["z", "a"] }))
      .toBe('{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "list": [\n    "z",\n    "a"\n  ],\n  "z": 1\n}\n');
  });

  it("leaves prior generated data untouched when an import is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "hsk-compile-reject-"));
    const output = join(root, "public/game-data");
    try {
      await mkdir(join(root, "decks"), { recursive: true });
      await mkdir(join(root, "tools/import-decks"), { recursive: true });
      await mkdir(output, { recursive: true });
      await writeFile(join(root, "decks/SHA256SUMS"), `${"0".repeat(64)}  hsk-1-1623336797.apkg\n`);
      await writeFile(join(root, "tools/import-decks/overrides.json"), "{}\n");
      await writeFile(join(output, "prior-marker"), "keep me");
      await expect(compileDecks({ repositoryRoot: root, outputDirectory: output, deckIds: ["hsk-1"] })).rejects.toThrow();
      expect(await readFile(join(output, "prior-marker"), "utf8")).toBe("keep me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
