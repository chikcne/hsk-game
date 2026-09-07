/** Hand-authored synonym classes for the HSK gloss vocabulary, matched against
 * a label's word stream to tag meaning keys with confusability classes. Two
 * keys sharing any class are confusable: the player translating a bare prompt
 * cannot reliably pick between near-synonymous glosses, so neither may appear
 * as the other's distractor. Classes are deliberately TIGHT — only gloss words
 * a learner could genuinely swap. Topical kinship (eat/drink, hot/cold,
 * buy/sell, teach/learn, red/blue) is NOT enough; a false positive silently
 * shrinks a word's distractor pool, while a miss just keeps today's behaviour.
 *
 * Matching is greedy longest-first over word n-grams, so multiword entries and
 * `suppressedPhrases` shadow their substrings: "as if" scores SEEM before the
 * bare "if" can score IF, and "need not" (不用) cannot score OBLIGATION.
 * Unigram matches additionally require the word to be genuine content (or the
 * gloss to be nothing but that word), so the light verbs inside "to take a
 * shower" or "to get up" never score TAKE/GET, and 找 "to look for" never
 * scores LOOK. */

import { taggableSegmentsForLabel } from "./gloss";

export type SynonymLexicon = {
  classes: Record<string, readonly string[]>;
  suppressedPhrases: readonly string[];
};

export const SYNONYM_LEXICON: SynonymLexicon = {
  classes: {
    // 说 / 说话 / 讲 / 告诉
    speak: ["say", "speak", "talk", "tell"],
    // 看 / 看见 / 读 — "watch" is excluded: 手表/表 gloss "watch" as a NOUN;
    // "look" survives via the "look for" suppression (找) and 看's fallback anchor
    "look-see": ["look", "see", "read"],
    hear: ["hear", "listen"],
    // 走 vs 去 — the motivating pair; pinned by forceLink instead, because a
    // unigram "go" here also tags 围棋 "Go" (the board game) and every
    // directional "to go out/down/through" gloss
    motion: ["walk"],
    return: ["return", "come back", "go back", "give back"],
    arrive: ["arrive", "reach"],
    // 想 / 要 / 愿意
    want: ["want", "would like", "wish", "desire", "willing"],
    // 要 / 得(děi) / 必须 / 应该 / 该
    obligation: ["need", "must", "should", "ought to", "have to"],
    // 会 / 能 / 可以 / 可能 / 只能 / 行 — "fine" would drag 美术/优秀 in
    can: ["can", "may", "okay"],
    think: ["think", "consider", "assume"],
    believe: ["believe", "trust"],
    // 觉得/感觉/感到 — "sense" excluded: 听觉/味觉 gloss "sense of hearing"
    feel: ["feel"],
    // 知道 / 认识 / 懂 / 明白 / 清楚 / 了解
    know: ["know", "understand", "recognize", "comprehend", "realize"],
    seem: ["seem", "resemble", "as if", "be like"],
    // "pretty" is excluded: 不错 glosses "pretty good"
    beautiful: ["beautiful", "good looking"],
    happy: ["happy", "glad", "joyful", "cheerful", "pleased", "delighted"],
    sad: ["sad", "unhappy", "sorrowful"],
    afraid: ["afraid", "fear", "scared", "frightened", "terrified"],
    angry: ["angry", "mad"],
    worry: ["worry", "anxious", "nervous"],
    tired: ["tired", "weary", "exhausted"],
    delicious: ["delicious", "tasty"],
    buy: ["buy", "purchase"],
    big: ["big", "large"],
    "like-love": ["like", "love", "be fond of"],
    smart: ["smart", "clever", "intelligent"],
    maybe: ["maybe", "perhaps", "possibly", "probably", "possible", "possibility"],
    because: ["because", "because of", "due to", "owing to"],
    therefore: ["therefore", "as a result", "thus"],
    if: ["if", "as long as", "only if"],
    // 完/结束/完成 verbs are force-linked pairwise instead: "end"/"complete"
    // also gloss the nouns 末/期末/终点 and adjectives 完整/完全/齐全
    "receive-get": ["receive", "accept"],
    // 拿/带/搬 physical-holding verbs are force-linked pairwise instead: a
    // TAKE class also tags 举行 "to hold (a meeting)" and 执行 "to carry out"
    wear: ["wear", "put on"],
    sick: ["sick", "ill", "illness", "disease", "sickness"],
    // "manner" would drag 态度/样子 in
    "way-method": ["way", "method", "solution", "means"],
    place: ["place", "location"],
    holiday: ["festival", "holiday", "vacation"],
    easy: ["easy", "simple"],
    interesting: ["interesting", "fun", "enjoyable", "amusing"],
    // "close" excluded: 关闭/封闭 "to close (shut)" and 亲密 "close, intimate"
    near: ["near", "nearby"],
    season: ["season", "seasons"],
    home: ["home", "house"],
    person: ["person", "people"],
    child: ["child", "kid"],
    here: ["here"],
    there: ["there"],
    photo: ["photo", "picture", "photograph"],
    question: ["question", "problem"],
    help: ["help", "assist", "aid"],
    learn: ["learn", "study"],
    start: ["start", "begin"],
    fast: ["fast", "quick", "quickly", "rapid"],
    hate: ["hate"],
    goodbye: ["goodbye", "farewell"],
    spend: ["spend"],
    student: ["student", "pupil"],
  },
  suppressedPhrases: [
    // Polysemous spans whose unigram would otherwise score a class:
    // 恐怕 "I'm afraid that…" is conjecture, not fear; 不用 "need not" is the
    // OPPOSITE of obligation; "such as" (像) is exemplification; 找 "look for"
    // is searching, not looking; 请问 "may i ask" is not ability; 不一定 "may
    // not" is not ability; 罐头 "can jar" is not ability; 样子 "appearance
    // look" is a noun; 不然 "if not" is not a condition; 如同/似的 "like as
    // (if)" compares, it does not ENJOY; 有关 "have to do with" relates, it
    // is not compelled; 不得 "must not" and 不宜 "should not" are PROHIBITIONS.
    "need not",
    "such as",
    "look for",
    "may i ask",
    "may not",
    "appearance look",
    "if not",
    "like as",
    // 有关 "to have to do with" relates, it is not compelled (3 tokens: the
    // matcher never sees 4-grams)
    "have to do",
    "must not",
    "should not",
    "out of way",
    // 乐于 "be happy to, be willing to" would weld the happy and want classes
    "be happy to",
    // 打针/获奖 list "receive a shot"/"receive an award" as secondary glosses
    "receive shot",
    "receive award",
  ],
};

const MAX_NGRAM = 3;

const classByPhrase = new Map<string, string>();
for (const [classId, phrases] of Object.entries(SYNONYM_LEXICON.classes)) {
  for (const phrase of phrases) {
    const existing = classByPhrase.get(phrase);
    if (existing && existing !== classId) throw new Error(`Lexicon phrase ${JSON.stringify(phrase)} is in classes ${existing} and ${classId}`);
    classByPhrase.set(phrase, classId);
  }
}
const suppressed = new Set(SYNONYM_LEXICON.suppressedPhrases);
for (const phrase of suppressed) {
  if (classByPhrase.has(phrase)) throw new Error(`Lexicon phrase ${JSON.stringify(phrase)} is both a class entry and suppressed`);
}

/** Class ids a label's glosses score, one per matched span. A match only counts
 * when its span overlaps the gloss's operative word (the runtime's anchor) AND
 * no genuine content word follows the match: "to see" is about seeing while
 * "to see a doctor" is about the doctor, so the perception verb heads the gloss
 * in the first case only. Unigram matches must in addition BE the whole
 * operative span — the single word this gloss is about ("go" in "to go"),
 * never a verb inside a multiword fallback ("go" of "go down"). Phrase matches
 * score wherever they overlap the operative, because the scaffolding words are
 * what make the phrase ("be fond of"). */
export function classTagsForLabel(label: string): Set<string> {
  const tags = new Set<string>();
  for (const { tokens, genuine, operativeSpan } of taggableSegmentsForLabel(label)) {
    let position = 0;
    scan: while (position < tokens.length) {
      for (let length = Math.min(MAX_NGRAM, tokens.length - position); length >= 1; length -= 1) {
        const phrase = tokens.slice(position, position + length).join(" ");
        if (suppressed.has(phrase)) { position += length; continue scan; }
        const classId = classByPhrase.get(phrase);
        if (!classId) continue;
        const overlapsOperative = position <= operativeSpan[1] && operativeSpan[0] <= position + length - 1;
        if (!overlapsOperative) continue;
        if (length === 1 && !(operativeSpan[0] === position && operativeSpan[1] === position)) continue;
        const headsTheGloss = genuine.slice(position + length).every((isGenuine) => !isGenuine);
        if (!headsTheGloss) continue;
        tags.add(classId);
        position += length;
        continue scan;
      }
      position += 1;
    }
  }
  return tags;
}
