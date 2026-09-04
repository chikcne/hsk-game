import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname } from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { Data, Effect, Scope } from "effect";
import { decodeSystemError, Fs, FsError } from "../../shared/fs";
import { sha256File as sha256FileEffect } from "../../shared/hash";

/** Typed failure for APKG archive access (open, entry streaming, member layout,
 * checksum-file parsing). */
export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const openZipFile = (path: string): Effect.Effect<ZipFile, ArchiveError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.async<ZipFile, ArchiveError>((resume) => {
      yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, zip) => {
        if (error || !zip) {
          resume(
            Effect.fail(
              new ArchiveError({
                detail: `Could not open ZIP: ${path}${error instanceof Error ? ` (${error.message})` : ""}`,
              }),
            ),
          );
        } else {
          resume(Effect.succeed(zip));
        }
      });
    }),
    (zip) => Effect.sync(() => zip.close()),
  );

const openEntryStream = (zip: ZipFile, entry: Entry): Effect.Effect<NodeJS.ReadableStream, ArchiveError, never> =>
  Effect.async((resume) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        resume(
          Effect.fail(
            new ArchiveError({
              detail: `Could not read ZIP member ${entry.fileName}${error instanceof Error ? ` (${error.message})` : ""}`,
            }),
          ),
        );
      } else {
        resume(Effect.succeed(stream));
      }
    });
  });

/** Reads the next entry (or `null` at end of archive) from a lazily-iterated ZIP. */
const readNextEntry = (zip: ZipFile): Effect.Effect<Entry | null, ArchiveError, never> =>
  Effect.async((resume) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(new ArchiveError({ detail: error.message })));
    };
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });

/** Visits ZIP entries serially without buffering their contents. The archive
 * handle is acquired on the calling scope and always closed afterwards; entry
 * streams are opened lazily through `open` so visitors can opt into reading. */
export const visitZip = <E, R>(
  path: string,
  visitor: (entry: Entry, open: () => Effect.Effect<NodeJS.ReadableStream, ArchiveError, never>) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | ArchiveError, R | Scope.Scope> =>
  Effect.gen(function* () {
    const zip = yield* openZipFile(path);
    const loop: Effect.Effect<void, E | ArchiveError, R> = Effect.flatMap(
      readNextEntry(zip),
      (entry): Effect.Effect<void, E | ArchiveError, R> =>
        entry
          ? Effect.flatMap(visitor(entry, () => openEntryStream(zip, entry)), () => loop)
          : Effect.void,
    );
    yield* loop;
  });

export type ArchiveEssentials = {
  collectionPath: string;
  mediaPath: string;
  archiveEntryCount: number;
};

/** Extracts only `collection.anki21` and `media` from an APKG into `tempDir`. */
export const extractArchiveEssentialsEffect = (
  apkgPath: string,
  tempDir: string,
): Effect.Effect<ArchiveEssentials, ArchiveError | FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const collectionPath = `${tempDir}/collection.anki21`;
    const mediaPath = `${tempDir}/media`;
    let archiveEntryCount = 0;
    const seen = new Set<string>();
    yield* Effect.scoped(visitZip(apkgPath, (entry, open) =>
      Effect.gen(function* () {
        archiveEntryCount += 1;
        if (entry.fileName !== "collection.anki21" && entry.fileName !== "media") return;
        if (seen.has(entry.fileName)) {
          return yield* Effect.fail(new ArchiveError({ detail: `Duplicate required ZIP member: ${entry.fileName}` }));
        }
        seen.add(entry.fileName);
        const destination = entry.fileName === "media" ? mediaPath : collectionPath;
        yield* fs.mkdirRecursive(dirname(destination));
        const input = yield* open();
        yield* Effect.tryPromise({
          try: () => pipeline(input, createWriteStream(destination, { flags: "wx" })),
          catch: decodeSystemError,
        });
      }),
    ));
    for (const required of ["collection.anki21", "media"]) {
      if (!seen.has(required)) {
        return yield* Effect.fail(new ArchiveError({ detail: `APKG is missing required member: ${required}` }));
      }
    }
    return { collectionPath, mediaPath, archiveEntryCount };
  });

/** Reads a `sha256sum`-style checksum file into a filename→digest map. */
export const readChecksumFileEffect = (
  path: string,
): Effect.Effect<Map<string, string>, ArchiveError | FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const text = yield* fs.readTextFile(path);
    const result = new Map<string, string>();
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const match = /^([a-f0-9]{64})\s+\*?([^/\\]+)$/u.exec(line.trim());
      if (!match) {
        return yield* Effect.fail(new ArchiveError({ detail: `Malformed checksum line: ${line}` }));
      }
      result.set(match[2]!, match[1]!);
    }
    return result;
  });

/** Internal helper shared with the audio extractor: writes an entry stream to a
 * destination file with exclusive (`wx`) semantics. */
export const writeEntryStream = (
  input: NodeJS.ReadableStream,
  destination: string,
): Effect.Effect<void, FsError, never> =>
  Effect.tryPromise({
    try: () => pipeline(input, createWriteStream(destination, { flags: "wx" })),
    catch: decodeSystemError,
  });

// --- compatibility boundaries -------------------------------------------------
// The test suite and the compiler call these with plain Promises; the Effect
// implementations above carry the typed errors and resource scoping.

/** Promise boundary: rejects with `FsError` on failure. */
export const sha256File = (path: string): Promise<string> => Effect.runPromise(sha256FileEffect(path));

/** Promise boundary: rejects with `ArchiveError` or `FsError` on failure. */
export const extractArchiveEssentials = (apkgPath: string, tempDir: string): Promise<ArchiveEssentials> =>
  Effect.runPromise(Effect.provide(extractArchiveEssentialsEffect(apkgPath, tempDir), Fs.layer));
