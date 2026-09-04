import { access, mkdir, open, readFile, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { FsError, normalizeError } from "./errors";

/** A writable file handle; all operations are effectful and fail with `FsError`. */
export interface FileWriteHandle {
  readonly writeText: (data: string) => Effect.Effect<void, FsError, never>;
  readonly sync: () => Effect.Effect<void, FsError, never>;
  readonly close: () => Effect.Effect<void, FsError, never>;
}

/** The filesystem operations used by the save server, exposed as a service so
 * persistence code stays declarative and can be tested against a stub. */
export interface FileSystemService {
  readonly access: (path: string) => Effect.Effect<void, FsError, never>;
  readonly mkdirRecursive: (path: string) => Effect.Effect<void, FsError, never>;
  readonly readBinary: (path: string) => Effect.Effect<Buffer, FsError, never>;
  readonly readText: (path: string) => Effect.Effect<string, FsError, never>;
  readonly readdir: (path: string) => Effect.Effect<ReadonlyArray<string>, FsError, never>;
  readonly rename: (source: string, destination: string) => Effect.Effect<void, FsError, never>;
  readonly unlink: (path: string) => Effect.Effect<void, FsError, never>;
  /** Opens a file for writing, failing when it already exists (`wx`, 0o600). */
  readonly openWriteExclusive: (path: string) => Effect.Effect<FileWriteHandle, FsError, never>;
  /** Best-effort `fsync` of a directory entry. Failures with tolerated errnos
   * (EINVAL, ENOTSUP, EISDIR, EPERM — e.g. filesystems without directory sync)
   * resolve successfully; the handle is always closed. */
  readonly syncDirectory: (path: string) => Effect.Effect<void, FsError, never>;
}

const TOLERATED_SYNC_DIRECTORY_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]);

const fsTry = <A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FsError, never> =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause: normalizeError(cause) }) });

const writeHandle = (handle: FileHandle, path: string): FileWriteHandle => ({
  writeText: (data) => fsTry("writeFile", path, () => handle.writeFile(data, "utf8")),
  sync: () => fsTry("sync", path, () => handle.sync()),
  close: () => fsTry("close", path, () => handle.close()),
});

const nodeFileSystem: FileSystemService = {
  access: (path) => fsTry("access", path, () => access(path)),
  mkdirRecursive: (path) => fsTry("mkdir", path, () => mkdir(path, { recursive: true })),
  readBinary: (path) => fsTry("readFile", path, () => readFile(path)),
  readText: (path) => fsTry("readFile", path, () => readFile(path, "utf8")),
  readdir: (path) => fsTry("readdir", path, () => readdir(path)),
  rename: (source, destination) => fsTry("rename", source, () => rename(source, destination)),
  unlink: (path) => fsTry("unlink", path, () => unlink(path)),
  openWriteExclusive: (path) =>
    Effect.map(fsTry("open", path, () => open(path, "wx", 0o600)), (handle) => writeHandle(handle, path)),
  syncDirectory: (directory) =>
    Effect.gen(function* () {
      const handle = yield* fsTry("open", directory, () => open(directory, "r"));
      return yield* fsTry("sync", directory, () => handle.sync()).pipe(
        Effect.catchIf((error) => TOLERATED_SYNC_DIRECTORY_CODES.has(error.errno ?? ""), () => Effect.void),
        Effect.ensuring(fsTry("close", directory, () => handle.close()).pipe(Effect.ignore)),
      );
    }),
};

export class FileSystem extends Context.Tag("ziduoduo/server/FileSystem")<FileSystem, FileSystemService>() {
  static readonly layer: Layer.Layer<FileSystem> = Layer.succeed(FileSystem, nodeFileSystem);
}
