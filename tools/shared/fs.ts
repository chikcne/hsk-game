import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Context, Data, Effect, Layer } from "effect";

/** Typed failure for every filesystem operation performed by the import CLIs.
 * `detail` carries the underlying system message verbatim and `code` carries the
 * Node errno string (e.g. `"ENOENT"`) so callers can branch on it. */
export class FsError extends Data.TaggedError("FsError")<{
  readonly detail: string;
  readonly code?: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Decodes an unknown thrown system error into a typed `FsError`, preserving the
 * original message text and errno code. */
export const decodeSystemError = (error: unknown): FsError =>
  new FsError({
    detail: error instanceof Error ? error.message : String(error),
    code:
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined,
  });

export type FsShape = {
  readonly readTextFile: (path: string) => Effect.Effect<string, FsError, never>;
  readonly writeFile: (
    path: string,
    data: string,
    options?: { readonly exclusive?: boolean },
  ) => Effect.Effect<void, FsError, never>;
  readonly mkdirRecursive: (path: string) => Effect.Effect<void, FsError, never>;
  readonly mkdtemp: (prefix: string) => Effect.Effect<string, FsError, never>;
  readonly rename: (from: string, to: string) => Effect.Effect<void, FsError, never>;
  readonly rmRecursive: (path: string) => Effect.Effect<void, FsError, never>;
  readonly statSize: (path: string) => Effect.Effect<number, FsError, never>;
  readonly copyFile: (source: string, destination: string) => Effect.Effect<void, FsError, never>;
};

/** Capability service for the filesystem. Import pipelines depend on this tag in
 * their `Requirements` channel instead of reaching for `node:fs` directly, so
 * tests and alternate runners can supply their own layer. */
export class Fs extends Context.Tag("ziduoduo.tools.Fs")<Fs, FsShape>() {
  static readonly layer: Layer.Layer<Fs> = Layer.succeed(Fs, {
    readTextFile: (path) =>
      Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: decodeSystemError }),
    writeFile: (path, data, options) =>
      Effect.tryPromise({
        try: () => writeFile(path, data, options?.exclusive ? { flag: "wx" } : undefined),
        catch: decodeSystemError,
      }),
    mkdirRecursive: (path) =>
      Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: decodeSystemError }),
    mkdtemp: (prefix) => Effect.tryPromise({ try: () => mkdtemp(prefix), catch: decodeSystemError }),
    rename: (from, to) =>
      Effect.tryPromise({ try: () => rename(from, to), catch: decodeSystemError }),
    rmRecursive: (path) =>
      Effect.tryPromise({
        try: () => rm(path, { recursive: true, force: true }),
        catch: decodeSystemError,
      }),
    statSize: (path) =>
      Effect.map(
        Effect.tryPromise({ try: () => stat(path), catch: decodeSystemError }),
        (stats) => stats.size,
      ),
    copyFile: (source, destination) =>
      Effect.tryPromise({ try: () => copyFile(source, destination), catch: decodeSystemError }),
  });
}
