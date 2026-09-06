import { describe, expect, it } from "vitest";
import { applyPinyinSelection, initialPinyinSelection } from "../../src/domain/session/pinyin-selection";

const SHANGXUE = [["shàng"], ["xué"]] as const;
const SHEI = [["shéi", "shuí"]] as const;
const ZHER = [["zhè"], ["r"]] as const;

describe("applyPinyinSelection (Selection Mode progress)", () => {
  it("starts a fresh target at character 0 with nothing selected", () => {
    expect(initialPinyinSelection()).toEqual({ selected: [], charIndex: 0 });
  });

  it("advances one character per correct click, keeping the displayed segments", () => {
    let progress = initialPinyinSelection();
    const first = applyPinyinSelection(SHANGXUE, progress, "shàng");
    expect(first.kind).toBe("advance");
    progress = first.progress;
    expect(progress).toEqual({ selected: ["shàng"], charIndex: 1 });
  });

  it("the final correct segment completes the word", () => {
    const progress = { selected: ["shàng"], charIndex: 1 };
    const done = applyPinyinSelection(SHANGXUE, progress, "xué");
    expect(done.kind).toBe("complete");
    expect(done.progress).toEqual({ selected: ["shàng", "xué"], charIndex: 2 });
  });

  it("a wrong click reports the selected sequence plus the wrong label and freezes progress", () => {
    const progress = { selected: ["shàng"], charIndex: 1 };
    const wrong = applyPinyinSelection(SHANGXUE, progress, "nǐ");
    expect(wrong.kind).toBe("wrong");
    expect(wrong).toMatchObject({ attempted: "shàngnǐ" });
    expect(wrong.progress).toEqual(progress);
  });

  it("accepts any authored alternative of the current character", () => {
    expect(applyPinyinSelection(SHEI, initialPinyinSelection(), "shéi").kind).toBe("complete");
    expect(applyPinyinSelection(SHEI, initialPinyinSelection(), "shuí").kind).toBe("complete");
    expect(applyPinyinSelection(SHEI, initialPinyinSelection(), "shéi / shuí").kind).toBe("complete");
  });

  it("treats the bare contracted r as the erhua character's answer", () => {
    const progress = { selected: ["zhè"], charIndex: 1 };
    expect(applyPinyinSelection(ZHER, progress, "r").kind).toBe("complete");
    expect(applyPinyinSelection(ZHER, progress, "er").kind).toBe("wrong");
  });

  it("resetting to the initial state models a locked-target change", () => {
    const mid = { selected: ["shàng"], charIndex: 1 };
    expect(initialPinyinSelection().selected).toHaveLength(0);
    expect(mid.selected).toHaveLength(1); // sanity: the mid state was real
  });
});
