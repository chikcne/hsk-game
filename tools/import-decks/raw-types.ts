/** The full note-model field list, in order. Kept complete because it is the
 * shape check on the source packages: a deck whose model drifts must fail the
 * import rather than silently misalign the field indices below. The sentence
 * fields are validated here and deliberately never extracted — see
 * `designs/resorting/acard_structure.md` §4.3 for why. */
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

/** Only the fields the game uses. `SentenceHanzi`, `SentencePinyin`,
 * `SentenceMeaning` and `AudioSentence` are intentionally absent: the source
 * decks' licence excludes the sentences from its grant, so they must not reach
 * any generated artifact. Omitting them from the type keeps that structural
 * rather than a rule someone has to remember downstream. */
export type RawNoteFields = {
  hanzi: string;
  pinyin: string;
  partOfSpeech: string;
  meaning: string;
  audioHanzi: string;
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
