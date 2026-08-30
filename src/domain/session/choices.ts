import { CHOICE_KEYS, type ChoiceKey } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";

export type MeaningChoice = { key: ChoiceKey; label: string; shortcutIndex: number; correct: boolean };

const LEADING_PREPOSITIONS = new Set([
  "aboard", "about", "above", "across", "after", "against", "along", "amid", "among", "around", "as", "at",
  "before", "behind", "below", "beneath", "beside", "besides", "between", "beyond", "but", "by",
  "concerning", "considering", "despite", "down", "during", "except", "excluding", "following", "for", "from",
  "in", "inside", "into", "like", "near", "of", "off", "on", "onto", "opposite", "outside", "over", "past", "per",
  "regarding", "round", "since", "than", "through", "throughout", "till", "to", "toward", "towards", "under",
  "underneath", "unlike", "until", "up", "upon", "versus", "via", "with", "within", "without",
]);

export type MeaningShortcut = { key: ChoiceKey; index: number };

function hashSeed(input: string): number {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function random(seed: number) {
  let state = seed || 1;
  return () => ((state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
}

/** Uses the first content word, skipping leading prepositions such as the
 * infinitive marker in "to drink". The returned index identifies the letter
 * the UI should highlight. */
export function choiceShortcutForLabel(label: string): MeaningShortcut | null {
  const words = [...label.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)];
  if (words.length === 0) return null;
  const contentWord = words.find((word) => !LEADING_PREPOSITIONS.has(word[0].toLowerCase())) ?? words[0]!;
  const key = contentWord[0].charAt(0).toUpperCase();
  return CHOICE_KEYS.includes(key as ChoiceKey) ? { key: key as ChoiceKey, index: contentWord.index! } : null;
}

export function choiceKeyForLabel(label: string): ChoiceKey | null {
  return choiceShortcutForLabel(label)?.key ?? null;
}

export function generateChoices(deck: RuntimeDeck, word: RuntimeWord, seed: string): MeaningChoice[] {
  const eligible = deck.allMeaningKeys.filter((key) => key !== word.meaningKey && !deck.meaningIndex[key]?.hanziKeys.includes(word.hanziKey));
  const preferred = word.partOfSpeechKey ? (deck.meaningKeysByPartOfSpeech[word.partOfSpeechKey] ?? []).filter((key) => eligible.includes(key)) : [];
  const pool = [...new Set([...preferred, ...eligible])];
  const next = random(hashSeed(seed));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  const correctLabel = word.meaning.trim();
  const correctShortcut = choiceShortcutForLabel(correctLabel);
  if (!correctShortcut) throw new Error(`Meaning must contain A-Z: ${word.meaning}`);

  const choices: MeaningChoice[] = [{ key: correctShortcut.key, label: correctLabel, shortcutIndex: correctShortcut.index, correct: true }];
  const usedKeys = new Set<ChoiceKey>([correctShortcut.key]);
  for (const meaningKey of pool) {
    const label = (deck.meaningIndex[meaningKey]?.label ?? meaningKey).trim();
    const shortcut = choiceShortcutForLabel(label);
    if (!shortcut || usedKeys.has(shortcut.key)) continue;
    choices.push({ key: shortcut.key, label, shortcutIndex: shortcut.index, correct: false });
    usedKeys.add(shortcut.key);
    if (choices.length === 8) break;
  }

  if (choices.length < 8) {
    throw new Error(`Not enough meanings with distinct first letters for ${word.id}`);
  }
  for (let i = choices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  return choices;
}
