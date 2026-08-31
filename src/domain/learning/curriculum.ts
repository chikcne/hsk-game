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

/** Keeps a rolling learning pool. Each mastered pool word opens one slot for
 * the next unseen curriculum word; other unmastered words remain active. A
 * relapsed older word expands the active pool instead of displacing new work. */
export function refillCurriculum(level: LevelProgress, deck: LearningDeck): LevelProgress {
  const deckIds = deck.words.map((word) => word.id);
  const known = new Set(deckIds);
  if (known.size !== deckIds.length) throw new Error("Deck word IDs must be unique");
  const poolSize = level.currentLevelWordIds.length;
  const currentLevelWordIds: string[] = [];
  const currentSeen = new Set<string>();
  for (const id of level.currentLevelWordIds) {
    const progress = level.words[id];
    if (!known.has(id) || !progress || progress.appearanceWeight === 1 || currentSeen.has(id)) continue;
    currentLevelWordIds.push(id);
    currentSeen.add(id);
  }

  const activeLearningWordIds: string[] = [];
  const activeSeen = new Set<string>();
  for (const id of [...level.activeLearningWordIds, ...currentLevelWordIds]) {
    const progress = level.words[id];
    if (!known.has(id) || !progress || progress.introducedAtOrdinal === null || progress.appearanceWeight === 1 || activeSeen.has(id)) continue;
    activeLearningWordIds.push(id);
    activeSeen.add(id);
  }

  let cursor = Math.min(level.curriculumCursor, deckIds.length);
  let words: Record<string, WordProgress> = level.words;
  const order = currentLevelWordIds.length < poolSize && cursor < deckIds.length
    ? curriculumOrder(deck, level.curriculumSeed)
    : null;
  while (order && currentLevelWordIds.length < poolSize && cursor < order.length) {
    const id = order[cursor++];
    if (!id) continue;
    const progress = words[id];
    if (!progress || progress.introducedAtOrdinal !== null) continue;
    if (words === level.words) words = { ...level.words };
    words[id] = { ...progress, introducedAtOrdinal: level.nextSpawnOrdinal };
    currentLevelWordIds.push(id);
    currentSeen.add(id);
    if (progress.appearanceWeight > 1 && !activeSeen.has(id)) {
      activeLearningWordIds.push(id);
      activeSeen.add(id);
    }
  }

  const unchanged = cursor === level.curriculumCursor
    && words === level.words
    && currentLevelWordIds.length === level.currentLevelWordIds.length
    && currentLevelWordIds.every((id, index) => id === level.currentLevelWordIds[index])
    && activeLearningWordIds.length === level.activeLearningWordIds.length
    && activeLearningWordIds.every((id, index) => id === level.activeLearningWordIds[index])
    && level.reviewedOlderWordIds.length === 0;
  if (unchanged) return level;
  return {
    ...level,
    curriculumCursor: cursor,
    currentLevelWordIds,
    activeLearningWordIds,
    reviewedOlderWordIds: [],
    words,
  };
}
