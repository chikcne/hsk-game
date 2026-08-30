import { CHOICE_KEYS, type ChoiceKey } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";

export type MeaningChoice = { shortcuts: MeaningShortcut[]; label: string; correct: boolean };

const LEADING_PREPOSITIONS = new Set([
  "aboard", "about", "above", "across", "after", "against", "along", "amid", "among", "around", "as", "at",
  "before", "behind", "below", "beneath", "beside", "besides", "between", "beyond", "but", "by",
  "concerning", "considering", "despite", "down", "during", "except", "excluding", "following", "for", "from",
  "in", "inside", "into", "like", "near", "of", "off", "on", "onto", "opposite", "outside", "over", "past", "per",
  "regarding", "round", "since", "than", "through", "throughout", "till", "to", "toward", "towards", "under",
  "underneath", "unlike", "until", "up", "upon", "versus", "via", "with", "within", "without",
]);

// These verbs provide grammatical scaffolding when followed by a complement:
// "to get sick" is about SICK, while a bare "to get" still falls back to G.
const LEADING_LIGHT_VERBS = new Set([
  "appear", "be", "become", "come", "do", "fall", "feel", "get", "give", "go", "grow", "have", "keep", "look",
  "make", "put", "remain", "seem", "stay", "take", "turn",
]);
const LEADING_DETERMINERS = new Set(["a", "an", "her", "his", "its", "my", "one's", "one’s", "our", "the", "their", "your"]);

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

function shortcutForGloss(gloss: string, offset: number): MeaningShortcut | null {
  const words = [...gloss.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)];
  if (words.length === 0) return null;

  const isScaffolding = (word: RegExpMatchArray) => {
    const normalized = word[0].toLowerCase();
    return LEADING_PREPOSITIONS.has(normalized) || LEADING_LIGHT_VERBS.has(normalized) || LEADING_DETERMINERS.has(normalized);
  };
  const contentWord = words.find((word) => !isScaffolding(word))
    // If the gloss consists only of scaffolding (for example "to get"), use
    // its light verb rather than the infinitive marker.
    ?? words.find((word) => !LEADING_PREPOSITIONS.has(word[0].toLowerCase()) && !LEADING_DETERMINERS.has(word[0].toLowerCase()))
    ?? words[0]!;
  const key = contentWord[0].charAt(0).toUpperCase();
  return CHOICE_KEYS.includes(key as ChoiceKey) ? { key: key as ChoiceKey, index: offset + contentWord.index! } : null;
}

/** Returns one shortcut for each comma- or semicolon-separated gloss.
 * Within each gloss, the operative word skips leading grammatical scaffolding. */
export function choiceShortcutsForLabel(label: string): MeaningShortcut[] {
  const shortcuts: MeaningShortcut[] = [];
  let offset = 0;
  for (const gloss of label.split(/[;,]/u)) {
    // Slashes remain variants within a gloss rather than additional shortcuts.
    const firstVariant = gloss.split("/", 1)[0]!;
    const shortcut = shortcutForGloss(firstVariant, offset);
    if (shortcut) shortcuts.push(shortcut);
    offset += gloss.length + 1;
  }
  return shortcuts;
}

/** Backwards-compatible primary shortcut for callers that need one key. */
export function choiceShortcutForLabel(label: string): MeaningShortcut | null {
  return choiceShortcutsForLabel(label)[0] ?? null;
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
  const correctShortcuts = choiceShortcutsForLabel(correctLabel);
  if (correctShortcuts.length === 0) throw new Error(`Meaning must contain A-Z: ${word.meaning}`);

  const choices: MeaningChoice[] = [{ shortcuts: correctShortcuts, label: correctLabel, correct: true }];
  const usedKeys = new Set<ChoiceKey>(correctShortcuts.map((shortcut) => shortcut.key));
  for (const meaningKey of pool) {
    const label = (deck.meaningIndex[meaningKey]?.label ?? meaningKey).trim();
    const shortcuts = choiceShortcutsForLabel(label);
    if (shortcuts.length === 0 || shortcuts.some((shortcut) => usedKeys.has(shortcut.key))) continue;
    choices.push({ shortcuts, label, correct: false });
    for (const shortcut of shortcuts) usedKeys.add(shortcut.key);
    if (choices.length === 8) break;
  }

  if (choices.length < 8) {
    throw new Error(`Not enough meanings with non-colliding shortcuts for ${word.id}`);
  }
  for (let i = choices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  return choices;
}
