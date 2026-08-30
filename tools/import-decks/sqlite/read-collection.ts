import Database from "better-sqlite3";
import { ANKI_FIELD_NAMES, type RawCollection, type RawNote, type RawNoteFields } from "../raw-types";

type ModelField = { name?: unknown; ord?: unknown };
type Model = { id?: unknown; name?: unknown; flds?: unknown };
type NoteRow = { id: number; guid: string; mid: number; flds: string };

function fieldsFromArray(fields: string[]): RawNoteFields {
  return {
    hanzi: fields[0]!, pinyin: fields[1]!, partOfSpeech: fields[2]!, meaning: fields[3]!,
    sentenceHanzi: fields[4]!, sentencePinyin: fields[5]!, sentenceMeaning: fields[6]!,
    audioHanzi: fields[7]!, audioSentence: fields[8]!, image: fields[9]!,
  };
}

function validateModel(modelId: number, model: Model | undefined): void {
  if (!model || !Array.isArray(model.flds)) throw new Error(`Note model ${modelId} is missing or has no fields`);
  const ordered = (model.flds as ModelField[]).map((field, index) => ({
    name: field.name,
    ord: typeof field.ord === "number" ? field.ord : index,
  })).sort((a, b) => a.ord - b.ord);
  const names = ordered.map((field) => field.name);
  if (names.length !== ANKI_FIELD_NAMES.length || names.some((name, index) => name !== ANKI_FIELD_NAMES[index])) {
    throw new Error(`Unexpected fields for note model ${modelId}: ${names.map(String).join(" | ")}`);
  }
}

export function readCollection(path: string): RawCollection {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const col = db.prepare("SELECT models FROM col LIMIT 1").get() as { models?: unknown } | undefined;
    if (!col || typeof col.models !== "string") throw new Error("Anki collection has no model metadata");
    const modelsValue: unknown = JSON.parse(col.models);
    if (!modelsValue || typeof modelsValue !== "object" || Array.isArray(modelsValue)) {
      throw new Error("Anki model metadata is malformed");
    }
    const models = modelsValue as Record<string, Model>;
    const rows = db.prepare("SELECT id, guid, mid, flds FROM notes ORDER BY id ASC").all() as NoteRow[];
    const usedModels = new Set(rows.map((row) => row.mid));
    for (const modelId of usedModels) validateModel(modelId, models[String(modelId)]);

    const notes: RawNote[] = rows.map((row) => {
      if (!Number.isSafeInteger(row.id) || typeof row.guid !== "string" || !row.guid) {
        throw new Error(`Invalid note identity at ${String(row.id)}`);
      }
      const fields = row.flds.split("\x1f");
      if (fields.length !== ANKI_FIELD_NAMES.length) {
        throw new Error(`Note ${row.id} has ${fields.length} fields; expected ${ANKI_FIELD_NAMES.length}`);
      }
      return { id: row.id, guid: row.guid, modelId: row.mid, fields: fieldsFromArray(fields) };
    });
    const cardCount = (db.prepare("SELECT COUNT(*) AS count FROM cards").get() as { count: number }).count;
    return { notes, noteCount: notes.length, cardCount };
  } catch (error) {
    throw new Error(`Could not read Anki SQLite collection: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}
