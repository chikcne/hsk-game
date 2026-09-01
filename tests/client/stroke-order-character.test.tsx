import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { StrokeOrderCharacter } from "../../src/client/game/StrokeOrderCharacter";
import type { StrokeCharacterData } from "../../src/client/data/strokeData";

const vector: StrokeCharacterData = {
  strokes: ["M 0 0 L 10 10 Z", "M 2 2 L 8 8 Z"],
  medians: [[[0, 0], [10, 10]], [[2, 2], [8, 8]]],
};

describe("gameplay stroke character lifecycle", () => {
  test("renders live glyphs as animation-free declarative vectors", () => {
    const html = renderToStaticMarkup(<StrokeOrderCharacter
      character="字"
      data={vector}
      animate={false}
      startDelayMs={0}
      paused={false}
      ink="target"
    />);

    expect(html).toContain('data-character="字"');
    expect(html).toContain('viewBox="0 0 1024 1024"');
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).not.toContain("stroke-dashoffset");
    expect(html).not.toContain("opacity:");
  });
});
