import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { SaveFile } from "../../shared/schemas";
import { createSecureRandomState } from "../../domain/random";
import { AtomicSaveWriter, type AtomicWriterOptions } from "./atomic-writer";
import type { DeckCatalog } from "./manifests";
import { parseSaveFile, parseSaveSnapshot, type SaveSnapshot } from "./validation";

// Full mastery plus independent cross-grade recall history can exceed the old
// 2 MiB V1 ceiling. Keep a bounded but realistic local-profile limit.
export const MAX_SAVE_BYTES = 16 * 1024 * 1024;

export type LoadSaveResult = {
  save: SaveFile;
  firstRun: boolean;
};

export class RevisionConflictError extends Error {
  constructor(readonly current: Pick<SaveFile, "revision" | "savedAt">) {
    super(`Expected save revision does not match current revision ${current.revision}`);
    this.name = "RevisionConflictError";
  }
}

export type SaveRepositoryOptions = {
  directory: string;
  catalog?: DeckCatalog;
  now?: () => Date;
  writer?: AtomicWriterOptions;
};

export function createDefaultSave(now = new Date()): SaveFile {
  return {
    schemaVersion: 4,
    profileId: "default",
    revision: 0,
    savedAt: now.toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: createSecureRandomState(),
    levels: {},
    acquiredWords: [],
    learnSessions: {},
    relearnSession: null,
    lifetime: {
      score: 0,
      resolvedEnemies: 0,
      completeCorrect: 0,
      wrongPinyin: 0,
      wrongMeaning: 0,
      landed: 0,
      bestStreak: 0,
      totalThinkingMs: 0,
    },
  };
}

/** Repository transaction queue. Revision comparison and atomic replacement run
 * in one serialized operation, so concurrent requests can never both win. */
export class SaveRepository {
  readonly savePath: string;
  private readonly catalog?: DeckCatalog;
  private readonly now: () => Date;
  private readonly writer: AtomicSaveWriter;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: SaveRepositoryOptions) {
    this.savePath = join(options.directory, "default.json");
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
    this.writer = new AtomicSaveWriter(this.savePath, options.writer);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.savePath), { recursive: true });
    await this.writer.cleanupStaleTemps();
  }

  load(): Promise<LoadSaveResult> {
    return this.enqueue(() => this.loadUnsafe());
  }

  save(expectedRevision: number, input: unknown): Promise<SaveFile> {
    return this.enqueue(async () => {
      const snapshot = parseSaveSnapshot(input, this.catalog);
      const loaded = await this.loadUnsafe();
      if (expectedRevision !== loaded.save.revision) {
        throw new RevisionConflictError({
          revision: loaded.save.revision,
          savedAt: loaded.save.savedAt,
        });
      }

      const authoritative = parseSaveFile({
        ...structuredClone(snapshot),
        revision: loaded.save.revision + 1,
        savedAt: this.now().toISOString(),
      }, this.catalog);
      await this.writer.write(authoritative);
      return authoritative;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadUnsafe(): Promise<LoadSaveResult> {
    const save = await this.readSave();
    if (save) return { save, firstRun: false };
    return { save: createDefaultSave(this.now()), firstRun: true };
  }

  /** A missing or invalid file is a first run: schema v4 has no predecessors,
   * so there is nothing to migrate or preserve — the next PUT replaces it. */
  private async readSave(): Promise<SaveFile | null> {
    let data: Buffer;
    try {
      data = await readFile(this.savePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    try {
      const raw: unknown = JSON.parse(data.toString("utf8"));
      // Validate only the current save format. A changed deck fingerprint is
      // reconciled by stable word ID and catalog-validated on the next PUT.
      return parseSaveFile(raw);
    } catch {
      return null;
    }
  }
}

export type { SaveSnapshot };
