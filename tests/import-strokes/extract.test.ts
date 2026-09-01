import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DECK_IDS } from "../../src/shared/constants";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import {
  applyStrokeOrderOverride,
  readRequiredGraphics,
  validateCharacterData,
  validateSvgPath,
} from "../../tools/import-strokes/extract";
import type { StrokeBundle, StrokeBundleManifest, StrokeCharacterData } from "../../tools/import-strokes/types";

const simple: StrokeCharacterData = {
  strokes: ["M 0 0 L 10.5 10 Z", "M 2 3 Q 4 5 6 7 Z"],
  medians: [[[0, 0], [10.5, 10]], [[2, 3], [6, 7]]],
};

describe("stroke data extraction", () => {
  test("validates paths, fractional medians, and matching stroke counts", () => {
    expect(() => validateSvgPath(simple.strokes[0])).not.toThrow();
    expect(validateCharacterData(simple, "字")).toEqual(simple);
    expect(() => validateSvgPath("M 0 Z", "bad stroke")).toThrow(/invalid parameters/);
    expect(() => validateSvgPath("M 0 0 X 2 3", "bad stroke")).toThrow(/unsupported SVG command/);
    expect(() => validateCharacterData({ strokes: ["M 0 0 Z"], medians: [] }, "字")).toThrow(/counts differ/);
  });

  test("applies only complete stroke-order permutations", () => {
    const corrected = applyStrokeOrderOverride("字", simple, { issue: "test", note: "swap", strokeOrder: [1, 0] });
    expect(corrected.strokes).toEqual([simple.strokes[1], simple.strokes[0]]);
    expect(corrected.medians).toEqual([simple.medians[1], simple.medians[0]]);
    expect(() => applyStrokeOrderOverride("字", simple, { issue: "test", note: "bad", strokeOrder: [0, 0] })).toThrow(/permutation/);
  });

  test("streams selected entries, reports overrides, and blocks missing Hanzi", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stroke-extract-"));
    const graphics = path.join(directory, "graphics.txt");
    await writeFile(graphics, `${JSON.stringify({ character: "字", ...simple })}\n${JSON.stringify({ character: "外", ...simple })}\n`);
    try {
      const selected = await readRequiredGraphics(graphics, new Set(["字"]), {
        字: { issue: "https://example.test/1", note: "reviewed", strokeOrder: [1, 0] },
      });
      expect([...selected.characters]).toEqual([["字", {
        strokes: [simple.strokes[1], simple.strokes[0]],
        medians: [simple.medians[1], simple.medians[0]],
      }]]);
      expect(selected.appliedOverrides).toHaveLength(1);
      await expect(readRequiredGraphics(graphics, new Set(["缺"]), {})).rejects.toThrow(/Missing Make Me a Hanzi data/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("committed bundles match their manifest checksums, remain sorted, and cover bundled words", async () => {
    const directory = path.resolve("public/stroke-data");
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as StrokeBundleManifest;
    expect(manifest.uniqueCharacterCount).toBe(1940);
    expect(manifest.appliedOverrides.map((item) => item.character)).toEqual(["滚", "肠"]);

    for (const id of DECK_IDS) {
      const content = await readFile(path.join(directory, `${id}.json`), "utf8");
      const bundle = JSON.parse(content) as StrokeBundle;
      const metadata = manifest.bundles[id];
      expect(Buffer.byteLength(content)).toBe(metadata.bytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(metadata.sha256);
      const characters = Object.keys(bundle.characters);
      expect(characters).toEqual([...characters].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!));
      expect(characters).toHaveLength(metadata.characterCount);
      for (const [character, data] of Object.entries(bundle.characters)) validateCharacterData(data, character);

      const required = new Set(createDemoDeck(id).words.flatMap((word) => [...word.displayHanzi]));
      const deckPath = path.resolve("public/game-data", id, "deck.json");
      if (existsSync(deckPath)) {
        const deck = JSON.parse(await readFile(deckPath, "utf8")) as { words: Array<{ displayHanzi: string }> };
        for (const word of deck.words) for (const character of word.displayHanzi) required.add(character);
      }
      expect([...required].filter((character) => !bundle.characters[character])).toEqual([]);
    }
  });
});
