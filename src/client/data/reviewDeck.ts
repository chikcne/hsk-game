import type { DeckId } from "../../shared/constants";
import type { LevelProgress, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { reviewWordKey } from "../../domain/review";

/** Builds one runtime-only deck from mastered cards. IDs and indexes are scoped
 * by grade so identical source IDs/meanings cannot collide. */
export function createReviewDeck(
  decks: ReadonlyMap<DeckId, RuntimeDeck>,
  levels: Partial<Record<DeckId, LevelProgress>>,
): { deck: RuntimeDeck; masteredWordKeys: Set<string> } {
  const words: RuntimeWord[] = [];
  const meaningIndex: RuntimeDeck["meaningIndex"] = {};
  const meaningKeysByPartOfSpeech: RuntimeDeck["meaningKeysByPartOfSpeech"] = {};
  const allMeaningKeys: string[] = [];

  for (const [deckId, source] of decks) {
    const progress = levels[deckId];
    for (const word of source.words) {
      if (progress?.words[word.id]?.phase !== "review") continue;
      const id = reviewWordKey(deckId, word.id);
      const meaningKey = `${deckId}:${word.meaningKey}`;
      const partOfSpeechKey = word.partOfSpeechKey ? `${deckId}:${word.partOfSpeechKey}` : null;
      const audioUrl = word.audioUrl
        ? word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deckId}/${word.audioUrl}`
        : "";
      words.push({
        ...word,
        id,
        sourceGuids: word.sourceGuids.map((guid) => `${deckId}:${guid}`),
        meaningKey,
        partOfSpeechKey,
        audioUrl,
      });
      const sourceMeaning = source.meaningIndex[word.meaningKey];
      meaningIndex[meaningKey] = {
        label: word.meaning,
        wordIds: [id],
        hanziKeys: sourceMeaning?.hanziKeys ?? [word.hanziKey],
        partOfSpeechKeys: partOfSpeechKey ? [partOfSpeechKey] : [],
      };
      allMeaningKeys.push(meaningKey);
      if (partOfSpeechKey) (meaningKeysByPartOfSpeech[partOfSpeechKey] ??= []).push(meaningKey);
    }
  }

  const fingerprint = [...decks.entries()].map(([id, deck]) => `${id}:${deck.fingerprint}`).join("|");
  return {
    deck: {
      schemaVersion: 1,
      importerVersion: "review-v1",
      id: "hsk-1",
      hskLevel: 1,
      title: "Mastery Review",
      fingerprint,
      source: { sharedId: 0, url: "local://review", packageSha256: fingerprint, sourceNoteCount: words.length, logicalWordCount: words.length },
      words,
      meaningIndex,
      meaningKeysByPartOfSpeech,
      allMeaningKeys,
    },
    masteredWordKeys: new Set(words.map((word) => word.id)),
  };
}
