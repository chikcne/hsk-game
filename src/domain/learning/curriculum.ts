import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { ACTIVE_CURRICULUM_SIZE } from "./constants";
import type { LearningDeck } from "./types";

const HASH_MASK = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x100_0000_01b3n;
const CURRICULUM_VERSION = "hanzi-defender-curriculum-v1";

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
    const leftKey = curriculumHash(
      `${CURRICULUM_VERSION}\0${curriculumSeed}\0${deck.fingerprint}\0${left}`,
    );
    const rightKey = curriculumHash(
      `${CURRICULUM_VERSION}\0${curriculumSeed}\0${deck.fingerprint}\0${right}`,
    );
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Fills vacancies without evicting relapse words. Already introduced IDs are skipped,
 * which also makes fingerprint reconciliation safe when its cursor restarts at zero.
 */
export function refillCurriculum(level: LevelProgress, deck: LearningDeck): LevelProgress {
  const deckIds = deck.words.map((word) => word.id);
  const known = new Set(deckIds);
  if (known.size !== deckIds.length) throw new Error("Deck word IDs must be unique");
  const active: string[] = [];
  const seenActive = new Set<string>();
  for (const id of level.activeLearningWordIds) {
    const progress = level.words[id];
    if (
      known.has(id) &&
      progress !== undefined &&
      progress.appearanceWeight > 1 &&
      !seenActive.has(id)
    ) {
      active.push(id);
      seenActive.add(id);
    }
  }

  if (
    active.length >= ACTIVE_CURRICULUM_SIZE ||
    (level.curriculumCursor >= deckIds.length && active.length === 0)
  ) {
    return active.length === level.activeLearningWordIds.length &&
      active.every((id, index) => id === level.activeLearningWordIds[index])
      ? level
      : { ...level, activeLearningWordIds: active };
  }

  const order = curriculumOrder(deck, level.curriculumSeed);
  let cursor = Math.min(level.curriculumCursor, order.length);
  let words: Record<string, WordProgress> = level.words;
  while (active.length < ACTIVE_CURRICULUM_SIZE && cursor < order.length) {
    const id = order[cursor];
    cursor += 1;
    if (id === undefined) continue;
    const progress = words[id];
    if (progress === undefined || progress.introducedAtOrdinal !== null) continue;

    if (words === level.words) words = { ...level.words };
    words[id] = { ...progress, introducedAtOrdinal: level.nextSpawnOrdinal };
    if (progress.appearanceWeight > 1 && !seenActive.has(id)) {
      active.push(id);
      seenActive.add(id);
    }
  }

  return {
    ...level,
    curriculumCursor: cursor,
    activeLearningWordIds: active,
    words,
  };
}
