import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { segmentPinyinForms } from "../../tools/import-decks/normalize/pinyin-segments";

describe("authored pinyin segmentation", () => {
  it("aligns one syllable per Han character and keeps authored tones verbatim", () => {
    expect(segmentPinyinForms("学习", "xuéxí")).toEqual([["xué"], ["xí"]]);
    expect(segmentPinyinForms("电脑", "diànnǎo")).toEqual([["diàn"], ["nǎo"]]);
  });

  it("groups / alternatives into one selectable answer per character", () => {
    expect(segmentPinyinForms("谁", "shéi/shuí")).toEqual([["shéi", "shuí"]]);
    expect(segmentPinyinForms("熟", "shú/shóu")).toEqual([["shú", "shóu"]]);
  });

  it("aligns polyphones to the authored reading, never the dictionary's guess", () => {
    // 乐 lè/yuè, 行 xíng/háng, 长 cháng/zhǎng, 了 le/liǎo — pronunciation data
    // only finds boundaries; the authored letters decide.
    expect(segmentPinyinForms("音乐", "yīnyuè")).toEqual([["yīn"], ["yuè"]]);
    expect(segmentPinyinForms("银行", "yínháng")).toEqual([["yín"], ["háng"]]);
    expect(segmentPinyinForms("了解", "liǎojiě")).toEqual([["liǎo"], ["jiě"]]);
  });

  it("preserves tone sandhi exactly as authored", () => {
    // 一 sandhi yī→yí and 不 sandhi bù→bú survive tone-insensitive alignment.
    expect(segmentPinyinForms("一块儿", "yíkuàir")).toEqual([["yí"], ["kuài"], ["r"]]);
    expect(segmentPinyinForms("不客气", "bú kèqi")).toEqual([["bú"], ["kè"], ["qi"]]);
  });

  it("keeps apostrophes and spaces as hard syllable boundaries", () => {
    expect(segmentPinyinForms("女儿", "nǚ’ér")).toEqual([["nǚ"], ["ér"]]);
    expect(segmentPinyinForms("答案", "dá’àn")).toEqual([["dá"], ["àn"]]);
    expect(segmentPinyinForms("十字路口", "shízì lùkǒu")).toEqual([["shí"], ["zì"], ["lù"], ["kǒu"]]);
  });

  it("keeps hyphenated idiom and capitalized authored forms intact", () => {
    expect(segmentPinyinForms("酸甜苦辣", "suān-tián-kǔ-là")).toEqual([["suān"], ["tián"], ["kǔ"], ["là"]]);
    expect(segmentPinyinForms("中华民族", "Zhōnghuá Mínzú")).toEqual([["Zhōng"], ["huá"], ["Mín"], ["zú"]]);
  });

  it("keeps neutral tones toneless as authored", () => {
    expect(segmentPinyinForms("商量", "shāngliang")).toEqual([["shāng"], ["liang"]]);
    expect(segmentPinyinForms("妈妈", "māma")).toEqual([["mā"], ["ma"]]);
  });

  it("splits contracted erhua per Han character, including the bare r", () => {
    expect(segmentPinyinForms("这儿", "zhèr")).toEqual([["zhè"], ["r"]]);
    expect(segmentPinyinForms("一点儿", "yìdiǎnr")).toEqual([["yì"], ["diǎn"], ["r"]]);
    expect(segmentPinyinForms("干活儿", "gànhuór")).toEqual([["gàn"], ["huó"], ["r"]]);
    expect(segmentPinyinForms("模特儿", "mótèr")).toEqual([["mó"], ["tè"], ["r"]]);
    // A standalone 儿 syllable is NOT erhua: 女儿 keeps the full ér.
    expect(segmentPinyinForms("女儿", "nǚ’ér")).toEqual([["nǚ"], ["ér"]]);
  });

  it("falls back to the syllabary when dictionary readings disagree with the author", () => {
    // pinyin-pro reads 膀 as páng; the corpus authors bǎng (翅膀/肩膀).
    expect(segmentPinyinForms("翅膀", "chìbǎng")).toEqual([["chì"], ["bǎng"]]);
    expect(segmentPinyinForms("肩膀", "jiānbǎng")).toEqual([["jiān"], ["bǎng"]]);
  });

  it("fails compilation-grade on unalignable or non-pinyin input", () => {
    expect(() => segmentPinyinForms("你好", "nihaoxx")).toThrow(/cannot be aligned|not a Mandarin syllable/);
    expect(() => segmentPinyinForms("你", "n3")).toThrow(/not pinyin|cannot be aligned/);
    expect(() => segmentPinyinForms("你", "")).toThrow(/blank/);
    expect(() => segmentPinyinForms("", "nǐ")).toThrow(/empty hanzi/);
  });
});

describe("full corpus segmentation (every compiled word)", () => {
  const repositoryRoot = join(__dirname, "..", "..");
  const separators = new Set([" ", "'", "\u2019", "-"]);

  type Card = { hanzi: string; pinyin: string; file: string };
  const cards: Card[] = [];
  for (const grade of readdirSync(join(repositoryRoot, "cards"))) {
    if (!grade.startsWith("hsk-")) continue;
    for (const name of readdirSync(join(repositoryRoot, "cards", grade))) {
      if (!name.endsWith(".acard")) continue;
      const parsed = JSON.parse(readFileSync(join(repositoryRoot, "cards", grade, name), "utf8"));
      cards.push({ hanzi: parsed.hanzi, pinyin: parsed.pinyin, file: `${grade}/${name}` });
    }
  }

  it("segments and reconstructs all 5,398 compiled words", () => {
    expect(cards).toHaveLength(5398);
    for (const card of cards) {
      const segments = segmentPinyinForms(card.hanzi, card.pinyin);
      expect(segments, `${card.file} (${card.hanzi})`).toHaveLength([...card.hanzi].length);
      // First-authored alternative of every character must reconstruct the
      // authored form verbatim (sans separators).
      const firstAlternative = card.pinyin.split("/")[0]!;
      const expected = [...firstAlternative].filter((c) => !separators.has(c)).join("");
      expect(segments.map((group) => group[0]!).join(""), `${card.file} (${card.hanzi} / ${card.pinyin})`).toBe(expected);
    }
  });

  it("covers contracted erhua, grouped alternatives, apostrophes, neutral tones, sandhi, and spaces", () => {
    const TONED = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙ]/;
    let erhua = 0;
    let alternatives = 0;
    let apostrophes = 0;
    let neutral = 0;
    let yiSandhi = false;
    let buSandhi = false;
    let spaces = 0;
    for (const card of cards) {
      const segments = segmentPinyinForms(card.hanzi, card.pinyin);
      if (card.hanzi.endsWith("儿") && segments.at(-1)!.length === 1 && segments.at(-1)![0] === "r") erhua += 1;
      if (card.pinyin.includes("/")) alternatives += 1;
      if (card.pinyin.includes("’") || card.pinyin.includes("'")) apostrophes += 1;
      // A toneless syllable (neutral tone) exists in the corpus.
      if (segments.some((group) => !TONED.test(group[0]!))) neutral += 1;
      if (card.hanzi.startsWith("一") && card.pinyin.startsWith("yí")) yiSandhi = true;
      if (card.hanzi.startsWith("不") && card.pinyin.startsWith("bú")) buSandhi = true;
      if (card.pinyin.includes(" ")) spaces += 1;
    }
    expect(erhua).toBeGreaterThanOrEqual(19);
    expect(alternatives).toBeGreaterThanOrEqual(2);
    expect(apostrophes).toBeGreaterThanOrEqual(37);
    expect(neutral).toBeGreaterThanOrEqual(100);
    expect(yiSandhi).toBe(true);
    expect(buSandhi).toBe(true);
    expect(spaces).toBeGreaterThanOrEqual(28);
  });
});
