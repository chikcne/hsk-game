export const ANKI_FIELD_NAMES = [
  "Hanzi",
  "Pinyin",
  "Part of Speech",
  "Meaning",
  "SentenceHanzi",
  "SentencePinyin",
  "SentenceMeaning",
  "AudioHanzi",
  "AudioSentence",
  "Image",
] as const;

export type RawNoteFields = {
  hanzi: string;
  pinyin: string;
  partOfSpeech: string;
  meaning: string;
  sentenceHanzi: string;
  sentencePinyin: string;
  sentenceMeaning: string;
  audioHanzi: string;
  audioSentence: string;
  image: string;
};

export type RawNote = {
  id: number;
  guid: string;
  modelId: number;
  fields: RawNoteFields;
};

export type RawCollection = {
  notes: RawNote[];
  noteCount: number;
  cardCount: number;
};

export type MediaIndex = {
  memberByFilename: Map<string, string>;
  filenameByMember: Map<string, string>;
};
