import { describe, expect, it } from "vitest";
import { normalizeHanzi } from "../../tools/import-decks/normalize/hanzi";
import { acceptedPinyinForms, canonicalizePinyin } from "../../tools/import-decks/normalize/pinyin";
import { normalizedKey, sanitizeText } from "../../tools/import-decks/normalize/text";

 describe("import text normalization", () => {
  it("tokenizes tags, decodes entities, and normalizes whitespace", () => {
    expect(sanitizeText(" <b>to&nbsp;look</b><br>after &#x27;it&#x27; ")).toBe("to look after 'it'");
    expect(normalizedKey("  To look-after; IT! ")).toBe("to look after it");
  });

  it("normalizes compatibility Hanzi and reviewed suffix forms", () => {
    expect(normalizeHanzi(" ⽩⾊. ")).toMatchObject({ displayHanzi: "白色", hanziKey: "白色", nfkcChanged: true });
    expect(normalizeHanzi("本 (classifier)")).toMatchObject({ displayHanzi: "本", senseLabel: "classifier" });
    expect(normalizeHanzi("生 2")).toMatchObject({ displayHanzi: "生", senseLabel: "sense 2" });
    expect(() => normalizeHanzi("劳verb")).toThrow(/non-CJK residue/u);
  });

  it("canonicalizes tones without losing the u-diaeresis distinction", () => {
    expect(canonicalizePinyin("nǚ ér")).toBe("nver");
    expect(canonicalizePinyin("NU:3")).toBe("nv");
    expect(canonicalizePinyin("Xi'an")).toBe("xian");
    expect(acceptedPinyinForms("shéi / shuí / shéi")).toEqual(["shei", "shui"]);
  });
});
