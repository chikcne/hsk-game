import type { RuntimeWord } from "../../shared/schemas";

/** Deterministic pinyin-choice generation for Review Mode's Selection Mode.
 *
 * Every Han-character step of the locked target renders eight unique button
 * labels: the correct syllable (all of the current character's authored
 * alternatives grouped on one button) plus seven distractors — four sourced from pinyin segments of
 * other unique words scheduled in the current Review plan, three from loaded
 * deck words outside the plan. Pools are prebuilt per battle by the caller
 * (see `buildPinyinLabelPools`); the generator itself is pure: the same
 * word/character/pools/seed always produce the same eight labels in the same
 * order. The caller seeds shuffling with the enemy id plus the character
 * index, so every character of every enemy gets fresh positions. */

/** Total buttons per character step: 1 correct + 7 distractors. */
export const PINYIN_CHOICE_COUNT = 8;
/** Distractors sourced from words inside the current Review plan. */
export const PINYIN_PLAN_DISTRACTORS = 4;

export type PinyinChoicePools = {
  /** Labels from pinyin segments of unique words in the Review plan (the
   * target's own contributions are excluded by the pool builder). */
  planPool: readonly string[];
  /** Labels from pinyin segments of loaded deck words outside the plan. */
  outsidePool: readonly string[];
};

export type PinyinChoices = {
  /** Shuffled button labels; contains `correct` exactly once. */
  labels: string[];
  /** The one correct label (all authored alternatives for the current
   * character, grouped on a single button). */
  correct: string;
};

/** One button represents one character's complete authored pronunciation
 * group. Most groups contain one spelling; polyphonic alternatives remain a
 * single unambiguous choice (谁 renders `shéi / shuí`). */
export const pinyinLabelForGroup = (group: readonly string[]): string => group.join(" / ");

const alternativesOfLabel = (label: string): string[] => label.split(" / ");

/** Flattens words into a deduplicated, deterministically ordered label pool.
 * `excludeWordId` drops the target word entirely: none of its syllables may
 * serve as a distractor for itself. */
export function buildPinyinLabelPool(
  words: readonly RuntimeWord[],
  excludeWordId?: string,
): string[] {
  const labels = new Set<string>();
  for (const word of words) {
    if (excludeWordId !== undefined && word.id === excludeWordId) continue;
    for (const group of word.pinyinSegments) {
      const label = pinyinLabelForGroup(group);
      if (label) labels.add(label);
    }
  }
  return [...labels].sort();
}

function hashSeed(input: string): number {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function random(seed: number) {
  let state = seed || 1;
  return () => ((state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
}

function shuffle(items: readonly string[], next: () => number): string[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function drawDistinct(
  shuffled: readonly string[],
  count: number,
  taken: Set<string>,
): string[] {
  const drawn: string[] = [];
  for (const label of shuffled) {
    if (drawn.length >= count) break;
    const alternatives = alternativesOfLabel(label);
    // A button that contains any correct or already-used pronunciation is
    // not a genuinely distinct distractor, even if its combined label text
    // differs (for example `shuí` beside correct `shéi / shuí`).
    if (alternatives.some((alternative) => taken.has(alternative))) continue;
    for (const alternative of alternatives) taken.add(alternative);
    drawn.push(label);
  }
  return drawn;
}

/** Generates the eight (or, for pathological pools, as many as possible)
 * pinyin buttons for one character step of `word`. Never throws: a fixture
 * with a one-word corpus still returns the correct label alone. */
export function generatePinyinChoices(
  word: RuntimeWord,
  charIndex: number,
  pools: PinyinChoicePools,
  seed: string,
): PinyinChoices {
  const alternatives = word.pinyinSegments[charIndex] ?? [];
  const correct = pinyinLabelForGroup(alternatives);
  if (!correct) return { labels: [], correct: "" };

  const next = random(hashSeed(seed));
  // Every authored alternative of the current character is answerable as the
  // same selection, so none of them may double as a distractor.
  const taken = new Set(alternatives);
  const planShuffled = shuffle(pools.planPool, next);
  const outsideShuffled = shuffle(pools.outsidePool, next);
  const planDistractors = drawDistinct(planShuffled, PINYIN_PLAN_DISTRACTORS, taken);
  // Backfill keeps the false-choice count at seven even when the plan pool
  // cannot supply four unique eligible labels (small fixtures/early saves).
  const outsideCount = PINYIN_CHOICE_COUNT - 1 - planDistractors.length;
  const outsideDistractors = drawDistinct(outsideShuffled, outsideCount, taken);

  const labels = shuffle([correct, ...planDistractors, ...outsideDistractors], next);
  return { labels, correct };
}
