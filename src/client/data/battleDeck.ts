import { DECK_IDS, type DeckId } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { curriculumFromWordIds } from "../../domain/learning";

/** Builds the runtime-only merged corpus deck for Battle Mode from every
 * loaded source deck.
 *
 * Membership is the FULL corpus (not just current vocab rows): live pool
 * selection picks spawn targets from the vocab snapshot, and the refill
 * appends unseen curriculum entries at any time — a deck restricted to the
 * launch-time vocab could not resolve those late words into enemies. Words
 * keep their card ID as the deck identity, so a vocab `card_id` maps 1:1 to
 * `deck.words[i].id`. A card ID appearing in more than one source deck
 * (duplicate curriculum entries) collapses to its EARLIEST deck, matching
 * the curriculum's duplicate-collapse rule.
 *
 * Distractor pools are merged from every source deck under grade-namespaced
 * keys (`deckId:meaningKey` etc.) so cross-grade collisions stay impossible;
 * member words carry the same namespacing on their meaning/hanzi keys so
 * choice generation can find them in the merged index. */
export function createBattleDeck(
  decks: ReadonlyMap<DeckId, RuntimeDeck>,
): { deck: RuntimeDeck } {
  const words: RuntimeWord[] = [];
  const seenCardIds = new Set<string>();
  const meaningIndex: RuntimeDeck["meaningIndex"] = {};
  const meaningKeysByPartOfSpeech: RuntimeDeck["meaningKeysByPartOfSpeech"] = {};
  const allMeaningKeys = new Set<string>();

  // Merge every source deck's distractor pools under namespaced keys.
  for (const [deckId, source] of decks) {
    for (const [meaningKey, entry] of Object.entries(source.meaningIndex)) {
      const namespaced = `${deckId}:${meaningKey}`;
      meaningIndex[namespaced] = {
        label: entry.label,
        wordIds: entry.wordIds.map((wordId) => `${deckId}:${wordId}`),
        hanziKeys: entry.hanziKeys.map((hanziKey) => `${deckId}:${hanziKey}`),
        partOfSpeechKeys: entry.partOfSpeechKeys.map((posKey) => `${deckId}:${posKey}`),
      };
      allMeaningKeys.add(namespaced);
    }
    for (const [posKey, meaningKeys] of Object.entries(source.meaningKeysByPartOfSpeech)) {
      const namespaced = `${deckId}:${posKey}`;
      const merged = meaningKeysByPartOfSpeech[namespaced] ?? [];
      for (const meaningKey of meaningKeys) merged.push(`${deckId}:${meaningKey}`);
      meaningKeysByPartOfSpeech[namespaced] = merged;
    }
  }

  // Corpus membership in DECK_IDS (= curriculum) order; duplicate card IDs
  // collapse to their earliest occurrence.
  for (const deckId of DECK_IDS) {
    const source = decks.get(deckId);
    if (!source) continue;
    for (const word of source.words) {
      if (seenCardIds.has(word.id)) continue;
      seenCardIds.add(word.id);
      const audioUrl = word.audioUrl
        ? word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deckId}/${word.audioUrl}`
        : "";
      words.push({
        ...word,
        sourceGuids: word.sourceGuids.map((guid) => `${deckId}:${guid}`),
        hanziKey: `${deckId}:${word.hanziKey}`,
        meaningKey: `${deckId}:${word.meaningKey}`,
        partOfSpeechKey: word.partOfSpeechKey ? `${deckId}:${word.partOfSpeechKey}` : null,
        audioUrl,
      });
    }
  }

  const fingerprint = DECK_IDS
    .filter((id) => decks.has(id))
    .map((id) => `${id}:${decks.get(id)!.fingerprint}`)
    .join("|");
  return {
    deck: {
      schemaVersion: 1,
      importerVersion: "battle-v1",
      id: "hsk-1",
      hskLevel: 1,
      title: "Battle Corpus",
      fingerprint,
      source: { sharedId: 0, url: "local://battle", packageSha256: fingerprint, sourceNoteCount: words.length, logicalWordCount: words.length },
      curriculum: curriculumFromWordIds(words.map((word) => word.id), "battle-v1"),
      words,
      meaningIndex,
      meaningKeysByPartOfSpeech,
      allMeaningKeys: [...allMeaningKeys],
    },
  };
}
