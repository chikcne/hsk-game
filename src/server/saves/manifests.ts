import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema } from "../../shared/schemas";

export type DeckManifest = {
  fingerprint: string;
  wordIds: ReadonlySet<string>;
};

export type DeckCatalog = ReadonlyMap<DeckId, DeckManifest>;

/**
 * Loads generated deck metadata when available. Missing decks are tolerated so
 * the health/save server can boot before the optional import step in tests and
 * development. A present but invalid deck is an operator error and is rejected.
 */
export async function loadDeckCatalog(gameDataDirectory: string): Promise<DeckCatalog> {
  const catalog = new Map<DeckId, DeckManifest>();

  for (const deckId of DECK_IDS) {
    const path = join(gameDataDirectory, deckId, "deck.json");
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new Error(`Generated deck is not valid JSON: ${path}`, { cause: error });
    }
    const deck = RuntimeDeckSchema.parse(raw);
    if (deck.id !== deckId) {
      throw new Error(`Generated deck ID ${deck.id} does not match directory ${deckId}`);
    }
    catalog.set(deckId, {
      fingerprint: deck.fingerprint,
      wordIds: new Set(deck.words.map((word) => word.id)),
    });
  }

  return catalog;
}
