import type { DeckId } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";

const vocabulary = [
  ["学习", "xuéxí", "xuexi", "to study; to learn"], ["学校", "xuéxiào", "xuexiao", "school"], ["朋友", "péngyou", "pengyou", "friend"], ["爱", "ài", "ai", "to love"],
  ["水", "shuǐ", "shui", "water"], ["你好", "nǐhǎo", "nihao", "hello"], ["中国", "Zhōngguó", "zhongguo", "China"], ["老师", "lǎoshī", "laoshi", "teacher"],
  ["学生", "xuésheng", "xuesheng", "student"], ["谢谢", "xièxie", "xiexie", "thank you"], ["再见", "zàijiàn", "zaijian", "goodbye"], ["请", "qǐng", "qing", "please; to invite"],
  ["吃", "chī", "chi", "to eat"], ["喝", "hē", "he", "to drink"], ["看", "kàn", "kan", "to look; to watch"], ["听", "tīng", "ting", "to listen"],
  ["说", "shuō", "shuo", "to speak"], ["写", "xiě", "xie", "to write"], ["读", "dú", "du", "to read"], ["工作", "gōngzuò", "gongzuo", "to work; job"],
  ["今天", "jīntiān", "jintian", "today"], ["明天", "míngtiān", "mingtian", "tomorrow"], ["昨天", "zuótiān", "zuotian", "yesterday"], ["现在", "xiànzài", "xianzai", "now"],
  ["时候", "shíhou", "shihou", "time; moment"], ["认识", "rènshi", "renshi", "to know; to recognize"], ["准备", "zhǔnbèi", "zhunbei", "to prepare"], ["问题", "wèntí", "wenti", "question; problem"],
  ["帮助", "bāngzhù", "bangzhu", "to help"], ["喜欢", "xǐhuan", "xihuan", "to like"], ["漂亮", "piàoliang", "piaoliang", "beautiful"], ["高兴", "gāoxìng", "gaoxing", "happy"],
  ["天气", "tiānqì", "tianqi", "weather"], ["医院", "yīyuàn", "yiyuan", "hospital"], ["商店", "shāngdiàn", "shangdian", "shop; store"], ["电脑", "diànnǎo", "diannao", "computer"],
  ["电影", "diànyǐng", "dianying", "movie"], ["名字", "míngzi", "mingzi", "name"], ["什么", "shénme", "shenme", "what"], ["怎么", "zěnme", "zenme", "how"],
] as const;

export function createDemoDeck(id: DeckId): RuntimeDeck {
  const level = Number(id.at(-1));
  const words: RuntimeWord[] = vocabulary.map(([hanzi, pinyin, accepted, meaning], index) => ({
    id: `${id}-demo-${index.toString().padStart(3, "0")}`, sourceGuids: [], displayHanzi: hanzi, hanziKey: hanzi,
    displayPinyin: pinyin, acceptedPinyin: [accepted], partOfSpeech: null, partOfSpeechKey: null, senseLabel: null,
    meaning, meaningKey: `meaning-${index}`, audioUrl: "",
  }));
  const meaningIndex = Object.fromEntries(words.map((word) => [word.meaningKey, { label: word.meaning, wordIds: [word.id], hanziKeys: [word.hanziKey], partOfSpeechKeys: [] }]));
  return { schemaVersion: 1, importerVersion: "demo-1", id, hskLevel: level, title: `HSK ${level}`,
    fingerprint: `${id}-bundled-demo`, source: { sharedId: 0, url: "", packageSha256: "", sourceNoteCount: words.length, logicalWordCount: words.length },
    words, meaningIndex, meaningKeysByPartOfSpeech: {}, allMeaningKeys: words.map((word) => word.meaningKey),
  };
}
