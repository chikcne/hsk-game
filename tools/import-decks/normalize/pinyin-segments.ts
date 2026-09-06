import { Data, Effect } from "effect";
import { pinyin } from "pinyin-pro";

/** Compile-time derivation of character-aligned pinyin segments from an
 * authored `.acard` pinyin string.
 *
 * The authored pronunciation is the ONLY truth: every segment character —
 * including tone marks, tone sandhi, neutral tones and capitalization — is
 * copied verbatim from the authored form. Hanzi pronunciation data (via
 * pinyin-pro) is consulted solely to find syllable boundaries: tone-mark-free
 * comparison tells the aligner how many letters each Han character owns, and
 * a standard no-tone syllabary acts as a last-resort fallback when the
 * dictionary disagrees with the authored reading (e.g. 膀, which pinyin-pro
 * reads páng while the corpus authors bǎng).
 *
 * Output contract: exactly one entry per Han character. Alternatives across
 * `/`-separated forms are grouped into one selectable answer (谁 →
 * [["shéi","shuí"]]), and contracted erhua keeps one entry per character
 * (这儿/zhèr → [["zhè"],["r"]]). */

export class PinyinSegmentError extends Data.TaggedError("PinyinSegmentError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Hard syllable boundaries authors may write inside one pinyin form. */
const SEPARATORS = new Set([" ", "'", "\u2019", "-"]);

/** The no-tone Mandarin syllabary (ü spelled `v`) used by the fallback
 * aligner and by per-segment validation. Interjection syllables are
 * included because HSK admits 嗯/诶-class words. */
const VALID_SYLLABLES = new Set(("a o e ai ei ao ou an en ang eng er n ng m hm hng lo yo " +
  "ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu " +
  "pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu " +
  "ma mo me mai mei mao mou man men mang meng mi mie miao mian min ming miu mu " +
  "fa fo fei fou fan fen fang feng fu " +
  "da dai dan dang dao de dei den deng di dia die diao dian ding diu dong dou du duan dui dun duo " +
  "ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo " +
  "na nai nan nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve " +
  "la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve " +
  "ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo " +
  "ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo " +
  "ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo " +
  "ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun " +
  "qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun " +
  "xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun " +
  "zha zhai zhan zhang zhao zhe zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo " +
  "cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo " +
  "sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo " +
  "ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo " +
  "za zai zan zang zao ze zei zen zeng zi zong zou zu zuan zui zun zuo " +
  "ca cai can cang cao ce cen ceng ci cong cou cu cuan cui cun cuo " +
  "sa sai san sang sao se sen seng si song sou su suan sui sun suo " +
  "ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun " +
  "wa wai wan wang wei wen weng wo wu").split(" "));

/** One original character of the authored form, mapped to its tone-free
 * Latin letter(s). `null` marks a separator. The NFD umlaut (u + U+0308)
 * becomes `v`; every other combining mark (tones) is dropped. */
function plainUnit(character: string): string | null {
  if (SEPARATORS.has(character)) return null;
  let letters = "";
  let umlaut = false;
  for (const mark of character.normalize("NFD")) {
    if (/[a-zA-Z]/u.test(mark)) letters += mark.toLowerCase();
    else if (mark === "\u0308") umlaut = true;
  }
  if (umlaut) {
    if (!letters.endsWith("u")) return "";
    letters = `${letters.slice(0, -1)}v`;
  }
  return letters;
}

const plainForm = (form: string): string => [...form].map(plainUnit).join("");

type Unit = { character: string; letter: string | null };

/** Per-character candidate spellings (tone-free) from Hanzi pronunciation
 * data: the word-context reading plus every standalone reading of each
 * character, so polyphones (音乐/银行/打扫) align to the authored letters. */
function readingHints(hanzi: string): Map<string, Set<string>> {
  const hints = new Map<string, Set<string>>();
  const characters = [...hanzi];
  const contextual = pinyin(hanzi, { type: "array", toneType: "symbol" });
  if (contextual.length === characters.length) {
    for (const [index, character] of characters.entries()) {
      const plain = plainForm(contextual[index] ?? "");
      if (plain) {
        const readings = hints.get(character) ?? new Set<string>();
        readings.add(plain);
        hints.set(character, readings);
      }
    }
  }
  for (const character of characters) {
    const readings = hints.get(character) ?? new Set<string>();
    for (const reading of pinyin(character, { type: "array", toneType: "symbol", multiple: true })) {
      const plain = plainForm(reading);
      if (plain) readings.add(plain);
    }
    hints.set(character, readings);
  }
  return hints;
}

/** Aligns one authored alternative form to the Han characters. Returns the
 * per-character segments, or null when the candidate set cannot consume the
 * form exactly (callers then retry with the syllabary fallback). */
function alignForm(
  characters: readonly string[],
  units: readonly Unit[],
  candidates: (character: string) => Iterable<string>,
): string[] | null {
  let letters = "";
  const boundaryAfter = new Set<number>();
  const letterToUnit: number[] = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    if (unit.letter === null) {
      boundaryAfter.add(letters.length);
      continue;
    }
    letters += unit.letter;
    letterToUnit.push(index);
  }

  // Memoized DP over (character index, letter offset). Each character owns
  // one span of letters; a span may never cross a separator boundary.
  const memo = new Map<string, number[] | null>();
  const solve = (characterIndex: number, position: number): number[] | null => {
    const key = `${characterIndex}:${position}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached === null ? null : [...cached];
    let result: number[] | null = null;
    if (characterIndex === characters.length) {
      result = position === letters.length ? [] : null;
    } else {
      const character = characters[characterIndex]!;
      const options = [...new Set(candidates(character))].sort((a, b) => b.length - a.length);
      // Contracted erhua: a word-final-position 儿 may own the bare `r` that
      // the previous syllable absorbed (干活儿 gànhuór → 干|活|儿 = gàn|huó|r).
      const contracted =
        character === "\u513f" && characterIndex > 0 && position > 0
        && !boundaryAfter.has(position) && letters[position] === "r" && !options.includes("r");
      if (contracted) options.unshift("r");
      for (const option of options) {
        if (!letters.startsWith(option, position)) continue;
        const end = position + option.length;
        let crosses = false;
        for (let inner = position + 1; inner < end && !crosses; inner += 1) crosses = boundaryAfter.has(inner);
        if (crosses) continue;
        const rest = solve(characterIndex + 1, end);
        if (rest) {
          result = [position, ...rest];
          break;
        }
      }
    }
    memo.set(key, result);
    return result === null ? null : [...result];
  };

  const cuts = solve(0, 0);
  if (!cuts) return null;
  const segments: string[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const fromUnit = letterToUnit[cuts[index]!]!;
    const endLetter = cuts[index + 1]!;
    const toUnit = endLetter === letters.length ? units.length : letterToUnit[endLetter]!;
    // Separators sit BETWEEN syllables; trim any that leaked to the edges.
    let span = units.slice(fromUnit, toUnit);
    while (span.length > 0 && span[0]!.letter === null) span = span.slice(1);
    while (span.length > 0 && span[span.length - 1]!.letter === null) span = span.slice(0, -1);
    segments.push(span.map((unit) => unit.character).join(""));
  }
  return segments;
}

const syllabaryCandidates = (): readonly string[] => [...VALID_SYLLABLES];

/** Segments one authored pinyin form (already `/`-split) for one word. */
function segmentAlternative(hanzi: string, form: string): string[] {
  const characters = [...hanzi];
  const units: Unit[] = [];
  for (const character of form) {
    const letter = plainUnit(character);
    if (letter === null) {
      units.push({ character, letter: null });
      continue;
    }
    if (letter === "") {
      throw new PinyinSegmentError({ detail: `${hanzi} / ${form}: character ${character} is not pinyin` });
    }
    units.push({ character, letter });
  }
  const hints = readingHints(hanzi);
  const fromReadings = alignForm(characters, units, (character) => hints.get(character) ?? []);
  const segments = fromReadings ?? alignForm(characters, units, syllabaryCandidates);
  if (!segments) {
    throw new PinyinSegmentError({ detail: `${hanzi} / ${form}: authored pinyin cannot be aligned per character` });
  }
  for (const segment of segments) {
    const plain = plainForm(segment);
    if (plain !== "r" && !VALID_SYLLABLES.has(plain)) {
      throw new PinyinSegmentError({ detail: `${hanzi} / ${form}: segment ${segment} is not a Mandarin syllable` });
    }
  }
  // Reconstruction guard: the segments must reproduce the authored form
  // (sans separators) verbatim — tones, sandhi, capitals and all.
  const expected = [...form].filter((character) => !SEPARATORS.has(character)).join("");
  if (segments.join("") !== expected) {
    throw new PinyinSegmentError({ detail: `${hanzi} / ${form}: segments reconstruct as ${segments.join("")}` });
  }
  return segments;
}

/** Builds the character-aligned `pinyinSegments` for one word from its
 * authored display pinyin. Alternatives (`shéi/shuí`) are merged into one
 * grouped entry per character, first form's spelling first. Throws a typed
 * `PinyinSegmentError` on any card that cannot be segmented faithfully. */
export function segmentPinyinForms(hanzi: string, displayPinyin: string): string[][] {
  const characters = [...hanzi];
  if (characters.length === 0) {
    throw new PinyinSegmentError({ detail: `${hanzi}: empty hanzi` });
  }
  const alternatives = displayPinyin.split("/").map((form) => form.trim()).filter(Boolean);
  if (alternatives.length === 0) {
    throw new PinyinSegmentError({ detail: `${hanzi}: authored pinyin is blank` });
  }
  const merged: string[][] = characters.map(() => []);
  for (const form of alternatives) {
    const segments = segmentAlternative(hanzi, form);
    for (const [index, segment] of segments.entries()) {
      if (!merged[index]!.includes(segment)) merged[index]!.push(segment);
    }
  }
  return merged;
}

/** Effect boundary for the compile pipelines: surfaces the failure with the
 * card's file context so the compile report points at the offending card. */
export const segmentPinyinFormsEffect = (
  hanzi: string,
  displayPinyin: string,
): Effect.Effect<string[][], PinyinSegmentError, never> => Effect.try({
  try: () => segmentPinyinForms(hanzi, displayPinyin),
  catch: (cause) => cause instanceof PinyinSegmentError
    ? cause
    : new PinyinSegmentError({ detail: `${hanzi} / ${displayPinyin}: ${String(cause)}` }),
});
