import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Data } from "effect";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import { SettingsSchema, type DifficultySettings } from "../../shared/schemas";
import type { BattleConfig, BattleOpenResponse, VocabOutcomeResponse, VocabRow } from "../../shared/battle";
import type { Curriculum } from "./curriculum";

/**
 * The save database is missing, unreadable, or schema-incompatible. There are
 * no migrations and no legacy formats: an existing saves/default.sql that
 * does not match the expected schema exactly is a fatal operator error.
 */
export class SaveDatabaseError extends Data.TaggedError("SaveDatabaseError")<{
  readonly path: string;
  readonly message: string;
}> {
  static wrap(path: string, cause: unknown): SaveDatabaseError {
    return new SaveDatabaseError({
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

type VocabRecord = {
  id: number;
  card_id: string;
  mastery: number;
  time_added: string;
  time_mastered: string | null;
};

const VOCAB_COLUMNS = [
  { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "card_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "mastery", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "time_added", type: "DATETIME", notnull: 1, pk: 0 },
  { name: "time_mastered", type: "DATETIME", notnull: 0, pk: 0 },
] as const;

const SETTINGS_COLUMNS = [
  { name: "key", type: "TEXT", notnull: 0, pk: 1 },
  { name: "value", type: "TEXT", notnull: 1, pk: 0 },
] as const;

const CREATE_VOCAB = `
  CREATE TABLE vocab (
    id INTEGER PRIMARY KEY,
    card_id TEXT NOT NULL UNIQUE,
    mastery INTEGER NOT NULL CHECK (typeof(mastery) = 'integer' AND mastery BETWEEN 0 AND 100),
    time_added DATETIME NOT NULL,
    time_mastered DATETIME
  )
`;

const CREATE_SETTINGS = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const StrictSettingsSchema = SettingsSchema.strict();
const SETTING_KEYS = Object.keys(StrictSettingsSchema.shape);

export type BattleSaveState = {
  settings: DifficultySettings;
  vocab: VocabRow[];
  battleConfig: BattleConfig;
};

export type BattleSaveRepositoryOptions = {
  /** Directory holding default.sql. */
  directory: string;
  curriculum: Curriculum;
  battleConfig: BattleConfig;
  /** UTC clock, injectable for deterministic timestamps in tests. */
  now?: () => Date;
};

const toRow = (record: VocabRecord): VocabRow => ({
  id: record.id,
  cardId: record.card_id,
  mastery: record.mastery,
  timeAdded: record.time_added,
  timeMastered: record.time_mastered,
});

/**
 * Server-side Battle save persistence on SQLite (better-sqlite3). The binary
 * lives at `<directory>/default.sql`, created only when missing; every query
 * runs through a prepared statement and every multi-step operation (seeding,
 * outcome + refill, settings replacement) inside one transaction, so the
 * four REST endpoints are atomic with respect to concurrent requests.
 *
 * The `vocab` table is the sole mastery authority: `id` is the 1-based global
 * curriculum position, `card_id` the unique curriculum identity, `mastery`
 * spans 0..100, `time_mastered` records the first arrival at 100 and is never
 * cleared afterwards. The `settings` table holds one key/value row per
 * Battle/accessibility setting.
 */
export class BattleSaveRepository {
  readonly savePath: string;
  private readonly curriculum: Curriculum;
  private readonly battleConfig: BattleConfig;
  private readonly now: () => Date;
  private readonly db: Database.Database;

  private readonly selectAllVocab: Database.Statement;
  private readonly selectByCardId: Database.Statement;
  private readonly selectAllIds: Database.Statement;
  private readonly countLowMastery: Database.Statement;
  private readonly insertVocabRow: Database.Statement;
  private readonly updateMastery: Database.Statement;
  private readonly upsertSetting: Database.Statement;
  private readonly selectSettingKeys: Database.Statement;

  constructor(options: BattleSaveRepositoryOptions) {
    this.savePath = join(options.directory, "default.sql");
    this.curriculum = options.curriculum;
    this.battleConfig = options.battleConfig;
    this.now = options.now ?? (() => new Date());
    try {
      mkdirSync(dirname(this.savePath), { recursive: true });
      const existed = existsSync(this.savePath);
      this.db = new Database(this.savePath);
      if (existed) {
        this.verifySchema();
      } else {
        this.initialize();
      }
      this.selectAllVocab = this.db.prepare(
        "SELECT id, card_id, mastery, time_added, time_mastered FROM vocab ORDER BY id",
      );
      this.selectByCardId = this.db.prepare(
        "SELECT id, card_id, mastery, time_added, time_mastered FROM vocab WHERE card_id = ?",
      );
      this.selectAllIds = this.db.prepare("SELECT id FROM vocab");
      this.countLowMastery = this.db.prepare("SELECT COUNT(*) FROM vocab WHERE mastery <= ?");
      this.insertVocabRow = this.db.prepare(
        "INSERT INTO vocab (id, card_id, mastery, time_added, time_mastered) VALUES (?, ?, 0, ?, NULL)",
      );
      this.updateMastery = this.db.prepare(
        "UPDATE vocab SET mastery = ?, time_mastered = ? WHERE id = ?",
      );
      this.upsertSetting = this.db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      this.selectSettingKeys = this.db.prepare("SELECT key FROM settings");
    } catch (cause) {
      if (cause instanceof SaveDatabaseError) throw cause;
      throw SaveDatabaseError.wrap(this.savePath, cause);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Full authoritative state for GET /api/saves/default. */
  getState(): BattleSaveState {
    return {
      settings: this.readSettings(),
      vocab: this.readVocab(),
      battleConfig: this.battleConfig,
    };
  }

  /**
   * Battle launch: atomically restores the learning slots — on the very first
   * launch this seeds curriculum positions 1..learningSlots at mastery 0 — and
   * returns the full vocab plus exactly the rows appended by this call.
   */
  openBattle(): BattleOpenResponse {
    return this.db.transaction(() => {
      const addedRows = this.refillLearningSlots();
      return { vocab: this.readVocab(), addedRows };
    })();
  }

  /**
   * One resolved encounter. Applies the configured delta (clamped to 0..100),
   * stamps `time_mastered` the first time mastery reaches 100 (never cleared),
   * and refills the learning slots when the outcome graduates a low row past
   * `lowMax`. Returns null when `cardId` is not in the vocab table.
   */
  applyOutcome(cardId: string, cleanCorrect: boolean): VocabOutcomeResponse | null {
    return this.db.transaction((): VocabOutcomeResponse | null => {
      const record = this.selectByCardId.get(cardId) as VocabRecord | undefined;
      if (record === undefined) return null;
      const delta = cleanCorrect ? this.battleConfig.masteryDelta : -this.battleConfig.masteryDelta;
      const mastery = Math.max(0, Math.min(100, record.mastery + delta));
      const timeMastered = record.time_mastered ?? (mastery >= 100 ? this.now().toISOString() : null);
      this.updateMastery.run(mastery, timeMastered, record.id);
      return {
        row: { ...toRow(record), mastery, timeMastered },
        addedRows: this.refillLearningSlots(),
      };
    })();
  }

  /** Validates, persists, and re-reads the settings key/value rows. */
  updateSettings(input: unknown): DifficultySettings {
    const settings = StrictSettingsSchema.parse(input);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        this.upsertSetting.run(key, JSON.stringify(value));
      }
    })();
    return this.readSettings();
  }

  private readVocab(): VocabRow[] {
    return (this.selectAllVocab.all() as VocabRecord[]).map(toRow);
  }

  /**
   * Appends unseen curriculum entries — strictly in global position order —
   * until `learningSlots` rows at mastery <= lowMax exist. Must run inside a
   * transaction. Rows already present are never reordered or re-inserted; a
   * word enters exactly once, at mastery 0.
   */
  private refillLearningSlots(): VocabRow[] {
    const lowCount = (this.countLowMastery.get(this.battleConfig.boundaries.lowMax) as {
      ["COUNT(*)"]: number;
    })["COUNT(*)"];
    if (lowCount >= this.battleConfig.learningSlots) return [];

    const presentIds = new Set((this.selectAllIds.all() as Array<{ id: number }>).map((row) => row.id));
    const added: VocabRow[] = [];
    const addedAt = this.now().toISOString();
    let position = 1;
    while (presentIds.has(position)) position += 1;
    while (lowCount + added.length < this.battleConfig.learningSlots && position <= this.curriculum.size) {
      const cardId = this.curriculum.cardIdAt(position)!;
      this.insertVocabRow.run(position, cardId, addedAt);
      added.push({ id: position, cardId, mastery: 0, timeAdded: addedAt, timeMastered: null });
      position += 1;
    }
    return added;
  }

  private readSettings(): DifficultySettings {
    const storedKeys = (this.selectSettingKeys.all() as Array<{ key: string }>).map((row) => row.key);
    const expected = new Set(SETTING_KEYS);
    for (const key of storedKeys) {
      if (!expected.has(key)) {
        throw new SaveDatabaseError({ path: this.savePath, message: `settings table carries unknown key "${key}"` });
      }
    }
    const selectValue = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const assembled: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      const row = selectValue.get(key) as { value: string } | undefined;
      if (row === undefined) {
        throw new SaveDatabaseError({ path: this.savePath, message: `settings table is missing key "${key}"` });
      }
      try {
        assembled[key] = JSON.parse(row.value) as unknown;
      } catch {
        throw new SaveDatabaseError({ path: this.savePath, message: `settings value for "${key}" is not valid JSON` });
      }
    }
    const parsed = StrictSettingsSchema.safeParse(assembled);
    if (!parsed.success) {
      throw new SaveDatabaseError({ path: this.savePath, message: `settings rows failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` });
    }
    return parsed.data;
  }

  /** Creates both tables and seeds the default settings rows. */
  private initialize(): void {
    this.db.transaction(() => {
      this.db.exec(CREATE_VOCAB);
      this.db.exec(CREATE_SETTINGS);
      const insert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        insert.run(key, JSON.stringify(value));
      }
    })();
  }

  /** An existing database must match the expected schema exactly. */
  private verifySchema(): void {
    const fail = (message: string): never => {
      throw new SaveDatabaseError({ path: this.savePath, message });
    };

    const tables = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    if (tables.length !== 2 || !tables.includes("vocab") || !tables.includes("settings")) {
      fail(`existing database must contain exactly the vocab and settings tables (found: ${tables.join(", ") || "none"})`);
    }

    this.checkTableInfo("vocab", VOCAB_COLUMNS);
    this.checkTableInfo("settings", SETTINGS_COLUMNS);

    const uniqueOnCardId = (this.db.prepare("PRAGMA index_list(vocab)").all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>).some((index) => {
      if (!index.unique || !/^[A-Za-z0-9_]+$/.test(index.name)) return false;
      const columns = this.db.prepare(`PRAGMA index_info(${index.name})`)
        .all() as Array<{ name: string }>;
      return columns.length === 1 && columns[0]!.name === "card_id";
    });
    if (!uniqueOnCardId) fail("vocab is missing the UNIQUE constraint on card_id");

    // Structural PRAGMAs cannot see CHECK constraints, and SQLite's dynamic
    // typing would otherwise admit REAL masteries. SQLite preserves the CREATE
    // TABLE text verbatim in sqlite_master, so comparing the whitespace-
    // normalized statements against the canonical DDL is a strict contract
    // check: a missing, weakened, or widened mastery CHECK fails loudly.
    const normalizeSql = (sql: string): string => sql.trim().replace(/\s+/g, " ");
    const contract = new Map([
      ["vocab", normalizeSql(CREATE_VOCAB)],
      ["settings", normalizeSql(CREATE_SETTINGS)],
    ]);
    const stored = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('vocab', 'settings')");
    for (const { name, sql } of stored.all() as Array<{ name: string; sql: string }>) {
      if (normalizeSql(sql) !== contract.get(name)) {
        fail(`existing ${name} table does not match the required CREATE TABLE contract`);
      }
    }
  }

  private checkTableInfo(
    table: string,
    expected: ReadonlyArray<{ readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number }>,
  ): void {
    const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const mismatch = (message: string): never => {
      throw new SaveDatabaseError({ path: this.savePath, message: `${table}.${message}` });
    };
    if (info.length !== expected.length) {
      mismatch(`must have exactly ${expected.length} columns (found ${info.length})`);
    }
    for (const [index, column] of expected.entries()) {
      const actual = info[index]!;
      if (actual.name !== column.name) mismatch(`column ${index + 1} must be "${column.name}" (found "${actual.name}")`);
      if (actual.type !== column.type) mismatch(`column ${column.name} must be declared ${column.type} (found ${actual.type || "none"})`);
      if (actual.notnull !== column.notnull) mismatch(`column ${column.name} has the wrong NOT NULL constraint`);
      if (actual.pk !== column.pk) mismatch(`column ${column.name} has the wrong PRIMARY KEY participation`);
    }
  }
}
