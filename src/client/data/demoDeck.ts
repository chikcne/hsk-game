import type { DeckId } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { curriculumFromWordIds } from "../../domain/learning";

/** [hanzi, displayPinyin, acceptedPinyin, meaning, pinyinSegments]. The
 * segments mirror what the compile pipeline derives for real decks: one
 * entry per Han character (see tools/import-decks/normalize/pinyin-segments). */
const vocabulary = [
  ["学习", "xuéxí", "xuexi", "to study; to learn", [["xué"], ["xí"]]],
  ["你", "nǐ", "ni", "you", [["nǐ"]]],
  ["好", "hǎo", "hao", "good", [["hǎo"]]],
  ["电", "diàn", "dian", "electricity", [["diàn"]]],
  ["学校", "xuéxiào", "xuexiao", "school", [["xué"], ["xiào"]]],
  ["朋友", "péngyou", "pengyou", "friend", [["péng"], ["you"]]],
  ["爱", "ài", "ai", "to love", [["ài"]]],
  ["水", "shuǐ", "shui", "water", [["shuǐ"]]],
  ["中国", "Zhōngguó", "zhongguo", "China", [["Zhōng"], ["guó"]]],
  ["老师", "lǎoshī", "laoshi", "teacher", [["lǎo"], ["shī"]]],
  ["学生", "xuésheng", "xuesheng", "student", [["xué"], ["sheng"]]],
  ["谢谢", "xièxie", "xiexie", "thank you", [["xiè"], ["xie"]]],
  ["再见", "zàijiàn", "zaijian", "goodbye", [["zài"], ["jiàn"]]],
  ["请", "qǐng", "qing", "please; to invite", [["qǐng"]]],
  ["吃", "chī", "chi", "to eat", [["chī"]]],
  ["喝", "hē", "he", "to drink", [["hē"]]],
  ["看", "kàn", "kan", "to look; to watch", [["kàn"]]],
  ["听", "tīng", "ting", "to listen", [["tīng"]]],
  ["说", "shuō", "shuo", "to speak", [["shuō"]]],
  ["写", "xiě", "xie", "to write", [["xiě"]]],
  ["你好", "nǐhǎo", "nihao", "hello", [["nǐ"], ["hǎo"]]],
  ["读", "dú", "du", "to read", [["dú"]]],
  ["工作", "gōngzuò", "gongzuo", "to work; job", [["gōng"], ["zuò"]]],
  ["今天", "jīntiān", "jintian", "today", [["jīn"], ["tiān"]]],
  ["明天", "míngtiān", "mingtian", "tomorrow", [["míng"], ["tiān"]]],
  ["昨天", "zuótiān", "zuotian", "yesterday", [["zuó"], ["tiān"]]],
  ["现在", "xiànzài", "xianzai", "now", [["xiàn"], ["zài"]]],
  ["时候", "shíhou", "shihou", "time; moment", [["shí"], ["hou"]]],
  ["认识", "rènshi", "renshi", "to know; to recognize", [["rèn"], ["shi"]]],
  ["准备", "zhǔnbèi", "zhunbei", "to prepare", [["zhǔn"], ["bèi"]]],
  ["问题", "wèntí", "wenti", "question; problem", [["wèn"], ["tí"]]],
  ["帮助", "bāngzhù", "bangzhu", "to help", [["bāng"], ["zhù"]]],
  ["喜欢", "xǐhuan", "xihuan", "to like", [["xǐ"], ["huan"]]],
  ["漂亮", "piàoliang", "piaoliang", "beautiful", [["piào"], ["liang"]]],
  ["高兴", "gāoxìng", "gaoxing", "happy", [["gāo"], ["xìng"]]],
  ["天气", "tiānqì", "tianqi", "weather", [["tiān"], ["qì"]]],
  ["医院", "yīyuàn", "yiyuan", "hospital", [["yī"], ["yuàn"]]],
  ["商店", "shāngdiàn", "shangdian", "shop; store", [["shāng"], ["diàn"]]],
  ["电脑", "diànnǎo", "diannao", "computer", [["diàn"], ["nǎo"]]],
  ["电影", "diànyǐng", "dianying", "movie", [["diàn"], ["yǐng"]]],
  ["名字", "míngzi", "mingzi", "name", [["míng"], ["zi"]]],
  ["什么", "shénme", "shenme", "what", [["shén"], ["me"]]],
  ["怎么", "zěnme", "zenme", "how", [["zěn"], ["me"]]],
  ["电影院", "diànyǐngyuàn", "dianyingyuan", "cinema", [["diàn"], ["yǐng"], ["yuàn"]]],
] as const;

export function createDemoDeck(id: DeckId): RuntimeDeck {
  const level = Number(id.at(-1));
  const words: RuntimeWord[] = vocabulary.map(([hanzi, pinyin, accepted, meaning, pinyinSegments], index) => ({
    id: `${id}-demo-${index.toString().padStart(3, "0")}`, sourceGuids: [], displayHanzi: hanzi, hanziKey: hanzi,
    displayPinyin: pinyin, acceptedPinyin: [accepted], pinyinSegments: pinyinSegments.map((group) => [...group]),
    partOfSpeech: null, partOfSpeechKey: null, senseLabel: null,
    meaning, meaningKey: `meaning-${index}`, audioUrl: "",
  }));
  const meaningIndex = Object.fromEntries(words.map((word) => [word.meaningKey, { label: word.meaning, wordIds: [word.id], hanziKeys: [word.hanziKey], partOfSpeechKeys: [] }]));
  return { schemaVersion: 1, importerVersion: "demo-2", id, hskLevel: level, title: `HSK ${level}`,
    fingerprint: `${id}-bundled-demo-2`, source: { sharedId: 0, url: "", packageSha256: "", sourceNoteCount: words.length, logicalWordCount: words.length },
    curriculum: curriculumFromWordIds(words.map((word) => word.id), "demo-2"),
    words, meaningIndex, meaningKeysByPartOfSpeech: {}, allMeaningKeys: words.map((word) => word.meaningKey),
  };
}
