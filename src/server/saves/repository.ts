import { link, mkdir, readFile, readdir, unlink } from "node:fs/promises";
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

export type SaveRecovery = {
  source: "backup";
  quarantinedFile: string | null;
};

export type LoadSaveResult = {
  save: SaveFile;
  recovery: SaveRecovery | null;
  firstRun: boolean;
};

export class RevisionConflictError extends Error {
  constructor(readonly current: Pick<SaveFile, "revision" | "savedAt">) {
    super(`Expected save revision does not match current revision ${current.revision}`);
    this.name = "RevisionConflictError";
  }
}

export class CorruptSaveError extends Error {
  constructor(
    readonly quarantinedFile: string | null,
    readonly backupError: string | null,
    readonly newlyQuarantined: boolean,
  ) {
    super("The authoritative save is corrupt and no valid backup is available");
    this.name = "CorruptSaveError";
  }
}

class InvalidSaveFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidSaveFileError";
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
    schemaVersion: 3,
    profileId: "default",
    revision: 0,
    savedAt: now.toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    spawnOrdinal: 0,
    schedulerRng: createSecureRandomState(),
    levels: {},
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
  readonly backupPath: string;
  private readonly catalog?: DeckCatalog;
  private readonly now: () => Date;
  private readonly writer: AtomicSaveWriter;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: SaveRepositoryOptions) {
    this.savePath = join(options.directory, "default.json");
    this.backupPath = `${this.savePath}.bak`;
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
      let loaded: LoadSaveResult;
      try {
        loaded = await this.loadUnsafe();
      } catch (error) {
        // A PUT after the client has observed a prior quarantine is the explicit
        // "start fresh" action. If this request itself discovers corruption,
        // fail first so an ordinary checkpoint can never erase it silently.
        if (error instanceof CorruptSaveError && !error.newlyQuarantined && expectedRevision === 0) {
          loaded = { save: createDefaultSave(this.now()), recovery: null, firstRun: true };
        } else {
          throw error;
        }
      }

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
    const main = await this.readCandidate(this.savePath);
    if (main.kind === "valid") {
      return { save: main.save, recovery: null, firstRun: false };
    }

    let quarantinedFile: string | null = null;
    if (main.kind === "invalid") {
      quarantinedFile = await this.quarantineMain();
    }

    const backup = await this.readCandidate(this.backupPath);
    if (backup.kind === "valid") {
      await this.writer.write(backup.save, false);
      return {
        save: backup.save,
        recovery: { source: "backup", quarantinedFile },
        firstRun: false,
      };
    }

    if (main.kind === "invalid" || backup.kind === "invalid") {
      throw new CorruptSaveError(
        quarantinedFile,
        backup.kind === "invalid" ? backup.error.message : null,
        main.kind === "invalid",
      );
    }

    const unresolvedQuarantine = await this.latestQuarantinedFile();
    if (unresolvedQuarantine) {
      throw new CorruptSaveError(unresolvedQuarantine, null, false);
    }
    return { save: createDefaultSave(this.now()), recovery: null, firstRun: true };
  }

  private async readCandidate(path: string): Promise<
    | { kind: "missing" }
    | { kind: "valid"; save: SaveFile }
    | { kind: "invalid"; error: InvalidSaveFileError }
  > {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }

    try {
      const raw: unknown = JSON.parse(data.toString("utf8"));
      // Validate only the current save format. A changed deck fingerprint is
      // reconciled by stable word ID and catalog-validated on the next PUT.
      return { kind: "valid", save: parseSaveFile(raw) };
    } catch (error) {
      return {
        kind: "invalid",
        error: new InvalidSaveFileError("Save JSON or schema is invalid", { cause: error }),
      };
    }
  }

  private async latestQuarantinedFile(): Promise<string | null> {
    const names = await readdir(dirname(this.savePath));
    return names
      .filter((name) => /^default\.corrupt-.+\.json$/u.test(name))
      .sort()
      .at(-1) ?? null;
  }

  private async quarantineMain(): Promise<string> {
    const stamp = this.now().toISOString().replaceAll(":", "-");
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const name = `default.corrupt-${stamp}${suffix}.json`;
      try {
        // Hard-link then unlink provides a no-overwrite quarantine operation on
        // the same filesystem (rename would replace an existing destination).
        await link(this.savePath, join(dirname(this.savePath), name));
        await unlink(this.savePath);
        return name;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          attempt += 1;
          continue;
        }
        if (code === "ENOENT") return name;
        throw error;
      }
    }
  }
}

export type { SaveSnapshot };
