import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { WritingCard, type WordWritingResult } from "../../src/client/writing/WritingCard";
import type { StrokeCharacterData, StrokeDataMap } from "../../src/client/data/strokeData";

const vector: StrokeCharacterData = {
  strokes: ["M 0 0 L 10 10 Z", "M 2 2 L 8 8 Z"],
  medians: [[[0, 0], [10, 10]], [[2, 2], [8, 8]]],
};
const strokeData: StrokeDataMap = new Map([["你", vector], ["好", vector]]);

const word = {
  id: "word-1",
  displayHanzi: "你好",
  displayPinyin: "nǐ hǎo",
  meaning: "hello",
};

function renderCard(overrides: Partial<Parameters<typeof WritingCard>[0]> = {}) {
  return renderToStaticMarkup(<WritingCard
    word={word}
    strokeData={strokeData}
    isNewCard={false}
    onWordComplete={vi.fn()}
    {...overrides}
  />);
}

describe("WritingCard markup", () => {
  test("keeps pinyin and meaning above the grid, status, controls, and the progress row", () => {
    const html = renderCard();
    const pinyinAt = html.indexOf("nǐ hǎo");
    const meaningAt = html.indexOf("hello");
    const gridAt = html.indexOf("writing-grid-surface");
    const statusAt = html.indexOf("writing-status");
    const controlsAt = html.indexOf("writing-controls");
    const rowAt = html.indexOf("writing-row");
    expect(pinyinAt).toBeGreaterThanOrEqual(0);
    expect(meaningAt).toBeGreaterThan(pinyinAt);
    expect(gridAt).toBeGreaterThan(meaningAt);
    expect(statusAt).toBeGreaterThan(gridAt);
    expect(controlsAt).toBeGreaterThan(statusAt);
    expect(rowAt).toBeGreaterThan(controlsAt);
  });

  test("a later card starts in writing mode with a Show Demo control and no demo prompt", () => {
    const html = renderCard();
    expect(html).toContain('data-writing-mode="writing"');
    expect(html).toContain("SHOW DEMO");
    expect(html).not.toContain("TAP TO BEGIN");
    expect(html).toContain("Draw stroke 1 of 2.");
  });

  test("the writing square is a programmatic focus anchor, not a tab stop", () => {
    const html = renderCard();
    expect(html).toMatch(/data-writing-mode="writing"[^>]*tabindex="-1"|tabindex="-1"[^>]*data-writing-mode="writing"/);
  });

  test("the demo square stays keyboard-reachable for engaging", () => {
    const html = renderCard({ isNewCard: true });
    expect(html).toMatch(/data-writing-mode="demo-loop"[^>]*tabindex="0"|tabindex="0"[^>]*data-writing-mode="demo-loop"/);
  });

  test("a new card loops the demo and asks to be tapped before writing", () => {
    const html = renderCard({ isNewCard: true });
    expect(html).toContain('data-writing-mode="demo-loop"');
    expect(html).toContain("TAP TO BEGIN");
    expect(html).toMatch(/Press Enter or tap the square to start writing/);
    expect(html).not.toContain("SHOW DEMO");
  });

  test("the accessible finish control is labeled and confirmed in a second step", () => {
    const html = renderCard();
    expect(html).toContain("FINISH WITHOUT WRITING");
    expect(html).not.toContain("FINISH CHARACTER");
  });

  test("one hangman-style slot per phrase character with the active one marked", () => {
    const html = renderCard();
    expect(html.match(/writing-slot is-/g)).toHaveLength(2);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("你 writing now");
    expect(html).toContain("好 waiting");
    expect(html).not.toContain('class="hanzi-glyph"');
  });

  test("replay audio appears only when a source exists", () => {
    expect(renderCard({ audioSource: "/game-data/hsk-1/audio/x.mp3" })).toContain("Replay word audio");
    expect(renderCard()).not.toContain("Replay word audio");
  });

  test("the card describes the whole word for assistive technology", () => {
    const html = renderCard();
    expect(html).toMatch(/aria-label="Write 你好 \(nǐ hǎo\)"/);
    expect(html).toContain("Character 1 of 2");
  });

  test("completing a phrase without writable characters renders the finished card", () => {
    const html = renderCard({ word: { ...word, displayHanzi: "!!" } });
    expect(html).toContain("writing-grid-done");
    expect(html).toContain("!! complete in 0.0s.");
    expect(html).not.toContain("FINISH WITHOUT WRITING");
  });

  test("missing stroke data falls back to a named placeholder with the escape hatch", () => {
    const html = renderCard({ word: { ...word, displayHanzi: "们" } });
    expect(html).toContain("writing-grid-missing");
    expect(html).toContain("stroke data unavailable");
    expect(html).toContain("FINISH WITHOUT WRITING");
  });

  test("completion is never reported from rendering alone", () => {
    const onWordComplete = vi.fn((_result: WordWritingResult) => undefined);
    renderCard({ onWordComplete });
    expect(onWordComplete).not.toHaveBeenCalled();
  });
});
