import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stableJson } from "../../tools/import-decks/compile/stable-json";
import { orderedJson } from "../../tools/sort-curriculum/ordered-json";
import { generateCurriculum } from "../../tools/sort-curriculum/generator";

const root = resolve(import.meta.dirname, "../..");

describe("keyed insertion-ordered curriculum", () => {
  it("reproduces the committed manifest byte-for-byte with 5396 unique entries", async () => {
    const generated = await generateCurriculum(root);
    const committed = await readFile(resolve(root, "cards/curriculum.json"), "utf8");
    // Key insertion order is the curriculum order, so the committed file must
    // round-trip through the order-preserving serializer, not stableJson.
    expect(orderedJson(generated.manifest)).toBe(committed);
    expect(committed).not.toBe(stableJson(generated.manifest));
    const ids = Object.keys(generated.manifest);
    expect(ids).toHaveLength(5396);
    // The committed lock pins the exact manifest text.
    const lock = await readFile(resolve(root, "cards/curriculum.lock.json"), "utf8");
    expect(lock).toBe(stableJson(generated.lock));
  });

  it("keys every entry by its source card's id, hanzi, and effective grade", async () => {
    const { manifest, cards } = await generateCurriculum(root);
    const byFile = new Map(cards.map((item) => [item.relative, item.card]));
    for (const [id, entry] of Object.entries(manifest)) {
      const card = byFile.get(entry.file);
      expect(card, entry.file).toBeDefined();
      expect(card!.id).toBe(id);
      expect(card!.hanzi).toBe(entry.hanzi);
      expect(card!.curriculum.grade).toBe(entry.hskLevel);
      expect(card!.curriculum.grade).toBeLessThanOrEqual(card!.level);
    }
  });

  it("collapses the cross-grade duplicate semantic IDs to their earliest copies", async () => {
    const { manifest } = await generateCurriculum(root);
    const filesById = new Map<string, string[]>();
    for (let grade = 1; grade <= 6; grade += 1) {
      const directory = join(root, "cards", `hsk-${grade}`);
      for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".acard")).sort()) {
        const card = JSON.parse(await readFile(join(directory, filename), "utf8")) as { id: string };
        filesById.set(card.id, [...(filesById.get(card.id) ?? []), `hsk-${grade}/${filename}`]);
      }
    }
    expect(filesById.size).toBe(5396);
    expect(Object.keys(manifest)).toHaveLength(5396);
    const referenced = new Set(Object.values(manifest).map((entry) => entry.file));
    const duplicated = [...filesById.values()].filter((files) => files.length > 1);
    expect(duplicated).toHaveLength(2);
    // First-wins: the kept entry is the earliest copy and the later file is
    // referenced nowhere in the manifest.
    for (const files of duplicated) {
      const kept = files.find((file) => referenced.has(file))!;
      expect(files.indexOf(kept)).toBe(0);
      expect(referenced).not.toContain(files[1]!);
    }
    expect(Object.values(manifest).find((entry) => entry.hanzi === "看")!.file).toBe("hsk-1/看.acard");
    expect(Object.values(manifest).find((entry) => entry.hanzi === "结果")!.file).toBe("hsk-4/结果.acard");
  });

  it("emits contiguous ascending effective grades after prerequisite hoisting", async () => {
    const { manifest } = await generateCurriculum(root);
    const levels = Object.values(manifest).map((entry) => entry.hskLevel);
    const sorted = [...levels].sort((left, right) => left - right);
    expect(levels).toEqual(sorted);
    const counts = new Map<number, number>();
    for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
    // The later 看 and 结果 duplicate copies are dropped from HSK 5 and 6.
    expect([...counts.entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, 352], [2, 210], [3, 567], [4, 1028], [5, 1533], [6, 1706],
    ]);
  });

  it("puts every prerequisite at a strictly earlier curriculum position", async () => {
    const { manifest } = await generateCurriculum(root);
    const positionById = new Map(Object.keys(manifest).map((id, index) => [id, index] as const));
    for (const [id, entry] of Object.entries(manifest)) {
      for (const prerequisiteId of entry.prerequisiteIds) {
        expect(positionById.has(prerequisiteId), `${entry.file} depends on ${prerequisiteId}`).toBe(true);
        expect(positionById.get(prerequisiteId)!, `${entry.file} depends on ${prerequisiteId}`).toBeLessThan(positionById.get(id)!);
      }
    }
  });

  it("enforces the representative character and nested-word chains", async () => {
    const { manifest, cards } = await generateCurriculum(root);
    const positionByHanzi = new Map<string, number>();
    for (const [index, entry] of Object.values(manifest).entries()) {
      if (!positionByHanzi.has(entry.hanzi)) positionByHanzi.set(entry.hanzi, index);
    }
    expect(positionByHanzi.get("你")).toBeLessThan(positionByHanzi.get("你好")!);
    expect(positionByHanzi.get("好")).toBeLessThan(positionByHanzi.get("你好")!);
    expect(positionByHanzi.get("你好")).toBeLessThan(positionByHanzi.get("电影")!);
    expect(positionByHanzi.get("电")).toBeLessThan(positionByHanzi.get("电影")!);
    expect(positionByHanzi.get("电影")).toBeLessThan(positionByHanzi.get("电影院")!);
    expect(positionByHanzi.get("们")).toBeLessThan(positionByHanzi.get("我们")!);
    expect(positionByHanzi.get("的")).toBeGreaterThanOrEqual(4);

    // A nested later-grade chain is hoisted all the way into the grade-1 prefix.
    expect(positionByHanzi.get("关")).toBeLessThan(positionByHanzi.get("关系")!);
    expect(positionByHanzi.get("系")).toBeLessThan(positionByHanzi.get("关系")!);
    expect(positionByHanzi.get("关系")).toBeLessThan(positionByHanzi.get("没关系")!);
    for (const hanzi of ["关", "系", "关系"]) {
      const source = cards.find((item) => item.card.hanzi === hanzi && item.card.curriculum.grade === 1)!;
      expect(source.card.level).toBeGreaterThan(1);
      expect(manifest[source.card.id]!.hskLevel).toBe(1);
    }

    // 儿 has no standalone source card, so 一点儿 is schedulable whole for
    // that component while its available 一 and 点 prerequisites still apply.
    expect(cards.some((item) => item.card.hanzi === "儿")).toBe(false);
    expect(positionByHanzi.has("一点儿")).toBe(true);

    const nihaoId = Object.keys(manifest).find((id) => manifest[id]!.hanzi === "你好")!;
    const prerequisites = manifest[nihaoId]!.prerequisiteIds.map((id) => cards.find((item) => item.card.id === id)!.card);
    expect(prerequisites.find((card) => card.hanzi === "好")?.pinyin).toBe("hǎo");
    expect(prerequisites.some((card) => card.hanzi === "好" && card.pinyin === "hào")).toBe(false);
  });
});
