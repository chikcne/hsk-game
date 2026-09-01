import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { HanziText } from "../../src/client/game/HanziText";
import type { StrokeCharacterData } from "../../src/client/data/strokeData";

const vector: StrokeCharacterData = {
  strokes: ["M 0 0 L 10 10 Z"],
  medians: [[[0, 0], [10, 10]]],
};

describe("static Hanzi vectors", () => {
  test("renders Han characters as paths while preserving an accessible text name", () => {
    const html = renderToStaticMarkup(<HanziText text="第2课" data={new Map([["第", vector], ["课", vector]])} />);
    expect(html).toContain('class="vector-text-accessible">第2课</span>');
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain('transform="translate(0 900) scale(1 -1)"');
    expect(html).toContain("M 0 0 L 10 10 Z");
    expect(html).toContain(">2</span>");
  });

  test("uses a font-free placeholder when vector data is missing", () => {
    const html = renderToStaticMarkup(<HanziText text="缺" data={new Map()} />);
    expect(html).toContain("hanzi-glyph-missing");
    expect(html).toContain('class="vector-text-accessible">缺</span>');
    expect(html).not.toContain('class="vector-text-visual" aria-hidden="true">缺');
  });
});
