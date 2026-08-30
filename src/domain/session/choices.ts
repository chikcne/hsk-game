import { CHOICE_KEYS, type ChoiceKey } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";

export type MeaningChoice = { key: ChoiceKey; label: string; correct: boolean };

function hashSeed(input: string): number {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function random(seed: number) {
  let state = seed || 1;
  return () => ((state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
}

/** The visible first letter is also the keyboard shortcut for a choice. */
export function choiceKeyForLabel(label: string): ChoiceKey | null {
  const first = label.trim().charAt(0).toUpperCase();
  return CHOICE_KEYS.includes(first as ChoiceKey) ? first as ChoiceKey : null;
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
  const correctKey = choiceKeyForLabel(correctLabel);
  if (!correctKey) throw new Error(`Meaning must start with A-Z: ${word.meaning}`);

  const choices: MeaningChoice[] = [{ key: correctKey, label: correctLabel, correct: true }];
  const usedKeys = new Set<ChoiceKey>([correctKey]);
  for (const meaningKey of pool) {
    const label = (deck.meaningIndex[meaningKey]?.label ?? meaningKey).trim();
    const key = choiceKeyForLabel(label);
    if (!key || usedKeys.has(key)) continue;
    choices.push({ key, label, correct: false });
    usedKeys.add(key);
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
