import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { SaveFile } from "../../shared/schemas";
import { createSecureRandomState } from "../../domain/random";
import { FsError, isEnoent, JsonParseError, normalizeError } from "../errors";
import { FileSystem } from "../filesystem";
import { runPromiseUnchecked } from "../runtime";
import { AtomicSaveWriter, type AtomicWriteError, type AtomicWriterOptions } from "./atomic-writer";
import type { DeckCatalog } from "./manifests";
import { parseSaveFileEffect, parseSaveSnapshotEffect, SaveValidationError, type SaveSnapshot } from "./validation";

// Full mastery plus independent cross-grade recall history can exceed the old
// 2 MiB V1 ceiling. Keep a bounded but realistic local-profile limit.
export const MAX_SAVE_BYTES = 16 * 1024 * 1024;

export type LoadSaveResult = {
  save: SaveFile;
  firstRun: boolean;
};

export class RevisionConflictError extends Data.TaggedError("RevisionConflictError")<{
  readonly current: Pick<SaveFile, "revision" | "savedAt">;
}> {
  override get message(): string {
    return `Expected save revision does not match current revision ${this.current.revision}`;
  }
}

export type SaveRepositoryError = SaveValidationError | RevisionConflictError | AtomicWriteError;

export type SaveRepositoryOptions = {
  directory: string;
  catalog?: DeckCatalog;
  now?: () => Date;
  writer?: AtomicWriterOptions;
};

export function createDefaultSave(now = new Date()): SaveFile {
  return {
    schemaVersion: 5,
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
 * in one serialized operation, so concurrent requests can never both win.
 *
 * The Effect pipelines are the core; the promise-returning `initialize`, `load`
 * and `save` methods are thin `Effect.runPromise` boundaries for Fastify and
 * non-Effect consumers. */
export class SaveRepository {
  readonly savePath: string;
  private readonly catalog?: DeckCatalog;
  private readonly now: () => Date;
  private readonly writer: AtomicSaveWriter;
  private readonly mutex: Effect.Semaphore;

  constructor(options: SaveRepositoryOptions) {
    this.savePath = join(options.directory, "default.json");
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
    this.writer = new AtomicSaveWriter(this.savePath, options.writer);
    this.mutex = Effect.runSync(Effect.makeSemaphore(1));
  }

  /** Creates the save directory and clears leftover temp files. */
  initializeEffect(): Effect.Effect<void, FsError, FileSystem> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem;
      yield* fs.mkdirRecursive(dirname(this.savePath));
      yield* this.writer.cleanupStaleTemps();
    });
  }

  initialize(): Promise<void> {
    return runPromiseUnchecked(this.initializeEffect().pipe(Effect.provide(FileSystem.layer)));
  }

  loadEffect(): Effect.Effect<LoadSaveResult, FsError, FileSystem> {
    return this.mutex.withPermits(1)(this.loadUnsafeEffect());
  }

  load(): Promise<LoadSaveResult> {
    return runPromiseUnchecked(this.loadEffect().pipe(Effect.provide(FileSystem.layer)));
  }

  saveEffect(expectedRevision: number, input: unknown): Effect.Effect<SaveFile, SaveRepositoryError, FileSystem> {
    return this.mutex.withPermits(1)(
      Effect.gen(this, function* () {
        const snapshot = yield* parseSaveSnapshotEffect(input, this.catalog);
        const loaded = yield* this.loadUnsafeEffect();
        if (expectedRevision !== loaded.save.revision) {
          return yield* Effect.fail(new RevisionConflictError({
            current: { revision: loaded.save.revision, savedAt: loaded.save.savedAt },
          }));
        }

        const authoritative = yield* parseSaveFileEffect({
          ...structuredClone(snapshot),
          revision: loaded.save.revision + 1,
          savedAt: this.now().toISOString(),
        }, this.catalog);
        yield* this.writer.write(authoritative);
        return authoritative;
      }),
    );
  }

  save(expectedRevision: number, input: unknown): Promise<SaveFile> {
    return runPromiseUnchecked(this.saveEffect(expectedRevision, input).pipe(Effect.provide(FileSystem.layer)));
  }

  private loadUnsafeEffect(): Effect.Effect<LoadSaveResult, FsError, FileSystem> {
    return Effect.gen(this, function* () {
      const save = yield* this.readSaveEffect();
      if (save !== null) return { save, firstRun: false };
      return { save: createDefaultSave(this.now()), firstRun: true };
    });
  }

  /** A missing or invalid file is a first run: schema v5 has no predecessors,
   * so there is nothing to migrate or preserve — the next PUT replaces it. */
  private readSaveEffect(): Effect.Effect<SaveFile | null, FsError, FileSystem> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem;
      const data = yield* fs.readBinary(this.savePath).pipe(
        Effect.catchIf(isEnoent, () => Effect.succeed(null)),
      );
      if (data === null) return null;

      const raw = yield* Effect.try({
        try: () => JSON.parse(data.toString("utf8")) as unknown,
        catch: (cause) => new JsonParseError({ cause: normalizeError(cause) }),
      }).pipe(Effect.catchTag("JsonParseError", () => Effect.succeed(null)));
      if (raw === null) return null;
      // Validate only the current save format. A changed deck fingerprint is
      // reconciled by stable word ID and catalog-validated on the next PUT.
      return yield* parseSaveFileEffect(raw).pipe(
        Effect.catchTag("SaveValidationError", () => Effect.succeed(null)),
      );
    });
  }
}

export type { SaveSnapshot };
