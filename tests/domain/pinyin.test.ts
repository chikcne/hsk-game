import { describe, expect, it } from "vitest";
import { acceptsPinyin, canonicalizePinyin } from "../../src/domain/deck/pinyin";
describe("pinyin canonicalization", () => {
  it.each([["xuéxí","xuexi"],[" Xue Xi ","xuexi"],["nǚ’ér","nver"],["nü er","nver"],["nu:er","nver"],["nuer","nuer"],["hóng-lǜdēng","honglvdeng"],["kě’ài","keai"]])("normalizes %s", (input, expected) => expect(canonicalizePinyin(input)).toBe(expected));
  it("accepts only a complete canonical variant", () => { expect(acceptsPinyin(["shei","shui"], "shuí")).toBe(true); expect(acceptsPinyin(["shei","shui"], "shi")).toBe(false); });
});
