import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DECK_TOTALS } from "../../src/shared/constants";
import { stableJson } from "../../tools/import-decks/compile/stable-json";
import { generateCurriculum } from "../../tools/sort-curriculum/generator";

const root = resolve(import.meta.dirname, "../..");

describe("frequency-led prerequisite curriculum", () => {
  it("reproduces the committed manifest and covers every card once", async () => {
    const generated = await generateCurriculum(root);
    const committed = await readFile(resolve(root, "cards/curriculum.json"), "utf8");
    expect(stableJson(generated.manifest)).toBe(committed);
    const cards = generated.manifest.levels.flatMap((level) => level.lessons.flatMap((lesson) => lesson.cards));
    expect(cards).toHaveLength(5398);
    expect(new Set(cards.map((card) => card.file)).size).toBe(5398);
    for (const level of generated.manifest.levels) {
      expect(level.cardCount).toBe(DECK_TOTALS[level.deckId as keyof typeof DECK_TOTALS]);
      expect(level.lessons.every((lesson) => lesson.cards.length <= 20)).toBe(true);
    }
  });

  it("puts every same-grade prerequisite in an earlier lesson", async () => {
    const { manifest } = await generateCurriculum(root);
    const gradeById = new Map<string, number>();
    const lessonById = new Map<string, number>();
    for (const level of manifest.levels) for (const [lessonIndex, lesson] of level.lessons.entries()) for (const card of lesson.cards) {
      // Cross-grade duplicate semantic IDs deliberately use the earlier copy.
      if (!gradeById.has(card.id)) gradeById.set(card.id, level.hskLevel);
      if (!lessonById.has(card.id)) lessonById.set(card.id, lessonIndex);
    }
    for (const level of manifest.levels) for (const [lessonIndex, lesson] of level.lessons.entries()) for (const card of lesson.cards) {
      for (const prerequisiteId of card.prerequisiteIds) {
        const prerequisiteGrade = gradeById.get(prerequisiteId);
        expect(prerequisiteGrade).toBeLessThanOrEqual(level.hskLevel);
        if (prerequisiteGrade === level.hskLevel) expect(lessonById.get(prerequisiteId)).toBeLessThan(lessonIndex);
      }
    }
  });

  it("enforces the representative character and nested-word chains", async () => {
    const { manifest, cards } = await generateCurriculum(root);
    const hsk1 = manifest.levels.find((level) => level.deckId === "hsk-1")!;
    const positions = new Map(hsk1.lessons.flatMap((lesson, lessonIndex) => lesson.cards.map((card) => [card.hanzi, lessonIndex] as const)));
    expect(positions.get("你")).toBeLessThan(positions.get("你好")!);
    expect(positions.get("好")).toBeLessThan(positions.get("你好")!);
    expect(positions.get("你好")).toBeLessThan(positions.get("电影")!);
    expect(positions.get("电")).toBeLessThan(positions.get("电影")!);
    expect(positions.get("电影")).toBeLessThan(positions.get("电影院")!);
    expect(positions.get("们")).toBeLessThan(positions.get("我们")!);
    expect(positions.get("的")).toBeGreaterThanOrEqual(4);

    // A nested later-grade chain is hoisted all the way to HSK 1.
    expect(positions.get("关")).toBeLessThan(positions.get("关系")!);
    expect(positions.get("系")).toBeLessThan(positions.get("关系")!);
    expect(positions.get("关系")).toBeLessThan(positions.get("没关系")!);
    for (const hanzi of ["关", "系", "关系"]) {
      const source = cards.find((item) => item.card.hanzi === hanzi && item.card.curriculum.grade === 1)!;
      expect(source.card.level).toBeGreaterThan(1);
    }

    // 儿 has no standalone source card, so 一点儿 is schedulable whole for
    // that component while its available 一 and 点 prerequisites still apply.
    expect(cards.some((item) => item.card.hanzi === "儿")).toBe(false);
    expect(positions.has("一点儿")).toBe(true);

    const nihao = hsk1.lessons.flatMap((lesson) => lesson.cards).find((card) => card.hanzi === "你好")!;
    const prerequisites = nihao.prerequisiteIds.map((id) => cards.find((item) => item.card.id === id)!.card);
    expect(prerequisites.find((card) => card.hanzi === "好")?.pinyin).toBe("hǎo");
    expect(prerequisites.some((card) => card.hanzi === "好" && card.pinyin === "hào")).toBe(false);
  });
});
