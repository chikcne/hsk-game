import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BattleConfig, BattleOutcome } from "../../src/shared/battle";

const directories: string[] = [];

export async function temporaryDirectory(prefix = "hanzi-saves-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

/** Deterministic 24-hex card ID for a 1-based curriculum position. */
export const fixtureCardId = (position: number): string => position.toString(16).padStart(24, "0");

export type CurriculumFixture = {
  path: string;
  cardIds: string[];
};

/** Writes an ordered curriculum JSON fixture: `count` cards, insertion order
 * = position 1..count, each entry depending on its predecessor. */
export async function writeCurriculumFixture(count: number, hskLevels: number[] = []): Promise<CurriculumFixture> {
  const directory = await temporaryDirectory("hanzi-curriculum-");
  const cardIds = Array.from({ length: count }, (_, index) => fixtureCardId(index + 1));
  const manifest: Record<string, unknown> = {};
  for (const [index, cardId] of cardIds.entries()) {
    manifest[cardId] = {
      file: `hsk-${hskLevels[index] ?? 1}/word-${index + 1}.acard`,
      hanzi: `词${index + 1}`,
      prerequisiteIds: index > 0 ? [cardIds[index - 1]!] : [],
      hskLevel: hskLevels[index] ?? 1,
    };
  }
  const path = join(directory, "curriculum.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, cardIds };
}

export async function writeCurriculumFrom(
  entries: Record<string, unknown>,
): Promise<{ path: string }> {
  const directory = await temporaryDirectory("hanzi-curriculum-");
  const path = join(directory, "curriculum.json");
  await writeFile(path, JSON.stringify(entries));
  return { path };
}

export async function writeConfigFixture(text: string): Promise<string> {
  const directory = await temporaryDirectory("hanzi-config-");
  const path = join(directory, "battle.yaml");
  await writeFile(path, text);
  return path;
}

/** A clock advancing through the given ISO stamps (last one repeats). */
export function fixedClock(...stamps: string[]): () => Date {
  let index = 0;
  return () => new Date(stamps[Math.min(index++, stamps.length - 1)]!);
}

/** Test-only Battle tuning fixture injected into repositories for domain-level
 * tests. It is NOT kept value-identical to the committed config/battle.yaml:
 * that file is the single runtime tuning source, and tests that exercise it
 * load it themselves rather than comparing against this literal. */
export const TEST_BATTLE_CONFIG: BattleConfig = {
  learningSlots: 5,
  boundaries: { lowMax: 50, developingMax: 99 },
  masteryDelta: 10,
  masteryCurve: { maxMsPerChar: 2000, maxGain: 20, midMsPerChar: 5000, midGain: 10, floorMsPerChar: 8000, floorGain: 1, secondChanceGain: 0 },
  relief: { correct: 0.1, secondChance: 0.05 },
  curve: { midpoint: 5, shape: 1.3 },
  asymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 },
};

/** Any correct answer, at any speed, moves a fresh word past lowMax
 * (0 -> 60 > 50), and one wrong answer takes it straight back down. */
export const fastGraduationConfig: BattleConfig = {
  ...TEST_BATTLE_CONFIG,
  masteryDelta: 60,
  masteryCurve: { ...TEST_BATTLE_CONFIG.masteryCurve, maxGain: 60, midGain: 60, floorGain: 60 },
};

/** Outcome fixtures at the committed curve anchors: `fastAnswer` sits in the
 * flat maximum band, `midAnswer` on the midpoint anchor, `slowAnswer` one
 * millisecond short of the second-chance threshold. */
export const fastAnswer: BattleOutcome = { kind: "correct", answerMs: 1_000, charCount: 1 };
export const midAnswer: BattleOutcome = { kind: "correct", answerMs: 5_000, charCount: 1 };
export const slowAnswer: BattleOutcome = { kind: "correct", answerMs: 7_999, charCount: 1 };
export const secondChanceAnswer: BattleOutcome = { kind: "secondChance" };
export const wrongAnswer: BattleOutcome = { kind: "wrong" };
