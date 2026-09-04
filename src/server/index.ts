import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import { buildAppEffect, type BuildAppError } from "./app";
import { normalizeError } from "./errors";
import { FileSystem } from "./filesystem";
import { runPromiseUnchecked } from "./runtime";

/** The configured PORT is not a valid TCP port. */
export class InvalidPortError extends Data.TaggedError("InvalidPortError")<{
  readonly value: string;
}> {
  override get message(): string {
    return `Invalid PORT: ${this.value}`;
  }
}

/** Binding the HTTP listener (or closing it on shutdown) failed. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly cause: Error;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type StartServerError = BuildAppError | InvalidPortError | ListenError;

const listenPort = (value: string | undefined): Effect.Effect<number, InvalidPortError, never> =>
  Effect.suspend(() => {
    const port = Number.parseInt(value ?? "5757", 10);
    return Number.isInteger(port) && port >= 1 && port <= 65_535
      ? Effect.succeed(port)
      : Effect.fail(new InvalidPortError({ value: value ?? "" }));
  });

export const startServerEffect: Effect.Effect<void, StartServerError, FileSystem> = Effect.gen(function* () {
  const app = yield* buildAppEffect({ logger: true });
  const port = yield* listenPort(process.env.PORT);
  const host = process.env.HOST ?? "100.65.64.80";

  yield* Effect.sync(() => {
    const close = (): void => {
      Effect.runFork(Effect.tryPromise({
        try: () => app.close(),
        catch: (cause) => new ListenError({ cause: normalizeError(cause) }),
      }).pipe(
        Effect.tap(() => Effect.sync(() => { process.exitCode = 0; })),
        Effect.catchAll((error) => Effect.sync(() => {
          console.error(error);
          process.exitCode = 1;
        })),
      ));
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });

  yield* Effect.tryPromise({
    try: () => app.listen({ host, port }),
    catch: (cause) => new ListenError({ cause: normalizeError(cause) }),
  });
});

/** Thin `Effect.runPromise` boundary for process startup. */
export const startServer = (): Promise<void> =>
  runPromiseUnchecked(startServerEffect.pipe(Effect.provide(FileSystem.layer)));

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  Effect.runFork(startServerEffect.pipe(
    Effect.provide(FileSystem.layer),
    Effect.catchAll((error) => Effect.sync(() => {
      console.error(error);
      process.exitCode = 1;
    })),
  ));
}
