import { describe, expect, it } from "vitest";
import type { RuntimeWord } from "../../src/shared/schemas";
import {
  buildPinyinLabelPool,
  generatePinyinChoices,
  PINYIN_CHOICE_COUNT,
  PINYIN_PLAN_DISTRACTORS,
} from "../../src/domain/session/pinyin-choices";

function word(id: string, segments: string[][]): RuntimeWord {
  return {
    id,
    sourceGuids: [],
    displayHanzi: segments.map((group) => "字").join(""),
    hanziKey: id,
    displayPinyin: segments.map((group) => group[0]!).join(""),
    acceptedPinyin: [segments.map((group) => group[0]!).join("")],
    pinyinSegments: segments,
    partOfSpeech: null,
    partOfSpeechKey: null,
    senseLabel: null,
    meaning: id,
    meaningKey: id,
    audioUrl: "",
  };
}

/** Target 上学, plan words 上学+learning words, outside corpus words. The
 * label alphabets are disjoint so provenance is assertable by membership. */
const target = word("target", [["shàng"], ["xué"]]);
const planWords = [
  target,
  word("plan-1", [["nǐ"], ["hǎo"]]),
  word("plan-2", [["diàn"], ["nǎo"]]),
  word("plan-3", [["lǎo"], ["shī"]]),
  word("plan-4", [["péng"], ["you"]]),
  word("plan-5", [["shuǐ"]]),
  // Repeats count as ONE source word: the pool stays deduplicated.
  word("plan-1", [["nǐ"], ["hǎo"]]),
];
const outsideWords = [
  word("out-1", [["mā"], ["ma"]]),
  word("out-2", [["zhè"], ["r"]]),
  word("out-3", [["shéi", "shuí"]]),
  word("out-4", [["gōng"], ["zuò"]]),
  word("out-5", [["xǐ"], ["huan"]]),
];
const pools = () => ({
  planPool: buildPinyinLabelPool(planWords, target.id),
  outsidePool: buildPinyinLabelPool(outsideWords),
});

const PLAN_LABELS = ["nǐ", "hǎo", "diàn", "nǎo", "lǎo", "shī", "péng", "you", "shuǐ"];
const OUTSIDE_LABELS = ["mā", "ma", "zhè", "r", "shéi / shuí", "gōng", "zuò", "xǐ", "huan"];

describe("generatePinyinChoices", () => {
  it("returns exactly 8 unique labels containing the correct one once", () => {
    const { labels, correct } = generatePinyinChoices(target, 0, pools(), "e-1:0");
    expect(labels).toHaveLength(PINYIN_CHOICE_COUNT);
    expect(new Set(labels).size).toBe(labels.length);
    expect(correct).toBe("shàng");
    expect(labels.filter((label) => label === correct)).toHaveLength(1);
  });

  it("draws 4 distractors from plan words and 3 from outside the plan", () => {
    const { labels, correct } = generatePinyinChoices(target, 0, pools(), "e-1:0");
    const distractors = labels.filter((label) => label !== correct);
    expect(distractors).toHaveLength(7);
    const fromPlan = distractors.filter((label) => PLAN_LABELS.includes(label));
    const fromOutside = distractors.filter((label) => OUTSIDE_LABELS.includes(label));
    expect(fromPlan).toHaveLength(PINYIN_PLAN_DISTRACTORS);
    expect(fromOutside).toHaveLength(3);
  });

  it("excludes the correct label's alternatives and the target word's own syllables", () => {
    // The target's second syllable 学/xué must never appear for character 0.
    const { labels } = generatePinyinChoices(target, 0, pools(), "e-1:0");
    expect(labels).not.toContain("xué");
    // Alternative readings stay grouped into one correct button, and neither
    // reading may also appear as a distractor.
    const who = word("who", [["shéi", "shuí"]]);
    const whoPools = {
      planPool: buildPinyinLabelPool([who, ...outsideWords], who.id),
      outsidePool: buildPinyinLabelPool(planWords, target.id),
    };
    const { labels: whoLabels, correct } = generatePinyinChoices(who, 0, whoPools, "e-2:0");
    expect(correct).toBe("shéi / shuí");
    expect(whoLabels).not.toContain("shuí");
    expect(whoLabels).not.toContain("shéi");
    expect(whoLabels.filter((label) => label === "shéi / shuí")).toHaveLength(1);
    expect(whoLabels.filter((label) => label !== "shéi / shuí")).toHaveLength(7);
  });

  it("is deterministic per seed and regenerates fresh positions per character", () => {
    const first = generatePinyinChoices(target, 0, pools(), "e-1:0");
    expect(generatePinyinChoices(target, 0, pools(), "e-1:0")).toEqual(first);
    // Same enemy, next character: a fresh draw (different seed, different
    // correct label) that still satisfies the contract.
    const second = generatePinyinChoices(target, 1, pools(), "e-1:1");
    expect(second.correct).toBe("xué");
    expect(second.labels).toHaveLength(8);
    expect(new Set(second.labels).size).toBe(8);
    // Different enemies never share a fixed layout.
    const otherEnemy = generatePinyinChoices(target, 0, pools(), "e-9:0");
    expect(otherEnemy.labels.join("|")).not.toBe(first.labels.join("|"));
  });

  it("backfills from outside when the plan pool cannot supply 4 unique labels", () => {
    const scarce = {
      planPool: buildPinyinLabelPool([planWords[1]!], target.id), // only nǐ/hǎo
      outsidePool: buildPinyinLabelPool(outsideWords),
    };
    const { labels, correct } = generatePinyinChoices(target, 0, scarce, "e-1:0");
    expect(correct).toBe("shàng");
    expect(labels).toHaveLength(8);
    const distractors = labels.filter((label) => label !== correct);
    expect(distractors.filter((label) => PLAN_LABELS.includes(label))).toHaveLength(2);
    expect(distractors.filter((label) => OUTSIDE_LABELS.includes(label))).toHaveLength(5);
  });

  it("degrades safely for pathological pools while always including the correct label", () => {
    const empty = { planPool: [], outsidePool: [] };
    const only = generatePinyinChoices(target, 0, empty, "e-1:0");
    expect(only.labels).toEqual(["shàng"]);
    expect(only.correct).toBe("shàng");

    const tiny = { planPool: ["nǐ", "hǎo"], outsidePool: [] };
    const short = generatePinyinChoices(target, 0, tiny, "e-1:0");
    expect(short.labels).toHaveLength(3);
    expect(new Set(short.labels).size).toBe(3);
    expect(short.labels).toContain("shàng");
  });

  it("buildPinyinLabelPool deduplicates words and labels and honors the exclusion", () => {
    const pool = buildPinyinLabelPool(planWords, target.id);
    expect(pool).toEqual(PLAN_LABELS.slice().sort());
    expect(pool).not.toContain("shàng"); // the excluded target's own syllables
    expect(buildPinyinLabelPool(planWords)).toContain("shàng");
  });
});
