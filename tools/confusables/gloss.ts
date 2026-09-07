/** Operative-word extraction for gloss confusability, mirroring the notion of a
 * "content word" in `src/domain/session/choices.ts` (the scaffolding sets, the
 * parenthetical mask, the comma/semicolon gloss split, and the all-scaffolding
 * fallback are copies of that module's private logic — it is the runtime's
 * notion of which word a label is "about", so confusability must measure the
 * same thing). Two deviations, both precision-motivated for offline analysis:
 * structural glosses ("measure word for …") contribute nothing — two different
 * measure words share only their counted nouns, which is not confusion — and a
 * gloss whose every word is scaffolding contributes its resolved anchor as ONE
 * unit ("come back", "go"), so "to come up" and "to come down" share nothing
 * while "to go" still carries the verb. */

const LEADING_PREPOSITIONS = new Set([
  "aboard", "about", "above", "across", "after", "against", "along", "amid", "among", "around", "as", "at",
  "before", "behind", "below", "beneath", "beside", "besides", "between", "beyond", "but", "by",
  "concerning", "considering", "despite", "down", "during", "except", "excluding", "following", "for", "from",
  "in", "inside", "into", "like", "near", "of", "off", "on", "onto", "opposite", "outside", "over", "past", "per",
  "regarding", "round", "since", "than", "through", "throughout", "till", "to", "toward", "towards", "under",
  "underneath", "unlike", "until", "up", "upon", "versus", "via", "with", "within", "without",
]);
const PHRASAL_PARTICLES = new Set([
  "across", "ahead", "along", "apart", "around", "aside", "away", "back", "down", "forth", "forward",
  "in", "into", "off", "on", "onto", "out", "over", "through", "together", "up", "upon",
]);
const LEADING_LIGHT_VERBS = new Set([
  "appear", "be", "become", "come", "do", "fall", "feel", "get", "give", "go", "grow", "have", "keep", "look",
  "make", "put", "remain", "seem", "stay", "take", "turn",
]);
const LEADING_DETERMINERS = new Set(["a", "an", "her", "his", "its", "my", "one's", "one’s", "our", "the", "their", "your"]);
const LEADING_CONJUNCTIONS = new Set(["and", "nor", "or", "yet"]);
const LEADING_PLACEHOLDERS = new Set([
  "one", "ones", "oneself", "sb", "somebody", "someone", "someone's", "someone’s", "something", "sth",
]);
const STRUCTURAL_WORDS = new Set([
  "auxiliary", "classifier", "denoting", "express", "expressing", "indicate", "indicating", "interjection",
  "introduce", "introducing", "marking", "meaning", "measure", "modifying", "onomatopoeia", "particle",
  "prefix", "suffix", "used", "word",
]);
const STRUCTURAL_PREFIX = /^(?:measure word|classifier|suffix|prefix|particle|auxiliary word)\b/i;
const PREPOSITION_HEADED_COMPOUNDS = new Set([
  "above mentioned", "as if", "down jacket", "of course", "opposite side", "outside world",
  "over the years", "past years", "per capita",
]);

type GlossWord = { text: string; index: number };
export type GlossSegment = { words: GlossWord[]; structural: boolean };

/** Blanks out `(...)` / `（...）` spans, keeping length so indices stay valid. */
export function maskParentheticals(label: string): string {
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

const isPreposition = (word: GlossWord) => LEADING_PREPOSITIONS.has(word.text);
const isParticle = (word: GlossWord) => PHRASAL_PARTICLES.has(word.text);
const isLightVerb = (word: GlossWord) => LEADING_LIGHT_VERBS.has(word.text);
export const isScaffolding = (word: GlossWord, position: number) =>
  isPreposition(word) || isParticle(word) || isLightVerb(word)
  || LEADING_DETERMINERS.has(word.text) || LEADING_CONJUNCTIONS.has(word.text)
  || (position > 0 && LEADING_PLACEHOLDERS.has(word.text));

/** Splits a masked label into gloss segments exactly as the runtime does:
 * semicolons always separate, commas separate within a segment, slashes keep
 * only the first variant, and a segment opening with a structural prefix is
 * marked so its words can be skipped downstream. */
export function segmentsForLabel(label: string): GlossSegment[] {
  const masked = maskParentheticals(label);
  const segments: GlossSegment[] = [];
  let segmentStart = 0;
  for (const segment of masked.split(";")) {
    const structural = STRUCTURAL_PREFIX.test(segment.trim());
    let spanStart = segmentStart;
    segment.split(",").forEach((span) => {
      const firstVariant = span.split("/", 1)[0]!;
      const words = wordsIn(firstVariant, spanStart);
      if (words.length > 0) segments.push({ words, structural });
      spanStart += span.length + 1;
    });
    segmentStart += segment.length + 1;
  }
  return segments;
}

const resolveFallbackUnit = (words: GlossWord[]): string | null => {
  const verb = words.find((word) => isLightVerb(word) && word.text !== "be");
  if (verb) {
    const particle = words[words.indexOf(verb) + 1];
    return particle && isParticle(particle) ? `${verb.text} ${particle.text}` : verb.text;
  }
  const head = words.find(isParticle)
    ?? words.find((word) => isPreposition(word) && word.text !== "to")
    ?? words.find(isLightVerb)
    ?? words.find((word) => !LEADING_DETERMINERS.has(word.text));
  return head?.text ?? null;
};

export type LabeledSegments = Array<{ segment: GlossSegment; genuine: string[]; fallback: string | null }>;

/** Per non-structural gloss segment: the genuine content words, or — when every
 * word is scaffolding — the single fallback anchor unit (null for structural
 * segments, which contribute nothing). */
export function labeledSegmentsForLabel(label: string): LabeledSegments {
  return segmentsForLabel(label)
    .filter((segment) => !segment.structural)
    .map((segment) => {
      // A whole gloss that is a lexical preposition compound ("of course") is
      // anchored on its first word at runtime; it is one unit here too.
      if (PREPOSITION_HEADED_COMPOUNDS.has(segment.words.map((word) => word.text).join(" "))) {
        return { segment, genuine: [], fallback: segment.words[0]!.text };
      }
      const genuine = segment.words.filter((word, i) => !isScaffolding(word, i)).map((word) => word.text);
      const fallback = genuine.length === 0 ? resolveFallbackUnit(segment.words) : null;
      return { segment, genuine, fallback };
    });
}

/** Content units of a label: genuine content words, plus one fallback unit per
 * all-scaffolding gloss ("come back", "look"). These drive the shared-word
 * signal. */
export function contentUnitsForLabel(label: string): string[] {
  const units: string[] = [];
  for (const { genuine, fallback } of labeledSegmentsForLabel(label)) {
    if (genuine.length > 0) units.push(...genuine);
    else if (fallback) units.push(fallback);
  }
  return units;
}

/** Operative words of a label: the word each gloss is about — the runtime's
 * anchor (first content word, else the fallback unit). A shared-word pair must
 * touch at least one side's operative, so two glosses that merely happen to
 * share a modifier or object noun ("left side" / "right side") do not pair. */
export function operativeWordsForLabel(label: string): string[] {
  const operatives: string[] = [];
  for (const { genuine, fallback, segment } of labeledSegmentsForLabel(label)) {
    if (genuine.length > 0) operatives.push(genuine[0]!);
    else operatives.push(fallback ?? segment.words[0]!.text);
  }
  return operatives;
}

/** Words available to the synonym-class matcher, per non-structural gloss
 * segment: the token stream drops only determiners and coordinators so
 * multiword lexicon entries ("ought to", "as if") can match across scaffolding,
 * and `genuine[i]` says whether `tokens[i]` is a real content word. The class
 * matcher only scores spans overlapping `operativeSpan` — the indices in
 * `tokens` of the word this gloss is about (the runtime's anchor: first content
 * word, else the fallback unit) — and only when no genuine content word FOLLOWS
 * the match: "to see" is about seeing, "to see a doctor" is about the doctor. */
export function taggableSegmentsForLabel(
  label: string,
): Array<{ tokens: string[]; genuine: boolean[]; operativeSpan: [number, number] }> {
  return segmentsForLabel(label)
    .filter((segment) => !segment.structural)
    .map((segment) => {
      const kept: Array<{ text: string; genuine: boolean }> = [];
      segment.words.forEach((word, index) => {
        if (LEADING_DETERMINERS.has(word.text) || LEADING_CONJUNCTIONS.has(word.text)) return;
        kept.push({ text: word.text, genuine: !isScaffolding(word, index) });
      });
      const tokens = kept.map((word) => word.text);
      const genuine = kept.map((word) => word.genuine);
      const operative = segment.words.find((word, i) => !isScaffolding(word, i))?.text
        ?? resolveFallbackUnit(segment.words)
        ?? segment.words[0]!.text;
      const operativeWords = operative.split(" ");
      const start = tokens.findIndex((token, index) =>
        token === operativeWords[0] && operativeWords.every((word, offset) => tokens[index + offset] === word));
      const operativeSpan: [number, number] = start === -1 ? [0, Math.max(0, tokens.length - 1)] : [start, start + operativeWords.length - 1];
      return { tokens, genuine, operativeSpan };
    });
}
