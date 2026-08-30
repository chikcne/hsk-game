import type { LevelProgress, WordProgress } from "../../shared/schemas";
import type { LearningDeck } from "./types";

const HASH_MASK = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x100_0000_01b3n;
const CURRICULUM_VERSION = "hanzi-defender-curriculum-v2";

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

/** Normalizes the active pool. Unlike the old rolling curriculum this never
 * introduces a replacement word inside a level. */
export function refillCurriculum(level: LevelProgress, deck: LearningDeck): LevelProgress {
  const known = new Set(deck.words.map((word) => word.id));
  const required = new Set(level.currentLevelWordIds);
  const active: string[] = [];
  const seen = new Set<string>();
  for (const id of [...level.activeLearningWordIds, ...level.currentLevelWordIds]) {
    const progress = level.words[id];
    if (!known.has(id) || !progress || progress.appearanceWeight === 1 || seen.has(id)) continue;
    if (required.has(id) || progress.introducedAtOrdinal !== null) {
      active.push(id);
      seen.add(id);
    }
  }
  const reviewedOlderWordIds = [...new Set(level.reviewedOlderWordIds)].filter((id) => known.has(id));
  if (
    active.length === level.activeLearningWordIds.length &&
    active.every((id, index) => id === level.activeLearningWordIds[index]) &&
    reviewedOlderWordIds.length === level.reviewedOlderWordIds.length
  ) return level;
  return { ...level, activeLearningWordIds: active, reviewedOlderWordIds };
}

/** Starts the next fixed-size level and introduces no more than levelSize new words. */
export function beginNextCurriculumLevel(
  level: LevelProgress,
  deck: LearningDeck,
  levelSize: number,
): LevelProgress {
  const order = curriculumOrder(deck, level.curriculumSeed);
  let cursor = Math.min(level.curriculumCursor, order.length);
  const currentLevelWordIds: string[] = [];
  let words: Record<string, WordProgress> = level.words;
  while (currentLevelWordIds.length < levelSize && cursor < order.length) {
    const id = order[cursor++];
    if (!id) continue;
    const progress = words[id];
    if (!progress || progress.introducedAtOrdinal !== null) continue;
    if (words === level.words) words = { ...level.words };
    words[id] = { ...progress, introducedAtOrdinal: level.nextSpawnOrdinal };
    currentLevelWordIds.push(id);
  }
  return {
    ...level,
    currentLevelIndex: level.currentLevelIndex + 1,
    curriculumCursor: cursor,
    currentLevelWordIds,
    activeLearningWordIds: currentLevelWordIds.filter((id) => words[id]?.appearanceWeight !== 1),
    reviewedOlderWordIds: [],
    words,
  };
}
