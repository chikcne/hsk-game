import type { DeckId } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { reviewWordIdOf } from "../../domain/review";

/** Builds one runtime-only merged deck from an explicit cross-grade key
 * list (`"deckId:wordId"`, the `acquired_words` identity).
 *
 * Review Mode passes exactly `save.acquiredWords` — membership is the
 * acquisition log alone, so a word stays reviewable even if its main FSRS
 * card later changes state (lapses, gets rescheduled, …). Relearn passes
 * the active session's selected keys.
 *
 * The deck is presentation data only — the caller decides what actually
 * spawns. IDs and indexes are scoped by grade so identical source
 * IDs/meanings cannot collide. Keys whose word is missing from the loaded
 * decks (e.g. removed by a deck update) are skipped.
 *
 * Distractor pools, however, are merged from EVERY loaded source deck, not
 * just the selected words: with a small acquired pool (a one-word pool on
 * day one) the meaning phase still needs eight non-colliding shortcut keys,
 * and generateChoices throws when the pool cannot supply them. All merged
 * keys are namespaced by grade (`deckId:…`), including hanzi and
 * part-of-speech keys, so cross-grade collisions stay impossible. */
export function createReviewDeck(
  decks: ReadonlyMap<DeckId, RuntimeDeck>,
  wordKeys: readonly string[],
  options: { title?: string } = {},
): { deck: RuntimeDeck } {
  const words: RuntimeWord[] = [];
  const meaningIndex: RuntimeDeck["meaningIndex"] = {};
  const meaningKeysByPartOfSpeech: RuntimeDeck["meaningKeysByPartOfSpeech"] = {};
  const allMeaningKeys = new Set<string>();

  // Merge every source deck's distractor pools under namespaced keys. This
  // runs first so a selected word's own meaning key is guaranteed present
  // even when its word record were somehow skipped below.
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

  for (const key of wordKeys) {
    const { deckId, wordId } = reviewWordIdOf(key);
    const source = decks.get(deckId as DeckId);
    const word = source?.words.find((item) => item.id === wordId);
    if (!source || !word) continue;
    const meaningKey = `${deckId}:${word.meaningKey}`;
    const partOfSpeechKey = word.partOfSpeechKey ? `${deckId}:${word.partOfSpeechKey}` : null;
    const audioUrl = word.audioUrl
      ? word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deckId}/${word.audioUrl}`
      : "";
    words.push({
      ...word,
      id: key,
      sourceGuids: word.sourceGuids.map((guid) => `${deckId}:${guid}`),
      hanziKey: `${deckId}:${word.hanziKey}`,
      meaningKey,
      partOfSpeechKey,
      audioUrl,
    });
  }

  const fingerprint = [...decks.entries()].map(([id, deck]) => `${id}:${deck.fingerprint}`).join("|");
  return {
    deck: {
      schemaVersion: 1,
      importerVersion: "review-v4",
      id: "hsk-1",
      hskLevel: 1,
      title: options.title ?? "Mastery Review",
      fingerprint,
      source: { sharedId: 0, url: "local://review", packageSha256: fingerprint, sourceNoteCount: words.length, logicalWordCount: words.length },
      words,
      meaningIndex,
      meaningKeysByPartOfSpeech,
      allMeaningKeys: [...allMeaningKeys],
    },
  };
}
