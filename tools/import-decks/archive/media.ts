import { Context, Data, Effect, Layer } from "effect";
import type { MediaIndex } from "../raw-types";
import { Fs } from "../../shared/fs";

const SAFE_MEMBER = /^(?:0|[1-9][0-9]*)$/u;

/** Typed failure for APKG media-index parsing (unsafe names, duplicates,
 * malformed JSON). */
export class MediaError extends Data.TaggedError("MediaError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure for `[sound:filename]` reference parsing. */
export class SoundReferenceError extends Data.TaggedError("SoundReferenceError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const assertSafeMediaFilename = (filename: string): Effect.Effect<void, MediaError, never> => {
  if (
    !filename ||
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    return Effect.fail(new MediaError({ detail: `Unsafe media filename: ${JSON.stringify(filename)}` }));
  }
  return Effect.void;
};

/** Validates a raw APKG media JSON object into a safe bidirectional index. */
export const parseMediaMapEffect = (value: unknown): Effect.Effect<MediaIndex, MediaError, never> =>
  Effect.gen(function* () {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return yield* Effect.fail(new MediaError({ detail: "APKG media must be a JSON object" }));
    }
    const memberByFilename = new Map<string, string>();
    const filenameByMember = new Map<string, string>();
    for (const [member, filename] of Object.entries(value)) {
      if (!SAFE_MEMBER.test(member)) {
        return yield* Effect.fail(new MediaError({ detail: `Unsafe media member name: ${JSON.stringify(member)}` }));
      }
      if (typeof filename !== "string") {
        return yield* Effect.fail(new MediaError({ detail: `Media member ${member} has a non-string filename` }));
      }
      yield* assertSafeMediaFilename(filename);
      const previous = memberByFilename.get(filename);
      if (previous !== undefined && previous !== member) {
        return yield* Effect.fail(
          new MediaError({ detail: `Duplicate media filename ${JSON.stringify(filename)} maps to ${previous} and ${member}` }),
        );
      }
      memberByFilename.set(filename, member);
      filenameByMember.set(member, filename);
    }
    return { memberByFilename, filenameByMember };
  });

/** Reads and validates the APKG `media` JSON file. Read and JSON failures are
 * wrapped with the historical "Could not parse APKG media JSON" prefix. */
export const readMediaMapEffect = (path: string): Effect.Effect<MediaIndex, MediaError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const text = yield* Effect.mapError(
      fs.readTextFile(path),
      (error) => new MediaError({ detail: `Could not parse APKG media JSON: ${error.detail}` }),
    );
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (error) =>
        new MediaError({
          detail: `Could not parse APKG media JSON: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    return yield* parseMediaMapEffect(parsed);
  });

/** Parses exactly one `[sound:filename]` token and requires an MP3 payload. */
export const parseSoundReferenceEffect = (value: string): Effect.Effect<string, SoundReferenceError, never> =>
  Effect.gen(function* () {
    const match = /^\[sound:([^\[\]\r\n]+)\]$/u.exec(value.trim());
    if (!match) {
      return yield* Effect.fail(
        new SoundReferenceError({ detail: `Expected exactly one [sound:filename] token, got ${JSON.stringify(value)}` }),
      );
    }
    const filename = match[1]!;
    yield* Effect.mapError(
      assertSafeMediaFilename(filename),
      (error) => new SoundReferenceError({ detail: error.detail }),
    );
    if (!/\.mp3$/iu.test(filename)) {
      return yield* Effect.fail(new SoundReferenceError({ detail: `Unsupported word audio format: ${filename}` }));
    }
    return filename;
  });

// --- compatibility boundaries -------------------------------------------------
// The original module API was sync-throwing / Promise-based and is preserved for
// the CLI and test suites; the Effect implementations above carry typed errors.

/** Synchronous boundary: throws the typed `MediaError` on failure. */
export function parseMediaMap(value: unknown): MediaIndex {
  return Effect.runSync(parseMediaMapEffect(value));
}

/** Promise boundary: rejects with the typed `MediaError` on failure. */
export const readMediaMap = (path: string): Promise<MediaIndex> =>
  Effect.runPromise(Effect.provide(readMediaMapEffect(path), Fs.layer));

/** Synchronous boundary: throws the typed `MediaError` on failure. */
export function parseSoundReference(value: string): string {
  return Effect.runSync(parseSoundReferenceEffect(value));
}
