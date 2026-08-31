import { describe, expect, it } from "vitest";
import { acceptsPinyin, canonicalizePinyin } from "../../src/domain/deck/pinyin";

describe("pinyin canonicalization", () => {
  it.each([
    ["xuéxí", "xuexi"],
    [" Xue Xi ", "xuexi"],
    ["nǚ’ér", "nver"],
    ["nü er", "nver"],
    ["nu:er", "nver"],
    ["nuer", "nuer"],
    ["hóng-lǜdēng", "honglvdeng"],
    ["kě’ài", "keai"],
  ])("normalizes %s", (input, expected) => expect(canonicalizePinyin(input)).toBe(expected));

  it("accepts a complete canonical variant", () => {
    expect(acceptsPinyin(["shei", "shui"], "shuí")).toBe(true);
  });

  it.each(["nuer", "nüer", "nu:er", "nver"])("accepts %s for nǚ’ér", (input) => {
    expect(acceptsPinyin(["nver"], input)).toBe(true);
  });

  it.each(["xxuexi", "xueexi", "xuexii", "xuéexí"])("tolerates one extra letter in %s", (input) => {
    expect(acceptsPinyin(["xuexi"], input)).toBe(true);
  });

  it.each([
    ["xuexi", "xuex", "a missing letter"],
    ["xuexi", "xuesi", "a substituted letter"],
    ["xuexi", "xueix", "transposed letters"],
    ["xuexi", "xxuexii", "two extra letters"],
    ["", "a", "an empty accepted form"],
  ])("rejects %s → %s (%s)", (expected, input) => {
    expect(acceptsPinyin([expected], input)).toBe(false);
  });

  it("still rejects incomplete alternatives", () => {
    expect(acceptsPinyin(["shei", "shui"], "shi")).toBe(false);
  });
});
