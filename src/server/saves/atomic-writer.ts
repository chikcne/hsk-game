import { basename, dirname, join } from "node:path";
import { Data, Effect } from "effect";
import type { SaveFile } from "../../shared/schemas";
import { FsError, isEnoent, normalizeError } from "../errors";
import { FileSystem, type FileWriteHandle } from "../filesystem";

export type AtomicWriteStage =
  | "afterTempOpen"
  | "afterPartialWrite"
  | "afterFlush"
  | "beforeRename";

export type FaultInjector = (stage: AtomicWriteStage) => void | Promise<void>;

export type AtomicWriterOptions = {
  faultInjector?: FaultInjector;
  nonce?: () => string;
};

/** A fault injector (or another step of the atomic write) raised an error; the
 * original failure is preserved in `cause`. */
export class FaultInjectedError extends Data.TaggedError("FaultInjectedError")<{
  readonly stage: AtomicWriteStage;
  readonly cause: Error;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type AtomicWriteError = FsError | FaultInjectedError;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function serializeSave(save: SaveFile): string {
  return `${JSON.stringify(sortJson(save), null, 2)}\n`;
}

export class AtomicSaveWriter {
  private readonly faultInjector?: FaultInjector;
  private readonly nonce: () => string;

  constructor(
    readonly savePath: string,
    options: AtomicWriterOptions = {},
  ) {
    this.faultInjector = options.faultInjector;
    this.nonce = options.nonce ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  }

  cleanupStaleTemps(): Effect.Effect<void, FsError, FileSystem> {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem;
      const directory = dirname(this.savePath);
      const prefixes = [`${basename(this.savePath)}.tmp-`];
      const entries = yield* fs.readdir(directory).pipe(
        Effect.catchIf(isEnoent, () => Effect.succeed(null)),
      );
      if (entries === null) return;
      yield* Effect.forEach(
        entries.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix))),
        (entry) => fs.unlink(join(directory, entry)).pipe(Effect.catchIf(isEnoent, () => Effect.void)),
        { concurrency: "unbounded", discard: true },
      );
    });
  }

  /** Temp file, fsync, atomic rename, directory sync — a failure at any stage
   * never leaves a temp file behind nor truncates the live save. */
  write(save: SaveFile): Effect.Effect<void, AtomicWriteError, FileSystem> {
    const serialized = serializeSave(save);
    const directory = dirname(this.savePath);
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem;
      const tempPath = `${this.savePath}.tmp-${process.pid}-${this.nonce()}`;
      let handle: FileWriteHandle | undefined;
      let renamed = false;
      const cleanup: Effect.Effect<void, never, never> = Effect.gen(function* () {
        if (handle !== undefined) yield* Effect.ignore(handle.close());
        if (!renamed) yield* Effect.ignore(fs.unlink(tempPath));
      });
      return yield* Effect.gen(this, function* () {
        handle = yield* fs.openWriteExclusive(tempPath);
        yield* this.injectFault("afterTempOpen");

        const midpoint = Math.max(1, Math.floor(serialized.length / 2));
        yield* handle.writeText(serialized.slice(0, midpoint));
        yield* this.injectFault("afterPartialWrite");
        yield* handle.writeText(serialized.slice(midpoint));
        yield* handle.sync();
        yield* this.injectFault("afterFlush");
        yield* handle.close();
        handle = undefined;

        yield* this.injectFault("beforeRename");
        yield* fs.rename(tempPath, this.savePath);
        renamed = true;
        yield* fs.syncDirectory(directory);
      }).pipe(Effect.ensuring(cleanup));
    });
  }

  private injectFault(stage: AtomicWriteStage): Effect.Effect<void, FaultInjectedError, never> {
    const faultInjector = this.faultInjector;
    if (faultInjector === undefined) return Effect.void;
    return Effect.tryPromise({
      try: () => Promise.resolve(faultInjector(stage)),
      catch: (cause) => new FaultInjectedError({ stage, cause: normalizeError(cause) }),
    });
  }
}
