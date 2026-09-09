import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BattleConfigError, loadBattleConfig } from "../../src/server/config";
import { Curriculum, CurriculumError } from "../../src/server/saves/curriculum";

import { fixtureCardId, TEST_BATTLE_CONFIG, writeConfigFixture, writeCurriculumFrom } from "./helpers";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));

describe("battle configuration loading", () => {
  it("loads the committed config/battle.yaml and validates it", () => {
    const config = loadBattleConfig(join(repositoryRoot, "config/battle.yaml"));
    expect(config).toEqual(TEST_BATTLE_CONFIG);
  });

  it("rejects missing keys, extra keys, and renamed keys", async () => {
    const cases: Array<string> = [
      "learningSlots: 5\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\n", // asymptotes missing
      "learningSlots: 5\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\nsurprise: true\n",
      "learningSlots: 5\nboundaries: { lowMax: 50, ceiling: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\n",
    ];
    for (const text of cases) {
      const path = await writeConfigFixture(text);
      expect(() => loadBattleConfig(path), text).toThrow(BattleConfigError);
    }
  });

  it("rejects wrong types and violated invariants", async () => {
    const cases: Array<string> = [
      "learningSlots: five\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\n",
      "learningSlots: 0\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\n",
      "learningSlots: 5\nboundaries: { lowMax: 99, developingMax: 50 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\n",
      "learningSlots: 5\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: 10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.2, developing: 0.5, mastered: 0.4 }\n",
      "learningSlots: 5\nboundaries: { lowMax: 50, developingMax: 99 }\nmasteryDelta: -10\ncurve: { midpoint: 5, shape: 1.3 }\nasymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 }\n",
    ];
    for (const text of cases) {
      const path = await writeConfigFixture(text);
      expect(() => loadBattleConfig(path), text).toThrow(BattleConfigError);
    }
  });

  it("rejects unparseable YAML, empty documents, and unreadable paths", async () => {
    const broken = await writeConfigFixture("learningSlots: [unclosed");
    expect(() => loadBattleConfig(broken)).toThrow(BattleConfigError);

    const empty = await writeConfigFixture("");
    expect(() => loadBattleConfig(empty)).toThrow(BattleConfigError);

    expect(() => loadBattleConfig("/nonexistent/battle.yaml")).toThrow(BattleConfigError);
  });
});

describe("ordered curriculum loading", () => {
  it("loads the committed cards/curriculum.json with insertion order intact", async () => {
    const path = join(repositoryRoot, "cards/curriculum.json");
    const curriculum = Curriculum.load(path);
    // 5396 entries after collapsing duplicate IDs to their earliest occurrence.
    expect(curriculum.size).toBe(5396);
    expect(new Set(curriculum.orderedCardIds).size).toBe(curriculum.size);

    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const keys = Object.keys(raw);
    expect(curriculum.orderedCardIds).toEqual(keys);
    expect(curriculum.cardIdAt(1)).toBe("b755617c48bfeec4d694db49"); // 我
    expect(curriculum.cardIdAt(curriculum.size)).toBe(keys[keys.length - 1]);
    expect(curriculum.cardIdAt(curriculum.size + 1)).toBeUndefined();
    expect(curriculum.entryOf("b755617c48bfeec4d694db49")).toMatchObject({
      file: "hsk-1/我.acard",
      hanzi: "我",
      hskLevel: 1,
    });
  });

  it("rejects non-object roots, including the legacy lesson manifest", async () => {
    for (const document of [
      [],
      { schemaVersion: 1, generator: {}, lessonSize: 20, levels: [] },
      "not an object",
    ]) {
      const { path } = await writeCurriculumFrom(document as unknown as Record<string, unknown>);
      expect(() => Curriculum.load(path)).toThrow(CurriculumError);
    }
  });

  it("rejects malformed entries and dangling prerequisites", async () => {
    const good = () => ({
      file: "hsk-1/word.acard",
      hanzi: "词",
      prerequisiteIds: [],
      hskLevel: 1,
    });

    const extraField = await writeCurriculumFrom({ [fixtureCardId(1)]: { ...good(), surprise: true } });
    expect(() => Curriculum.load(extraField.path)).toThrow(/unknown key|failed validation/i);

    const missingField = await writeCurriculumFrom({ [fixtureCardId(1)]: { file: "f", hanzi: "词", prerequisiteIds: [] } });
    expect(() => Curriculum.load(missingField.path)).toThrow(CurriculumError);

    const badKey = await writeCurriculumFrom({ "not-hex": good() });
    expect(() => Curriculum.load(badKey.path)).toThrow(/24-hex/i);

    const dangling = await writeCurriculumFrom({
      [fixtureCardId(1)]: good(),
      [fixtureCardId(2)]: { ...good(), prerequisiteIds: [fixtureCardId(9)] },
    });
    expect(() => Curriculum.load(dangling.path)).toThrow(/unknown prerequisite/i);

    const empty = await writeCurriculumFrom({});
    expect(() => Curriculum.load(empty.path)).toThrow(/empty/i);

    expect(() => Curriculum.load("/nonexistent/curriculum.json")).toThrow(CurriculumError);
  });

  it("rejects prerequisites that are not strictly earlier in insertion order", async () => {
    const good = () => ({
      file: "hsk-1/word.acard",
      hanzi: "词",
      prerequisiteIds: [],
      hskLevel: 1,
    });

    // Position 1 depends on position 2: a forward reference.
    const forward = await writeCurriculumFrom({
      [fixtureCardId(1)]: { ...good(), prerequisiteIds: [fixtureCardId(2)] },
      [fixtureCardId(2)]: good(),
    });
    expect(() => Curriculum.load(forward.path)).toThrow(/not strictly earlier/i);

    // A self-reference is its own degenerate case.
    const selfReference = await writeCurriculumFrom({
      [fixtureCardId(1)]: { ...good(), prerequisiteIds: [fixtureCardId(1)] },
    });
    expect(() => Curriculum.load(selfReference.path)).toThrow(/itself as a prerequisite/i);
  });

  it("rejects hskLevel blocks that decrease in insertion order", async () => {
    const entry = (hskLevel: number) => ({
      file: `hsk-${hskLevel}/word.acard`,
      hanzi: "词",
      prerequisiteIds: [],
      hskLevel,
    });

    const decreasing = await writeCurriculumFrom({
      [fixtureCardId(1)]: entry(2),
      [fixtureCardId(2)]: entry(1),
    });
    expect(() => Curriculum.load(decreasing.path)).toThrow(/nondecreasing/i);

    // Nondecreasing sequences — including jumps — stay valid.
    const jumping = await writeCurriculumFrom({
      [fixtureCardId(1)]: entry(1),
      [fixtureCardId(2)]: entry(4),
      [fixtureCardId(3)]: entry(4),
      [fixtureCardId(4)]: entry(6),
    });
    expect(() => Curriculum.load(jumping.path)).not.toThrow();
  });
});
