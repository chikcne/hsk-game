import { join } from "node:path";
import { Effect } from "effect";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema } from "../../shared/schemas";
import { DeckManifestError, FsError, isEnoent, normalizeError } from "../errors";
import { FileSystem } from "../filesystem";

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
export function loadDeckCatalog(
  gameDataDirectory: string,
): Effect.Effect<DeckCatalog, DeckManifestError | FsError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const catalog = new Map<DeckId, DeckManifest>();

    for (const deckId of DECK_IDS) {
      const path = join(gameDataDirectory, deckId, "deck.json");
      const source = yield* fs.readText(path).pipe(
        Effect.catchIf(isEnoent, () => Effect.succeed(null)),
      );
      if (source === null) continue;

      const raw: unknown = yield* Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: (cause) => new DeckManifestError({
          path,
          message: `Generated deck is not valid JSON: ${path}`,
          cause: normalizeError(cause),
        }),
      });
      const deck = yield* Effect.try({
        try: () => RuntimeDeckSchema.parse(raw),
        catch: (cause) => new DeckManifestError({
          path,
          message: `Generated deck does not satisfy the runtime deck schema: ${path}`,
          cause: normalizeError(cause),
        }),
      });
      if (deck.id !== deckId) {
        return yield* Effect.fail(new DeckManifestError({
          path,
          message: `Generated deck ID ${deck.id} does not match directory ${deckId}`,
        }));
      }
      catalog.set(deckId, {
        fingerprint: deck.fingerprint,
        wordIds: new Set(deck.words.map((word) => word.id)),
      });
    }

    return catalog;
  });
}
