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
