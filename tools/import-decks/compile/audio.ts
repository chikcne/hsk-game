import { createHash } from "node:crypto";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { visitZip, writeEntryStream } from "../archive/zip";
import type { ArchiveError } from "../archive/zip";
import { Fs, FsError } from "../../shared/fs";

export type AudioExtraction = {
  urlByFilename: Map<string, string>;
  assetCount: number;
  totalBytes: number;
};

/** Typed failure for selected-audio extraction (member collisions, duplicates,
 * non-MP3 payloads, members absent from the archive). */
export class AudioError extends Data.TaggedError("AudioError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

function isMp3(prefix: Buffer): boolean {
  return prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "ID3" ||
    prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0;
}

/** Streams the selected audio members out of the APKG into content-addressed
 * MP3 assets. Each partial file is cleaned up if its extraction fails, and the
 * ZIP handle is closed via the internal scope. */
export const extractSelectedAudio = (
  apkgPath: string,
  memberByFilename: Map<string, string>,
  outputDirectory: string,
): Effect.Effect<AudioExtraction, AudioError | FsError | ArchiveError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    yield* fs.mkdirRecursive(outputDirectory);
    const filenameByMember = new Map<string, string>();
    for (const [filename, member] of memberByFilename) {
      if (filenameByMember.has(member)) {
        return yield* Effect.fail(new AudioError({ detail: `Two selected audio filenames resolve to media member ${member}` }));
      }
      filenameByMember.set(member, filename);
    }
    const found = new Set<string>();
    const urlByFilename = new Map<string, string>();
    const contentPaths = new Set<string>();

    yield* Effect.scoped(visitZip(apkgPath, (entry, open) =>
      Effect.gen(function* () {
        const filename = filenameByMember.get(entry.fileName);
        if (!filename) return;
        if (found.has(entry.fileName)) {
          return yield* Effect.fail(new AudioError({ detail: `Duplicate selected media ZIP member: ${entry.fileName}` }));
        }
        found.add(entry.fileName);
        const partPath = join(outputDirectory, `.audio-${entry.fileName}.part`);
        const hash = createHash("sha256");
        let prefix = Buffer.alloc(0);
        const stream = yield* open();
        stream.on("data", (chunk: Buffer | string) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          hash.update(bytes);
          if (prefix.length < 3) prefix = Buffer.concat([prefix, bytes.subarray(0, 3 - prefix.length)]);
        });
        yield* Effect.gen(function* () {
          yield* writeEntryStream(stream, partPath);
          if (!isMp3(prefix)) {
            return yield* Effect.fail(new AudioError({ detail: `Selected word audio ${filename} does not have MP3 magic bytes` }));
          }
          const digest = hash.digest("hex");
          const outputPath = join(outputDirectory, `${digest}.mp3`);
          yield* fs.rename(partPath, outputPath).pipe(
            Effect.catchTag("FsError", (error) =>
              error.code === "EEXIST" ? fs.rmRecursive(partPath) : Effect.fail(error)),
          );
          contentPaths.add(outputPath);
          urlByFilename.set(filename, `audio/${digest}.mp3`);
        }).pipe(Effect.tapError(() => fs.rmRecursive(partPath)));
      }),
    ));

    const missing = [...filenameByMember.keys()].filter((member) => !found.has(member));
    if (missing.length) {
      return yield* Effect.fail(new AudioError({ detail: `Selected media members absent from ZIP: ${missing.sort().join(", ")}` }));
    }
    let totalBytes = 0;
    for (const path of contentPaths) totalBytes += yield* fs.statSize(path);
    return { urlByFilename, assetCount: contentPaths.size, totalBytes };
  });
