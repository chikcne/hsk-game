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

// Adverbial particles of a phrasal verb. The preposition list above covers only some of
// them, so "to go out" anchored on "out" while "to go up" anchored on "go" — the same shape
// keyed two different ways (see designs/preposition_handling.md §3). A phrasal verb now
// always anchors on its verb and takes the particle as a second key.
const PHRASAL_PARTICLES = new Set([
  "across", "ahead", "along", "apart", "around", "aside", "away", "back", "down", "forth", "forward",
  "in", "into", "off", "on", "onto", "out", "over", "through", "together", "up", "upon",
]);

// These verbs provide grammatical scaffolding when followed by a complement:
// "to get sick" is about SICK, while a bare "to get" still falls back to G.
const LEADING_LIGHT_VERBS = new Set([
  "appear", "be", "become", "come", "do", "fall", "feel", "get", "give", "go", "grow", "have", "keep", "look",
  "make", "put", "remain", "seem", "stay", "take", "turn",
]);
const LEADING_DETERMINERS = new Set(["a", "an", "her", "his", "its", "my", "one's", "one’s", "our", "the", "their", "your"]);
// Coordinators join two meanings without being one: "inside and outside" is about INSIDE.
const LEADING_CONJUNCTIONS = new Set(["and", "nor", "or", "yet"]);
// Stand-ins for an argument the word does not itself mean: "to keep someone company" is about
// COMPANY. Only mid-gloss — a gloss that opens with one is about the placeholder ("one-sided").
const LEADING_PLACEHOLDERS = new Set([
  "one", "ones", "oneself", "sb", "somebody", "someone", "someone's", "someone’s", "something", "sth",
]);
// Meta-vocabulary of a structural gloss. "measure word for books" is about BOOKS;
// anchoring on "measure" made every such label share M and gave the answer away (§2).
const STRUCTURAL_WORDS = new Set([
  "auxiliary", "classifier", "denoting", "express", "expressing", "indicate", "indicating", "interjection",
  "introduce", "introducing", "marking", "meaning", "measure", "modifying", "onomatopoeia", "particle",
  "prefix", "suffix", "used", "word",
]);
const STRUCTURAL_PREFIX = /^(?:measure word|classifier|suffix|prefix|particle|auxiliary word)\b/i;

// Prepositions used attributively or lexically rather than as scaffolding. Each is
// a whole gloss, so the surrounding label cannot change the reading (§5).
const PREPOSITION_HEADED_COMPOUNDS = new Set([
  "above mentioned", "as if", "down jacket", "of course", "opposite side", "outside world",
  "over the years", "past years", "per capita",
]);

/** Most keys a single choice may claim: the first key is primary, up to four more are
 * secondary conveniences. Extra claimed letters block distractors, which is accepted —
 * answering convenience outweighs distractor-pool width. */
const MAX_SHORTCUTS_PER_CHOICE = 5;

export type MeaningShortcut = { key: ChoiceKey; index: number };

type GlossWord = { text: string; index: number };
type Gloss = { words: GlossWord[]; structural: boolean; secondary: boolean };

function hashSeed(input: string): number {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function random(seed: number) {
  let state = seed || 1;
  return () => ((state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0) / 4294967296;
}

/** Blanks out `(...)` / `（...）` spans, keeping length so indices stay valid for the
 * original label. Register and grammar notes are not meanings and must not claim keys (§1). */
function maskParentheticals(label: string): string {
  // Split into UTF-16 units, not code points, so a masked span keeps the exact
  // length the original had and shortcut indices stay valid.
  const characters = label.split("");
  let depth = 0;
  for (let i = 0; i < characters.length; i += 1) {
    const character = characters[i]!;
    if (character === "(" || character === "（") { depth += 1; characters[i] = " "; continue; }
    if (depth > 0) {
      const closing = character === ")" || character === "）";
      characters[i] = " ";
      if (closing) depth -= 1;
    }
  }
  return characters.join("");
}

function wordsIn(text: string, offset: number): GlossWord[] {
  return [...text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)].map((match) => ({
    text: match[0].toLowerCase(),
    index: offset + match.index!,
  }));
}

/** Splits a masked label into glosses. Semicolons always separate. Commas separate ordinary
 * glosses; inside a structural gloss ("measure word for pieces, chunks, money") they instead
 * enumerate counted nouns of one meaning, so those anchors are ranked `secondary` — below
 * every gloss's primary key — rather than dropped (§2, revised: 块 needs P, C and M). */
function glossesForLabel(masked: string): Gloss[] {
  const glosses: Gloss[] = [];
  let segmentStart = 0;
  for (const segment of masked.split(";")) {
    const structural = STRUCTURAL_PREFIX.test(segment.trim());
    let spanStart = segmentStart;
    // Slashes remain variants within a gloss rather than additional shortcuts.
    segment.split(",").forEach((span, index) => {
      const secondary = structural && index > 0;
      const firstVariant = span.split("/", 1)[0]!;
      const words = wordsIn(firstVariant, spanStart);
      if (words.length > 0) glosses.push({ words, structural, secondary });
      spanStart += span.length + 1;
    });
    segmentStart += segment.length + 1;
  }
  return glosses;
}

const isPreposition = (word: GlossWord) => LEADING_PREPOSITIONS.has(word.text);
const isParticle = (word: GlossWord) => PHRASAL_PARTICLES.has(word.text);
const isLightVerb = (word: GlossWord) => LEADING_LIGHT_VERBS.has(word.text);
const isScaffolding = (word: GlossWord, position: number) =>
  isPreposition(word) || isParticle(word) || isLightVerb(word)
  || LEADING_DETERMINERS.has(word.text) || LEADING_CONJUNCTIONS.has(word.text)
  || (position > 0 && LEADING_PLACEHOLDERS.has(word.text));

/** Primary key plus, for a phrasal verb, the particle as a second key. */
function shortcutWordsForGloss(gloss: Gloss): GlossWord[] {
  const { words } = gloss;
  if (gloss.structural) {
    // Also anchors an enumerated noun after "measure word for …"; the structural branch is
    // what keeps such anchors off the meta-word ("measure", "suffix", …).
    return [words.find((word, i) => !STRUCTURAL_WORDS.has(word.text) && !isScaffolding(word, i)) ?? words[0]!];
  }

  const compound = words.map((word) => word.text).join(" ");
  if (PREPOSITION_HEADED_COMPOUNDS.has(compound)) return [words[0]!];

  const content = words.find((word, i) => !isScaffolding(word, i));
  if (content) return [content];

  // Every word is scaffolding ("to go out", "to be like", "up and down"). Prefer the
  // lexical verb, then a particle, then any non-infinitive word.
  const verb = words.find((word) => isLightVerb(word) && word.text !== "be");
  if (verb) {
    const particle = words[words.indexOf(verb) + 1];
    return particle && isParticle(particle) ? [verb, particle] : [verb];
  }
  const head = words.find(isParticle)
    ?? words.find((word) => isPreposition(word) && word.text !== "to")
    ?? words.find(isLightVerb)
    ?? words.find((word) => !LEADING_DETERMINERS.has(word.text));
  return [head ?? words[0]!];
}

function toShortcut(word: GlossWord): MeaningShortcut | null {
  const key = word.text.charAt(0).toUpperCase();
  return CHOICE_KEYS.includes(key as ChoiceKey) ? { key: key as ChoiceKey, index: word.index } : null;
}

/** Returns up to `MAX_SHORTCUTS_PER_CHOICE` distinct keys: one per comma- or
 * semicolon-separated gloss, then structural-enumeration nouns and phrasal-verb particles.
 * Within each gloss the operative word skips grammatical scaffolding. */
export function choiceShortcutsForLabel(label: string): MeaningShortcut[] {
  const collect = (source: string): MeaningShortcut[] => {
    const analyzed = glossesForLabel(source).map((gloss) => ({ secondary: gloss.secondary, words: shortcutWordsForGloss(gloss) }));
    const heads = analyzed.filter((entry) => !entry.secondary).map((entry) => entry.words[0]!);
    const tails = [
      ...analyzed.filter((entry) => entry.secondary).flatMap((entry) => entry.words),
      ...analyzed.filter((entry) => !entry.secondary).flatMap((entry) => entry.words.slice(1)),
    ];
    const ordered = [...heads, ...tails];
    const shortcuts: MeaningShortcut[] = [];
    const seen = new Set<ChoiceKey>();
    for (const word of ordered) {
      const shortcut = toShortcut(word);
      if (!shortcut || seen.has(shortcut.key)) continue;
      seen.add(shortcut.key);
      shortcuts.push(shortcut);
      if (shortcuts.length === MAX_SHORTCUTS_PER_CHOICE) break;
    }
    return shortcuts;
  };
  // A label that is nothing but a parenthetical still needs a key.
  const masked = collect(maskParentheticals(label));
  return masked.length > 0 ? masked : collect(label);
}

/** Backwards-compatible primary shortcut for callers that need one key. */
export function choiceShortcutForLabel(label: string): MeaningShortcut | null {
  return choiceShortcutsForLabel(label)[0] ?? null;
}

export function choiceKeyForLabel(label: string): ChoiceKey | null {
  return choiceShortcutForLabel(label)?.key ?? null;
}

function shuffle(items: string[], next: () => number): string[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function generateChoices(deck: RuntimeDeck, word: RuntimeWord, seed: string): MeaningChoice[] {
  const eligible = deck.allMeaningKeys.filter((key) => key !== word.meaningKey && !deck.meaningIndex[key]?.hanziKeys.includes(word.hanziKey));
  const preferredKeys = new Set(word.partOfSpeechKey ? (deck.meaningKeysByPartOfSpeech[word.partOfSpeechKey] ?? []) : []);
  const next = random(hashSeed(seed));
  // Shuffle the two tiers separately: shuffling the union would discard the
  // same-part-of-speech preference this ordering exists to express (§8a).
  const pool = [
    ...shuffle(eligible.filter((key) => preferredKeys.has(key)), next),
    ...shuffle(eligible.filter((key) => !preferredKeys.has(key)), next),
  ];

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

/** Degrade path for pathologically small distractor pools (a one-word
 * acquired pool whose merged deck cannot supply eight unique keys): the
 * correct choice is ALWAYS present, and as many unique-key distractors as
 * the pool affords follow. Only throws when even the correct label cannot
 * produce a shortcut. */
export function generateChoicesLenient(deck: RuntimeDeck, word: RuntimeWord, seed: string): MeaningChoice[] {
  try {
    return generateChoices(deck, word, seed);
  } catch {
    const correctLabel = word.meaning.trim();
    const correctShortcuts = choiceShortcutsForLabel(correctLabel);
    if (correctShortcuts.length === 0) throw new Error(`Meaning must contain A-Z: ${word.meaning}`);
    const choices: MeaningChoice[] = [{ shortcuts: correctShortcuts, label: correctLabel, correct: true }];
    const usedKeys = new Set<ChoiceKey>(correctShortcuts.map((shortcut) => shortcut.key));
    for (const meaningKey of deck.allMeaningKeys) {
      if (meaningKey === word.meaningKey) continue;
      const label = (deck.meaningIndex[meaningKey]?.label ?? meaningKey).trim();
      if (!label) continue;
      const shortcuts = choiceShortcutsForLabel(label);
      if (shortcuts.length === 0 || shortcuts.some((shortcut) => usedKeys.has(shortcut.key))) continue;
      choices.push({ shortcuts, label, correct: false });
      for (const shortcut of shortcuts) usedKeys.add(shortcut.key);
    }
    return choices;
  }
}

/** The battle loop's only entry point: NEVER throws, so a pathological deck
 * can never terminate the requestAnimationFrame frame loop. Falls all the
 * way back to a single correct-letter choice as the last resort. */
export function safeMeaningChoices(deck: RuntimeDeck, word: RuntimeWord, seed: string): MeaningChoice[] {
  try {
    return generateChoicesLenient(deck, word, seed);
  } catch {
    return [{ shortcuts: [{ key: "A", index: 0 }], label: word.meaning.trim(), correct: true }];
  }
}
