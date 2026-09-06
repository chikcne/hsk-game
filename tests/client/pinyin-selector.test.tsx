import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PinyinChoiceGrid, SelectedPinyin } from "../../src/client/app/PinyinSelector";
import type { PinyinSelectionView } from "../../src/client/state/useBattle";

function view(overrides: Partial<PinyinSelectionView> = {}): PinyinSelectionView {
  return {
    labels: ["shàng", "nǐ", "hǎo", "diàn", "nǎo", "lǎo", "shī", "péng"],
    correct: "shàng",
    selected: [],
    charIndex: 0,
    charCount: 2,
    hanziChars: ["上", "学"],
    hanzi: "上",
    ...overrides,
  };
}

describe("PinyinSelector markup", () => {
  it("renders the selected pinyin above the buttons with accessible character progress", () => {
    const html = renderToStaticMarkup(<SelectedPinyin selection={view({ selected: ["shàng"], charIndex: 1, hanzi: "学" })} />);
    expect(html).toContain("shàng");
    expect(html).toContain("Character 2 of 2");
    expect(html).toContain("Selected pinyin shàng");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // The Han progress row marks the current character.
    expect(html).toContain('class="char-progress"');
    expect(html).toMatch(/<b class="done">上<\/b><b class="current">学<\/b>/);
  });

  it("renders a compact 4x2 button grid of the eight labels with no pinyin hotkeys", () => {
    const html = renderToStaticMarkup(
      <PinyinChoiceGrid selection={view()} disabled={false} onChoose={vi.fn()} />,
    );
    expect(html).toContain('class="pinyin-grid"');
    expect(html).toContain('role="group"');
    expect(html).toContain("Pinyin choices for character 1 of 2 (上)");
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(8);
    for (const label of ["shàng", "nǐ", "hǎo", "diàn", "nǎo", "lǎo", "shī", "péng"]) {
      expect(html).toContain(`>${label}</span>`);
    }
    // No letter/number shortcut semantics on pinyin choices: no key badges,
    // no aria-key labels — buttons answer via focus + Enter/Space only.
    expect(html).not.toContain("aria-label=\"Press");
    expect(html).not.toContain("<mark");
    expect(html).not.toContain("disabled");
  });

  it("disables selection during pause and corrective feedback", () => {
    const html = renderToStaticMarkup(
      <PinyinChoiceGrid selection={view()} disabled onChoose={vi.fn()} />,
    );
    expect((html.match(/disabled/g) ?? []).length).toBe(8);
  });
});
