import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { isGraduated } from "../memory";
import type { LearningDeck } from "./types";

const HASH_MASK = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x100_0000_01b3n;
const CURRICULUM_VERSION = "ziduoduo-curriculum-v2";

/** Stable 64-bit FNV-1a over UTF-16 code units, encoded as fixed-width hex. */
function curriculumHash(value: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code & 0xff);
    hash = (hash * FNV_PRIME) & HASH_MASK;
    hash ^= BigInt(code >>> 8);
    hash = (hash * FNV_PRIME) & HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export function curriculumOrder(deck: LearningDeck, curriculumSeed: string): string[] {
  const ids = deck.words.map((word) => word.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deck word IDs must be unique");
  return ids.sort((left, right) => {
    const leftKey = curriculumHash(`${CURRICULUM_VERSION}\0${curriculumSeed}\0${deck.fingerprint}\0${left}`);
    const rightKey = curriculumHash(`${CURRICULUM_VERSION}\0${curriculumSeed}\0${deck.fingerprint}\0${right}`);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Introduces curriculum words until the acquisition pool holds `poolSize`
 * words. The pool is derived (introduced && not graduated), so graduations
 * free slots and lapsed graduates rejoin automatically; this only ever pulls
 * forward brand-new words, and only during regular play — never as a side
 * effect of reviewing another grade. */
export function introduceNewWords(
  level: LevelProgress,
  deck: LearningDeck,
  poolSize: number,
  spawnOrdinal: number,
): { level: LevelProgress; introduced: number } {
  const deckIds = deck.words.map((word) => word.id);
  const known = new Set(deckIds);
  if (known.size !== deckIds.length) throw new Error("Deck word IDs must be unique");

  let poolCount = Object.values(level.words).filter(
    (progress) => progress.introducedAtOrdinal !== null && !isGraduated(progress),
  ).length;
  let cursor = Math.min(level.curriculumCursor, deckIds.length);
  if (poolCount >= poolSize || cursor >= deckIds.length) return { level, introduced: 0 };

  const order = curriculumOrder(deck, level.curriculumSeed);
  let words: Record<string, WordProgress> = level.words;
  let introduced = 0;
  while (poolCount + introduced < poolSize && cursor < order.length) {
    const id = order[cursor];
    cursor += 1;
    if (id === undefined) continue;
    const progress = words[id];
    if (!progress || progress.introducedAtOrdinal !== null) continue;
    if (words === level.words) words = { ...level.words };
    words[id] = { ...progress, introducedAtOrdinal: spawnOrdinal };
    introduced += 1;
  }

  return {
    level: { ...level, curriculumCursor: cursor, words },
    introduced,
  };
}
