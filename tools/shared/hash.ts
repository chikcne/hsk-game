import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Effect } from "effect";
import { decodeSystemError, FsError } from "./fs";

/** Streams `path` through SHA-256 without buffering the file. The read stream is
 * scoped, so the descriptor is destroyed on completion, failure, or interruption. */
export const sha256File = (path: string): Effect.Effect<string, FsError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stream = yield* Effect.acquireRelease(
        Effect.try({ try: () => createReadStream(path), catch: decodeSystemError }),
        (stream) => Effect.sync(() => stream.destroy()),
      );
      const hash = createHash("sha256");
      yield* Effect.async<void, FsError>((resume) => {
        stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
        stream.once("error", (error: Error) =>
          resume(Effect.fail(new FsError({ detail: error.message }))),
        );
        stream.once("end", () => resume(Effect.succeed(void 0)));
      });
      return hash.digest("hex");
    }),
  );
