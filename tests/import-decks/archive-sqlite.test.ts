import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseMediaMap, parseSoundReference, readMediaMap } from "../../tools/import-decks/archive/media";
import { extractArchiveEssentials, sha256File } from "../../tools/import-decks/archive/zip";
import { ANKI_FIELD_NAMES } from "../../tools/import-decks/raw-types";
import { readCollection } from "../../tools/import-decks/sqlite/read-collection";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function collectionFixture(fieldNames: readonly string[] = ANKI_FIELD_NAMES): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hsk-sqlite-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "collection.anki21");
  const db = new Database(path);
  db.exec("CREATE TABLE col (models TEXT NOT NULL); CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, flds TEXT); CREATE TABLE cards (id INTEGER PRIMARY KEY);");
  const model = { "7": { id: 7, name: "fixture", flds: fieldNames.map((name, ord) => ({ name, ord })) } };
  db.prepare("INSERT INTO col (models) VALUES (?)").run(JSON.stringify(model));
  const insert = db.prepare("INSERT INTO notes (id, guid, mid, flds) VALUES (?, ?, 7, ?)");
  insert.run(20, "later", Array.from({ length: 10 }, (_, index) => `b${index}`).join("\x1f"));
  insert.run(10, "earlier", Array.from({ length: 10 }, (_, index) => `a${index}`).join("\x1f"));
  db.prepare("INSERT INTO cards (id) VALUES (1)").run();
  db.close();
  return path;
}

describe("APKG boundary validation", () => {
  it("builds a safe bidirectional media index and parses one sound token", () => {
    const media = parseMediaMap({ "0": "word.mp3", "12": "image.jpg" });
    expect(media.memberByFilename.get("word.mp3")).toBe("0");
    expect(media.filenameByMember.get("12")).toBe("image.jpg");
    expect(parseSoundReference(" [sound:word.mp3] ")).toBe("word.mp3");
    expect(() => parseSoundReference("[sound:a.mp3][sound:b.mp3]")).toThrow(/exactly one/u);
    expect(() => parseMediaMap({ "../0": "word.mp3" })).toThrow(/Unsafe media member/u);
    expect(() => parseMediaMap({ "0": "../word.mp3" })).toThrow(/Unsafe media filename/u);
  });

  it("reads notes in stable ID order from a read-only collection", async () => {
    const collection = readCollection(await collectionFixture());
    expect(collection.notes.map((note) => note.guid)).toEqual(["earlier", "later"]);
    expect(collection.notes[0]?.fields.hanzi).toBe("a0");
    expect(collection).toMatchObject({ noteCount: 2, cardCount: 1 });
  });

  it("lazily extracts only collection and media from a real small source package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hsk-apkg-test-"));
    temporaryDirectories.push(directory);
    const apkg = resolve("decks/hsk-2-1488171715.apkg");
    expect(await sha256File(apkg)).toBe("9c8fad18ad8ea5eed3ee897f72d7ffcb2c32e5f7f6200e771d8598154c524e8e");
    const extracted = await extractArchiveEssentials(apkg, directory);
    expect(readCollection(extracted.collectionPath)).toMatchObject({ noteCount: 200, cardCount: 600 });
    expect((await readMediaMap(extracted.mediaPath)).filenameByMember.size).toBe(597);
  });

  it("blocks an unexpected note model", async () => {
    const wrong: string[] = [...ANKI_FIELD_NAMES];
    wrong[3] = "Gloss";
    expect(() => readCollection("not-created")).toThrow();
    const path = await collectionFixture(wrong);
    expect(() => readCollection(path)).toThrow(/Unexpected fields/u);
  });
});
