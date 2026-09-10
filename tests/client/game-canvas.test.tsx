import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GameCanvas, type EnemyView } from "../../src/client/game/GameCanvas";
import type { RuntimeWord } from "../../src/shared/schemas";

const word = (id: string, displayHanzi: string): RuntimeWord => ({
  id,
  sourceGuids: [id],
  displayHanzi,
  hanziKey: displayHanzi,
  displayPinyin: "zì",
  acceptedPinyin: ["zi"],
  pinyinSegments: [["zì"]],
  partOfSpeech: null,
  partOfSpeechKey: null,
  senseLabel: null,
  meaning: "word",
  meaningKey: `meaning-${id}`,
  audioUrl: "",
});

const enemy = (id: string, displayHanzi: string, progress: number, spawnOrdinal: number): EnemyView => ({
  id,
  wordId: id,
  progress,
  speedMultiplier: 1,
  isNewWord: false,
  lane: 0,
  spawnOrdinal,
  columnSlot: spawnOrdinal,
  status: "descending",
  word: word(id, displayHanzi),
});

describe("GameCanvas target columns", () => {
  it("exposes one hit area per responsive column and targets the word in each", () => {
    const upper = enemy("upper", "上", 0.2, 1);
    const lower = enemy("lower", "下", 0.8, 0);
    const html = renderToStaticMarkup(<GameCanvas
      enemies={[upper, lower]}
      preparingEnemy={null}
      targetId="upper"
      solvedId={null}
      strokeData={new Map()}
      columnCount={6}
      onSelectEnemy={vi.fn()}
    />);

    expect((html.match(/class="column-selector"/g) ?? [])).toHaveLength(6);
    expect(html).toContain('aria-label="Select 下"');
    expect(html).toContain('data-enemy-id="lower"');
    expect(html).toContain('aria-label="Select 上"');
    expect(html).toContain('data-enemy-id="upper"');
  });

  it("disables every battlefield selection while gameplay is frozen", () => {
    const html = renderToStaticMarkup(<GameCanvas
      enemies={[enemy("live", "字", 0.5, 0)]}
      preparingEnemy={null}
      targetId="live"
      solvedId={null}
      strokeData={new Map()}
      columnCount={6}
      paused
      onSelectEnemy={vi.fn()}
    />);

    expect((html.match(/ disabled=""/g) ?? [])).toHaveLength(6);
  });
});
