import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";

import { Curriculum } from "../../src/server/saves/curriculum";
import { BattleSaveRepository, SaveDatabaseError } from "../../src/server/saves/repository";
import {
  TEST_BATTLE_CONFIG,
  cleanupDirectories,
  fastGraduationConfig,
  fixedClock,
  fixtureCardId,
  temporaryDirectory,
  writeCurriculumFixture,
} from "./helpers";

afterEach(cleanupDirectories);

type TableInfo = Array<{ name: string; type: string; notnull: number; pk: number }>;

function openRaw(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

function tableInfo(db: Database.Database, table: string): TableInfo {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfo).map(
    ({ name, type, notnull, pk }) => ({ name, type, notnull, pk }),
  );
}

async function makeRepository(options: Partial<ConstructorParameters<typeof BattleSaveRepository>[0]> & {
  curriculumCount?: number;
} = {}) {
  const directory = await temporaryDirectory();
  const fixture = await writeCurriculumFixture(options.curriculumCount ?? 8);
  const curriculum = Curriculum.load(fixture.path);
  const repository = new BattleSaveRepository({
    directory,
    curriculum,
    battleConfig: options.battleConfig ?? TEST_BATTLE_CONFIG,
    now: options.now,
  });
  return { directory, savePath: join(directory, "default.sql"), fixture, curriculum, repository };
}

describe("BattleSaveRepository schema", () => {
  it("creates saves/default.sql with the exact approved vocab and settings tables", async () => {
    const { repository, savePath } = await makeRepository();
    expect(existsSync(savePath)).toBe(true);
    repository.close();

    const db = openRaw(savePath);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["settings", "vocab"]);

    expect(tableInfo(db, "vocab")).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "card_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "mastery", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "time_added", type: "DATETIME", notnull: 1, pk: 0 },
      { name: "time_mastered", type: "DATETIME", notnull: 0, pk: 0 },
    ]);
    expect(tableInfo(db, "settings")).toEqual([
      { name: "key", type: "TEXT", notnull: 0, pk: 1 },
      { name: "value", type: "TEXT", notnull: 1, pk: 0 },
    ]);

    const indexes = db.prepare("PRAGMA index_list(vocab)").all() as Array<{ name: string; unique: number }>;
    const uniqueIndex = indexes.find((index) => index.unique);
    expect(uniqueIndex).toBeDefined();
    const indexColumns = db.prepare(`PRAGMA index_info(${uniqueIndex!.name})`).all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual(["card_id"]);

    const settingsRows = db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
    expect(settingsRows.map((row) => row.key)).toEqual([...Object.keys(DEFAULT_SETTINGS)].sort());
    db.close();
  });

  it("enforces integral, range-checked mastery and the card_id UNIQUE constraint", async () => {
    const { repository, savePath, fixture } = await makeRepository();
    repository.close();

    const db = new Database(savePath);
    expect(() =>
      db.prepare("INSERT INTO vocab (id, card_id, mastery, time_added) VALUES (1, ?, 101, '2026-01-01T00:00:00.000Z')")
        .run(fixture.cardIds[0]!),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare("INSERT INTO vocab (id, card_id, mastery, time_added) VALUES (1, ?, -1, '2026-01-01T00:00:00.000Z')")
        .run(fixture.cardIds[1]!),
    ).toThrow(/CHECK/i);
    // SQLite's dynamic typing: a REAL mastery must be rejected by the typeof
    // guard, not silently stored as 1.5.
    expect(() =>
      db.prepare("INSERT INTO vocab (id, card_id, mastery, time_added) VALUES (1, ?, 1.5, '2026-01-01T00:00:00.000Z')")
        .run(fixture.cardIds[1]!),
    ).toThrow(/CHECK/i);
    db.prepare("INSERT INTO vocab (id, card_id, mastery, time_added) VALUES (1, ?, 0, '2026-01-01T00:00:00.000Z')")
      .run(fixture.cardIds[0]!);
    expect(() =>
      db.prepare("INSERT INTO vocab (id, card_id, mastery, time_added) VALUES (2, ?, 0, '2026-01-01T00:00:00.000Z')")
        .run(fixture.cardIds[0]!),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("fails loudly when the mastery CHECK is missing, weakened, or widened", async () => {
    const fixture = await writeCurriculumFixture(8);
    const settings = "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

    // Identical five columns and unique index, but no CHECK at all.
    const missingCheck = await temporaryDirectory();
    const missingCheckDb = new Database(join(missingCheck, "default.sql"));
    missingCheckDb.exec(settings);
    missingCheckDb.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, mastery INTEGER NOT NULL, time_added DATETIME NOT NULL, time_mastered DATETIME)");
    missingCheckDb.close();
    expect(() => new BattleSaveRepository({
      directory: missingCheck,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/CREATE TABLE contract/i);

    // Range-only CHECK: REAL masteries such as 1.5 would pass.
    const weakCheck = await temporaryDirectory();
    const weakCheckDb = new Database(join(weakCheck, "default.sql"));
    weakCheckDb.exec(settings);
    weakCheckDb.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, mastery INTEGER NOT NULL CHECK (mastery BETWEEN 0 AND 100), time_added DATETIME NOT NULL, time_mastered DATETIME)");
    weakCheckDb.close();
    expect(() => new BattleSaveRepository({
      directory: weakCheck,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/CREATE TABLE contract/i);

    // Correct typeof guard but a widened bound.
    const widenedBound = await temporaryDirectory();
    const widenedDb = new Database(join(widenedBound, "default.sql"));
    widenedDb.exec(settings);
    widenedDb.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, mastery INTEGER NOT NULL CHECK (typeof(mastery) = 'integer' AND mastery BETWEEN 0 AND 200), time_added DATETIME NOT NULL, time_mastered DATETIME)");
    widenedDb.close();
    expect(() => new BattleSaveRepository({
      directory: widenedBound,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/CREATE TABLE contract/i);
  });

  it("fails loudly on an existing incompatible database", async () => {
    const directory = await temporaryDirectory();
    const savePath = join(directory, "default.sql");
    await writeFile(savePath, "this is not a sqlite database");
    const fixture = await writeCurriculumFixture(8);
    expect(() => new BattleSaveRepository({
      directory,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(SaveDatabaseError);

    const directory2 = await temporaryDirectory();
    const savePath2 = join(directory2, "default.sql");
    const wrongColumns = new Database(savePath2);
    wrongColumns.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    wrongColumns.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT, mastery INTEGER)");
    wrongColumns.close();
    expect(() => new BattleSaveRepository({
      directory: directory2,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/exactly 5 columns/);

    const directory4 = await temporaryDirectory();
    const savePath4 = join(directory4, "default.sql");
    const wrongConstraints = new Database(savePath4);
    wrongConstraints.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    wrongConstraints.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL, mastery INTEGER NOT NULL, time_added DATETIME NOT NULL, time_mastered DATETIME)");
    wrongConstraints.close();
    expect(() => new BattleSaveRepository({
      directory: directory4,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/card_id|UNIQUE/i);

    const directory3 = await temporaryDirectory();
    const savePath3 = join(directory3, "default.sql");
    const missingTable = new Database(savePath3);
    missingTable.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, mastery INTEGER NOT NULL CHECK (mastery >= 0 AND mastery <= 100), time_added DATETIME NOT NULL, time_mastered DATETIME)");
    missingTable.close();
    expect(() => new BattleSaveRepository({
      directory: directory3,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    })).toThrow(/exactly the vocab and settings tables/);
  });
});

describe("BattleSaveRepository state", () => {
  it("first run initializes default settings and an empty vocab", async () => {
    const { repository } = await makeRepository();
    const state = repository.getState();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.vocab).toEqual([]);
    expect(state.battleConfig).toEqual(TEST_BATTLE_CONFIG);
    repository.close();
  });

  it("roundtrips settings and persists them across repository instances", async () => {
    const { repository, directory, fixture } = await makeRepository();
    const next = { ...DEFAULT_SETTINGS, spawnIntervalMs: 2500, enemySpeedMultiplier: 1.2, masterVolume: 0.25, reducedMotion: true };
    expect(repository.updateSettings(next)).toEqual(next);
    repository.close();

    const reopened = new BattleSaveRepository({
      directory,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
    });
    expect(reopened.getState().settings).toEqual(next);
    reopened.close();
  });

  it("rejects invalid settings instead of persisting them", async () => {
    const { repository } = await makeRepository();
    expect(() => repository.updateSettings({ ...DEFAULT_SETTINGS, spawnIntervalMs: 10 })).toThrow(z.ZodError);
    expect(() => repository.updateSettings({ ...DEFAULT_SETTINGS, surprise: true })).toThrow(z.ZodError);
    repository.close();
  });
});

describe("BattleSaveRepository battle open", () => {
  it("seeds curriculum positions 1..5 at mastery 0 in strict order", async () => {
    const { repository, fixture } = await makeRepository({
      curriculumCount: 8,
      now: fixedClock("2026-09-09T01:00:00.000Z"),
    });
    const opened = repository.openBattle();
    expect(opened.addedRows).toHaveLength(5);
    expect(opened.addedRows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(opened.addedRows.map((row) => row.cardId)).toEqual(fixture.cardIds.slice(0, 5));
    expect(opened.vocab).toHaveLength(5);
    for (const row of opened.vocab) {
      expect(row.mastery).toBe(0);
      expect(row.timeAdded).toBe("2026-09-09T01:00:00.000Z");
      expect(row.timeMastered).toBeNull();
    }

    const reopened = repository.openBattle();
    expect(reopened.addedRows).toEqual([]);
    expect(reopened.vocab.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    repository.close();
  });

  it("seeds only what a shorter curriculum offers", async () => {
    const { repository } = await makeRepository({ curriculumCount: 3 });
    const opened = repository.openBattle();
    expect(opened.addedRows.map((row) => row.id)).toEqual([1, 2, 3]);
    repository.close();
  });
});

describe("BattleSaveRepository outcomes", () => {
  it("applies +10 for clean correct and -10 for a miss, clamped to 0..100", async () => {
    const { repository, fixture } = await makeRepository({ now: fixedClock("2026-09-09T02:00:00.000Z") });
    repository.openBattle();
    const cardId = fixture.cardIds[0]!;

    expect(repository.applyOutcome(cardId, true)!.row.mastery).toBe(10);
    expect(repository.applyOutcome(cardId, false)!.row.mastery).toBe(0);
    expect(repository.applyOutcome(cardId, false)!.row.mastery).toBe(0); // clamped at 0
    repository.close();
  });

  it("clamps at 100 and stamps time_mastered exactly once", async () => {
    const { repository, directory, savePath, fixture } = await makeRepository({
      now: fixedClock("2026-09-09T03:00:00.000Z"),
    });
    repository.openBattle();
    const cardId = fixture.cardIds[0]!;
    repository.close();

    const db = new Database(savePath);
    db.prepare("UPDATE vocab SET mastery = 95 WHERE card_id = ?").run(cardId);
    db.close();

    const resumed = new BattleSaveRepository({
      directory,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: TEST_BATTLE_CONFIG,
      now: fixedClock(
        "2026-09-09T04:00:00.000Z", // 95 -> 100
        "2026-09-09T05:00:00.000Z", // 100 -> 90 (miss keeps the stamp)
        "2026-09-09T06:00:00.000Z", // 90 -> 100 (stamp unchanged)
      ),
    });
    const mastered = resumed.applyOutcome(cardId, true)!.row;
    expect(mastered.mastery).toBe(100);
    expect(mastered.timeMastered).toBe("2026-09-09T04:00:00.000Z");

    const decayed = resumed.applyOutcome(cardId, false)!.row;
    expect(decayed.mastery).toBe(90);
    expect(decayed.timeMastered).toBe("2026-09-09T04:00:00.000Z"); // never cleared

    const regained = resumed.applyOutcome(cardId, true)!.row;
    expect(regained.mastery).toBe(100);
    expect(regained.timeMastered).toBe("2026-09-09T04:00:00.000Z"); // first-set only
    resumed.close();
  });

  it("never stamps time_mastered below 100", async () => {
    const { repository, fixture } = await makeRepository({ now: fixedClock("2026-09-09T02:00:00.000Z") });
    repository.openBattle();
    const row = repository.applyOutcome(fixture.cardIds[1]!, true)!.row;
    expect(row.mastery).toBe(10);
    expect(row.timeMastered).toBeNull();
    repository.close();
  });

  it("returns null for a card that is not in the vocab pool", async () => {
    const { repository, fixture } = await makeRepository({ curriculumCount: 8 });
    repository.openBattle();
    expect(repository.applyOutcome(fixture.cardIds[7]!, true)).toBeNull(); // exists in curriculum, unseen
    expect(repository.applyOutcome("ffffffffffffffffffffffff", true)).toBeNull(); // not in curriculum
    repository.close();
  });
});

describe("BattleSaveRepository learning-slot refill", () => {
  it("refills strictly in curriculum order when a slot graduates past lowMax", async () => {
    const { repository, fixture } = await makeRepository({
      curriculumCount: 8,
      now: fixedClock("2026-09-09T02:00:00.000Z"),
    });
    repository.openBattle();
    const cardId = fixture.cardIds[2]!;

    // 0 -> 10 -> 20 -> 30 -> 40 -> 50: still low, no refill.
    for (let index = 0; index < 5; index += 1) {
      expect(repository.applyOutcome(cardId, true)!.addedRows).toEqual([]);
    }
    // 50 -> 60: graduates, position 6 is appended.
    const graduated = repository.applyOutcome(cardId, true)!;
    expect(graduated.addedRows.map((row) => row.id)).toEqual([6]);
    expect(graduated.addedRows[0]!.cardId).toBe(fixture.cardIds[5]!);
    expect(graduated.addedRows[0]!.mastery).toBe(0);
    expect(graduated.addedRows[0]!.timeMastered).toBeNull();

    // A second graduation appends position 7, never reordering.
    const cardId2 = fixture.cardIds[0]!;
    for (let index = 0; index < 6; index += 1) repository.applyOutcome(cardId2, true);
    const state = repository.getState();
    expect(state.vocab.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    repository.close();
  });

  it("a miss on a low word never refills", async () => {
    const { repository, fixture } = await makeRepository({ curriculumCount: 8 });
    repository.openBattle();
    const outcome = repository.applyOutcome(fixture.cardIds[4]!, false)!;
    expect(outcome.row.mastery).toBe(0);
    expect(outcome.addedRows).toEqual([]);
    repository.close();
  });

  it("consecutive graduations append the next unseen positions one at a time", async () => {
    const { repository, fixture } = await makeRepository({ curriculumCount: 8, battleConfig: fastGraduationConfig });
    repository.openBattle();
    const first = repository.applyOutcome(fixture.cardIds[4]!, true)!;
    expect(first.addedRows.map((row) => row.id)).toEqual([6]);
    const second = repository.applyOutcome(fixture.cardIds[0]!, true)!;
    expect(second.addedRows.map((row) => row.id)).toEqual([7]);
    repository.close();
  });

  it("stops refilling when the curriculum is exhausted", async () => {
    const { repository, fixture } = await makeRepository({ curriculumCount: 6, battleConfig: fastGraduationConfig });
    repository.openBattle(); // seeds 1..5, one unseen remains
    expect(repository.applyOutcome(fixture.cardIds[0]!, true)!.addedRows.map((row) => row.id)).toEqual([6]);
    // Curriculum exhausted: graduating more slots appends nothing, never throws.
    for (const index of [1, 2, 3, 4]) {
      const outcome = repository.applyOutcome(fixture.cardIds[index]!, true)!;
      expect(outcome.addedRows).toEqual([]);
    }
    const state = repository.getState();
    expect(state.vocab).toHaveLength(6);
    repository.close();
  });

  it("a decayed pool word keeps the vocab coherent without extra seeding", async () => {
    const { repository, directory, savePath, fixture } = await makeRepository({ curriculumCount: 8, battleConfig: fastGraduationConfig });
    repository.openBattle();
    repository.applyOutcome(fixture.cardIds[0]!, true); // graduates -> refill appends 6
    repository.close();

    // A developed word decays back into the low range: now six low rows exist,
    // more than the five learning slots. No refill may fire (nothing missing).
    const db = new Database(savePath);
    db.prepare("UPDATE vocab SET mastery = 45 WHERE id = 1").run();
    db.close();

    const resumed = new BattleSaveRepository({
      directory,
      curriculum: Curriculum.load(fixture.path),
      battleConfig: fastGraduationConfig,
    });
    const opened = resumed.openBattle();
    expect(opened.addedRows).toEqual([]);
    expect(opened.vocab).toHaveLength(6);
    resumed.close();
  });
});
