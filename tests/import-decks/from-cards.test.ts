import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { RuntimeDeckSchema } from "../../src/shared/schemas";
import { compileFromCardsEffect } from "../../tools/import-decks/compile/from-cards";
import { Fs } from "../../tools/shared/fs";

const idOf = (hanzi: string, pinyin: string, meaning: string): string =>
  createHash("sha256").update(`word-v1\0${hanzi}\0${pinyin}\0${meaning}`).digest("hex").slice(0, 24);

type FixtureWord = {
  hanzi: string;
  pinyin: string;
  meaning: string;
  level: number;
  grade: number;
  directory: number;
  prerequisiteIds?: string[];
};

type WordSpec = [hanzi: string, pinyin: string, meaning: string];

/** Grade 1 holds 22 words so the 20-card chunking produces a [20, 2] lesson
 * split; 山 lives in the hsk-3 directory with effective grade 1 (a hoisted
 * card), 水 is duplicated into hsk-6, and a few explicit prerequisites ride
 * along for the ordering checks. */
const grade1: Array<WordSpec | [WordSpec, Partial<FixtureWord>]> = [
  ["一", "yī", "one"],
  ["二", "èr", "two"],
  ["三", "sān", "three"],
  ["四", "sì", "four"],
  [["山", "shān", "mountain"], { level: 3, directory: 3 }],
  ["五", "wǔ", "five"],
  ["六", "liù", "six"],
  ["七", "qī", "seven"],
  ["八", "bā", "eight"],
  ["九", "jiǔ", "nine"],
  ["十", "shí", "ten"],
  ["书", "shū", "book"],
  ["猫", "māo", "cat"],
  ["狗", "gǒu", "dog"],
  ["水", "shuǐ", "water"],
  ["雨", "yǔ", "rain"],
  ["人", "rén", "person"],
  ["车", "chē", "vehicle"],
  ["门", "mén", "gate"],
  ["月", "yuè", "moon"],
  ["火", "huǒ", "fire"],
  ["土", "tǔ", "earth"],
];

// Smaller grades use nine single-word meanings with pairwise-distinct first
// letters so every word keeps seven safe, non-colliding meaning distractors.
const smallerGrades: Record<number, WordSpec[]> = {
  2: [["王", "wáng", "king"], ["后", "hòu", "queen"], ["富", "fù", "rich"], ["穷", "qióng", "poor"], ["少", "shào", "young"], ["老", "lǎo", "old"], ["新", "xīn", "new"], ["蓝", "lán", "blue"], ["灰", "huī", "gray"]],
  3: [["快", "kuài", "fast"], ["慢", "màn", "slow"], ["大", "dà", "big"], ["小", "xiǎo", "tiny"], ["静", "jìng", "quiet"], ["暖", "nuǎn", "warm"], ["冷", "lěng", "cold"], ["干", "gān", "dry"], ["湿", "shī", "humid"]],
  4: [["乐", "lè", "happy"], ["悲", "bēi", "sad"], ["怒", "nù", "angry"], ["平", "píng", "calm"], ["勤", "qín", "eager"], ["温", "wēn", "gentle"], ["闲", "xián", "idle"], ["慈", "cí", "jolly"], ["善", "shàn", "kind"]],
  5: [["城", "chéng", "city"], ["镇", "zhèn", "town"], ["村", "cūn", "village"], ["路", "lù", "road"], ["桥", "qiáo", "bridge"], ["港", "gǎng", "port"], ["农", "nóng", "farm"], ["矿", "kuàng", "mine"], ["石", "shí", "quarry"]],
  6: [["枣", "zǎo", "date"], ["杏", "xìng", "apricot"], ["梅", "méi", "plum"], ["兰", "lán", "orchid"], ["竹", "zhú", "bamboo"], ["松", "sōng", "fir"], ["柏", "bǎi", "cedar"], ["枫", "fēng", "maple"], ["柠", "níng", "lemon"]],
};

function fixtureWords(): FixtureWord[] {
  const words: FixtureWord[] = [];
  const idOfSpec = (spec: WordSpec) => idOf(spec[0], spec[1], spec[2]);
  for (const item of grade1) {
    const [spec, overrides = {}] = Array.isArray(item[0]) ? [item[0] as WordSpec, item[1] as Partial<FixtureWord>] : [item as WordSpec, {}];
    const grade = 1;
    words.push({
      hanzi: spec[0], pinyin: spec[1], meaning: spec[2], level: grade, grade, directory: grade, ...overrides,
      prerequisiteIds: spec[0] === "二" ? [idOfSpec(["一", "yī", "one"])]
        : spec[0] === "十" ? [idOfSpec(["一", "yī", "one"]), idOfSpec(["二", "èr", "two"])]
        : spec[0] === "雨" ? [idOfSpec(["山", "shān", "mountain"])]
        : [],
    });
  }
  for (const [grade, specs] of Object.entries(smallerGrades)) {
    for (const spec of specs) {
      words.push({ hanzi: spec[0], pinyin: spec[1], meaning: spec[2], level: Number(grade), grade: Number(grade), directory: Number(grade), prerequisiteIds: [] });
    }
  }
  return words;
}

function acardBody(word: FixtureWord, idOverride?: string): string {
  return `${JSON.stringify({
    schema: "acard/1",
    audio: null,
    curriculum: { components: [], frequency: null, grade: word.grade, notes: null, pin: null, topics: ["abstract-relations"] },
    hanzi: word.hanzi,
    id: idOverride ?? idOf(word.hanzi, word.pinyin, word.meaning),
    level: word.level,
    meaning: word.meaning,
    pinyin: word.pinyin,
    pos: "noun",
    senseLabel: null,
    source: { deck: `fixture-hsk-${word.level}`, guids: [word.hanzi], overrides: [], sharedId: 1 },
  }, null, 2)}\n`;
}

function buildManifest(words: FixtureWord[]): Record<string, { file: string; hanzi: string; prerequisiteIds: string[]; hskLevel: number }> {
  const manifest: Record<string, { file: string; hanzi: string; prerequisiteIds: string[]; hskLevel: number }> = {};
  for (let grade = 1; grade <= 6; grade += 1) {
    for (const word of words.filter((candidate) => candidate.grade === grade)) {
      manifest[idOf(word.hanzi, word.pinyin, word.meaning)] = {
        file: `hsk-${word.directory}/${word.hanzi}.acard`,
        hanzi: word.hanzi,
        prerequisiteIds: word.prerequisiteIds ?? [],
        hskLevel: grade,
      };
    }
  }
  return manifest;
}

async function writeFixture(
  words: FixtureWord[],
  manifest: Record<string, unknown>,
  extraFiles: Array<{ path: string; body: string }> = [],
): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "hsk-from-cards-"));
  const output = join(root, "public", "game-data");
  await mkdir(join(root, "cards"), { recursive: true });
  await writeFile(join(root, "cards", "curriculum.json"), JSON.stringify(manifest, null, 2));
  for (const word of words) {
    const directory = join(root, "cards", `hsk-${word.directory}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${word.hanzi}.acard`), acardBody(word));
  }
  for (const extra of extraFiles) {
    await mkdir(dirname(join(root, extra.path)), { recursive: true });
    await writeFile(join(root, extra.path), extra.body);
  }
  return { root, output };
}

const compile = (root: string, output: string): Promise<unknown> =>
  Effect.runPromise(Effect.provide(compileFromCardsEffect({ repositoryRoot: root, outputDirectory: output }), Fs.layer));

const byHanzi = (words: FixtureWord[], hanzi: string): FixtureWord => words.find((word) => word.hanzi === hanzi)!;

describe("compiling decks from the keyed curriculum manifest", () => {
  it("chunks each effective grade into 20-card lessons in manifest order", async () => {
    const words = fixtureWords();
    // A later exact duplicate of 水 in the hsk-6 source deck: same semantic
    // card, omitted by first-wins canonicalization, tolerated at compile time.
    const duplicate = { ...byHanzi(words, "水"), level: 6, grade: 6, directory: 6 };
    const { root, output } = await writeFixture(words, buildManifest(words), [
      { path: `cards/hsk-${duplicate.directory}/${duplicate.hanzi}.acard`, body: acardBody(duplicate) },
    ]);
    try {
      await compile(root, output);
      const deck = RuntimeDeckSchema.parse(JSON.parse(await readFile(join(output, "hsk-1", "deck.json"), "utf8")));
      expect(deck.curriculum.lessonSize).toBe(20);
      expect(deck.curriculum.lessons.map((lesson) => lesson.wordIds.length)).toEqual([20, 2]);
      expect(deck.curriculum.lessons.map((lesson) => lesson.id)).toEqual(["hsk-1-lesson-1", "hsk-1-lesson-2"]);
      expect(deck.curriculum.lessons[0]!.wordIds[0]).toBe(idOf("一", "yī", "one"));
      // The hoisted 山 card compiles into hsk-1 despite living in cards/hsk-3.
      expect(deck.words.map((word) => word.displayHanzi)).toContain("山");
      const grade3 = RuntimeDeckSchema.parse(JSON.parse(await readFile(join(output, "hsk-3", "deck.json"), "utf8")));
      expect(grade3.words.map((word) => word.displayHanzi)).not.toContain("山");
      expect(grade3.curriculum.lessons).toHaveLength(1);
      // The duplicate file never reaches a deck.
      const grade6 = RuntimeDeckSchema.parse(JSON.parse(await readFile(join(output, "hsk-6", "deck.json"), "utf8")));
      expect(grade6.words.filter((word) => word.displayHanzi === "水")).toHaveLength(0);
      expect(JSON.parse(await readFile(join(output, "import-report.json"), "utf8")).decks).toHaveLength(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tolerates only later exact duplicates of canonicalized source cards", async () => {
    const words = fixtureWords();
    const fire = byHanzi(words, "火");
    const city = byHanzi(words, "城");

    const cases: Array<{ name: string; extra: { path: string; body: string }; message: RegExp }> = [
      {
        name: "rejects a same-id copy with different content",
        extra: { path: "cards/hsk-6/火.acard", body: acardBody({ ...fire, level: 6, grade: 6, directory: 6, meaning: "flame" }, idOf(fire.hanzi, fire.pinyin, fire.meaning)) },
        message: /not an exact duplicate/u,
      },
      {
        name: "rejects an unreferenced unique source card",
        extra: { path: "cards/hsk-6/谜.acard", body: acardBody({ hanzi: "谜", pinyin: "mí", meaning: "riddle", level: 6, grade: 6, directory: 6 }) },
        message: /source card is missing from the curriculum/u,
      },
      {
        name: "rejects an earlier-level copy kept out of the manifest",
        extra: { path: "cards/hsk-2/城.acard", body: acardBody({ ...city, level: 2, grade: 2, directory: 2 }) },
        message: /kept a later copy/u,
      },
    ];
    for (const testCase of cases) {
      const { root, output } = await writeFixture(words, buildManifest(words), [testCase.extra]);
      try {
        await expect(compile(root, output), testCase.name).rejects.toThrow(testCase.message);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects manifest mismatches and ordering violations without touching prior output", async () => {
    const words = fixtureWords();
    const one = byHanzi(words, "一");
    const ten = byHanzi(words, "十");
    const earth = byHanzi(words, "土");
    const base = buildManifest(words);
    const oneId = idOf(one.hanzi, one.pinyin, one.meaning);
    const tenId = idOf(ten.hanzi, ten.pinyin, ten.meaning);
    const earthId = idOf(earth.hanzi, earth.pinyin, earth.meaning);

    const withEntry = (id: string, mutate: (entry: { file: string; hanzi: string; prerequisiteIds: string[]; hskLevel: number }) => void) => {
      const manifest = JSON.parse(JSON.stringify(base)) as typeof base;
      mutate(manifest[id]!);
      return manifest;
    };
    // A second key pointing at 一's file trips the one-file-one-entry rule.
    const twiceManifest = JSON.parse(JSON.stringify(base)) as typeof base;
    twiceManifest["e".repeat(24)] = { ...twiceManifest[oneId]!, hanzi: "一" };
    const cases: Array<{ name: string; manifest: Record<string, unknown>; message: RegExp }> = [
      { name: "key does not match its card", manifest: renameKey(base, oneId, "f".repeat(24)), message: /curriculum key does not match its card id/u },
      { name: "stale hanzi", manifest: withEntry(oneId, (entry) => { entry.hanzi = "壹"; }), message: /curriculum metadata is stale/u },
      { name: "wrong effective grade", manifest: withEntry(oneId, (entry) => { entry.hskLevel = 2; }), message: /effective grade does not match/u },
      { name: "prerequisite at a later position", manifest: withEntry(oneId, (entry) => { entry.prerequisiteIds = [tenId]; }), message: /not in an earlier curriculum position/u },
      { name: "unknown prerequisite", manifest: withEntry(oneId, (entry) => { entry.prerequisiteIds = ["0".repeat(24)]; }), message: /prerequisite 0+ is missing/u },
      { name: "missing source card", manifest: omitKey(base, earthId), message: /source card is missing from the curriculum/u },
      { name: "file referenced twice", manifest: twiceManifest, message: /source card appears more than once in curriculum/u },
    ];

    for (const testCase of cases) {
      const { root, output } = await writeFixture(words, testCase.manifest);
      try {
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "prior-marker"), "keep me");
        await expect(compile(root, output), testCase.name).rejects.toThrow(testCase.message);
        expect(await readFile(join(output, "prior-marker"), "utf8")).toBe("keep me");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

function renameKey<T>(manifest: Record<string, T>, from: string, to: string): Record<string, T> {
  const renamed: Record<string, T> = {};
  for (const [key, value] of Object.entries(manifest)) renamed[key === from ? to : key] = value;
  return renamed;
}

function omitKey<T>(manifest: Record<string, T>, key: string): Record<string, T> {
  const omitted = { ...manifest };
  delete omitted[key];
  return omitted;
}
