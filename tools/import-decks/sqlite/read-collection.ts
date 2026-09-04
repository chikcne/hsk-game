import Database from "better-sqlite3";
import { Context, Data, Effect, Layer } from "effect";
import { ANKI_FIELD_NAMES, type RawCollection, type RawNote, type RawNoteFields } from "../raw-types";

type ModelField = { name?: unknown; ord?: unknown };
type Model = { id?: unknown; name?: unknown; flds?: unknown };
type NoteRow = { id: number; guid: string; mid: number; flds: string };

/** Typed failure for every granular problem while reading an Anki collection:
 * SQLite driver errors, malformed model metadata, and invalid note rows. */
export class CollectionReadError extends Data.TaggedError("CollectionReadError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure surfaced to callers: granular read errors are wrapped with the
 * historical "Could not read Anki SQLite collection" prefix. */
export class CollectionError extends Data.TaggedError("CollectionError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const decodeDriverError = (error: unknown): CollectionReadError =>
  new CollectionReadError({ detail: error instanceof Error ? error.message : String(error) });

function fieldsFromArray(fields: string[]): RawNoteFields {
  return {
    hanzi: fields[0]!, pinyin: fields[1]!, partOfSpeech: fields[2]!, meaning: fields[3]!,
    sentenceHanzi: fields[4]!, sentencePinyin: fields[5]!, sentenceMeaning: fields[6]!,
    audioHanzi: fields[7]!, audioSentence: fields[8]!, image: fields[9]!,
  };
}

const validateModel = (modelId: number, model: Model | undefined): Effect.Effect<void, CollectionReadError, never> => {
  if (!model || !Array.isArray(model.flds)) {
    return Effect.fail(new CollectionReadError({ detail: `Note model ${modelId} is missing or has no fields` }));
  }
  const ordered = (model.flds as ModelField[]).map((field, index) => ({
    name: field.name,
    ord: typeof field.ord === "number" ? field.ord : index,
  })).sort((a, b) => a.ord - b.ord);
  const names = ordered.map((field) => field.name);
  if (names.length !== ANKI_FIELD_NAMES.length || names.some((name, index) => name !== ANKI_FIELD_NAMES[index])) {
    return Effect.fail(new CollectionReadError({
      detail: `Unexpected fields for note model ${modelId}: ${names.map(String).join(" | ")}`,
    }));
  }
  return Effect.void;
};

const noteFromRow = (row: NoteRow): Effect.Effect<RawNote, CollectionReadError, never> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(row.id) || typeof row.guid !== "string" || !row.guid) {
      return yield* Effect.fail(new CollectionReadError({ detail: `Invalid note identity at ${String(row.id)}` }));
    }
    const fields = row.flds.split("\x1f");
    if (fields.length !== ANKI_FIELD_NAMES.length) {
      return yield* Effect.fail(new CollectionReadError({
        detail: `Note ${row.id} has ${fields.length} fields; expected ${ANKI_FIELD_NAMES.length}`,
      }));
    }
    return { id: row.id, guid: row.guid, modelId: row.mid, fields: fieldsFromArray(fields) };
  });

/** Opens the collection read-only, reads model metadata plus ordered note rows,
 * and always closes the database handle via the scoped finalizer. */
const withDatabase = <A>(
  path: string,
  use: (db: Database.Database) => Effect.Effect<A, CollectionReadError, never>,
): Effect.Effect<A, CollectionReadError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Database(path, { readonly: true, fileMustExist: true }),
          catch: decodeDriverError,
        }),
        (db) => Effect.sync(() => db.close()),
      );
      yield* Effect.sync(() => db.pragma("query_only = ON"));
      return yield* use(db);
    }),
  );

/** Reads the full Anki collection (models validated, notes in stable ID order). */
export const readCollectionEffect = (path: string): Effect.Effect<RawCollection, CollectionError, never> =>
  Effect.mapError(
    withDatabase(path, (db) =>
      Effect.gen(function* () {
        const col = yield* Effect.try({
          try: () => db.prepare("SELECT models FROM col LIMIT 1").get() as { models?: unknown } | undefined,
          catch: decodeDriverError,
        });
        if (!col || typeof col.models !== "string") {
          return yield* Effect.fail(new CollectionReadError({ detail: "Anki collection has no model metadata" }));
        }
        const modelsSource = col.models;
        const modelsValue: unknown = yield* Effect.try({
          try: () => JSON.parse(modelsSource),
          catch: decodeDriverError,
        });
        if (!modelsValue || typeof modelsValue !== "object" || Array.isArray(modelsValue)) {
          return yield* Effect.fail(new CollectionReadError({ detail: "Anki model metadata is malformed" }));
        }
        const models = modelsValue as Record<string, Model>;
        const rows = yield* Effect.try({
          try: () => db.prepare("SELECT id, guid, mid, flds FROM notes ORDER BY id ASC").all() as NoteRow[],
          catch: decodeDriverError,
        });
        const usedModels = new Set(rows.map((row) => row.mid));
        for (const modelId of usedModels) yield* validateModel(modelId, models[String(modelId)]);
        const notes = yield* Effect.forEach(rows, noteFromRow, { concurrency: 1 });
        const cardCount = yield* Effect.try({
          try: () => (db.prepare("SELECT COUNT(*) AS count FROM cards").get() as { count: number }).count,
          catch: decodeDriverError,
        });
        return { notes, noteCount: notes.length, cardCount };
      }),
    ),
    (error) => new CollectionError({ detail: `Could not read Anki SQLite collection: ${error.detail}` }),
  );

/** Capability service for the Anki SQLite collection dependency. */
export class AnkiDatabase extends Context.Tag("ziduoduo.tools.import-decks.AnkiDatabase")<
  AnkiDatabase,
  { readonly readCollection: (path: string) => Effect.Effect<RawCollection, CollectionError, never> }
>() {
  static readonly layer: Layer.Layer<AnkiDatabase> = Layer.succeed(AnkiDatabase, {
    readCollection: readCollectionEffect,
  });
}

// --- compatibility boundary ---------------------------------------------------
// The original module API was sync-throwing and is preserved for the test suite.

/** Synchronous boundary: throws the typed `CollectionError` on failure. */
export function readCollection(path: string): RawCollection {
  return Effect.runSync(readCollectionEffect(path));
}
