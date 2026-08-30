import { CHOICE_KEYS, type ChoiceKey } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";

export type MeaningChoice = { key: ChoiceKey; label: string; correct: boolean };
function hashSeed(input: string): number {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
function random(seed: number) { let state = seed || 1; return () => ((state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0) / 4294967296; }

export function generateChoices(deck: RuntimeDeck, word: RuntimeWord, seed: string): MeaningChoice[] {
  const eligible = deck.allMeaningKeys.filter((key) => key !== word.meaningKey && !deck.meaningIndex[key]?.hanziKeys.includes(word.hanziKey));
  const preferred = word.partOfSpeechKey ? (deck.meaningKeysByPartOfSpeech[word.partOfSpeechKey] ?? []).filter((key) => eligible.includes(key)) : [];
  const pool = [...new Set([...preferred, ...eligible])];
  const next = random(hashSeed(seed));
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  const labels = [word.meaning, ...pool.slice(0, 7).map((key) => deck.meaningIndex[key]?.label ?? key)];
  while (labels.length < 8) labels.push(`Related meaning ${labels.length}`);
  for (let i = labels.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [labels[i], labels[j]] = [labels[j]!, labels[i]!]; }
  return CHOICE_KEYS.map((key, index) => ({ key, label: labels[index]!, correct: labels[index] === word.meaning }));
}
