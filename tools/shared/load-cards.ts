import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { AcardSchema, type Acard } from "./acard";

/** Typed failure for reading the `cards/` tree. */
export class CardLoadError extends Data.TaggedError("CardLoadError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

export type LoadedCard = { relative: string; filename: string; card: Acard };

/** Reads one grade's `.acard` files, newest schema enforced, sorted by stable
 * id so downstream output is deterministic regardless of directory order. */
export const loadGradeCards = (
  cardsRoot: string,
  deckId: string,
): Effect.Effect<LoadedCard[], CardLoadError, never> =>
  Effect.gen(function* () {
    const directory = join(cardsRoot, deckId);
    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (error) => new CardLoadError({ detail: `Cannot read ${directory}: ${String(error)}` }),
    });
    const loaded: LoadedCard[] = [];
    for (const filename of names.filter((name) => name.endsWith(".acard")).sort()) {
      const text = yield* Effect.tryPromise({
        try: () => readFile(join(directory, filename), "utf8"),
        catch: (error) => new CardLoadError({ detail: `Cannot read ${deckId}/${filename}: ${String(error)}` }),
      });
      const parsed = AcardSchema.safeParse(
        yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) => new CardLoadError({ detail: `${deckId}/${filename}: invalid JSON (${String(error)})` }),
        }),
      );
      if (!parsed.success) {
        return yield* Effect.fail(new CardLoadError({
          detail: `${deckId}/${filename}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        }));
      }
      loaded.push({ relative: `${deckId}/${filename}`, filename, card: parsed.data });
    }
    return loaded.sort((left, right) => left.card.id.localeCompare(right.card.id));
  });
