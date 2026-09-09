import { Context, Data, Effect, Layer } from "effect";

/** A fetch/JSON failure at the transport level. `cause` carries the raw
 * browser error (TypeError from an offline fetch, SyntaxError from a
 * malformed 200 body) so the Promise boundary can rethrow it unchanged. */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly cause: Error;
}> {}

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** The browser fetch capability, behind a Context.Tag so workflows stay
 * declarative and the global lookup happens only inside the Live layer.
 * Shared by every client data loader (stroke data, Battle save API). */
export type HttpFetchService = (
  url: string,
  init?: RequestInit,
) => Effect.Effect<Response, TransportError, never>;

export class HttpFetch extends Context.Tag("HttpFetch")<HttpFetch, HttpFetchService>() {}

/** Live capability backed by the real browser global. Resolved lazily at call
 * time, so tests (and callers) may stub fetch. */
export const HttpFetchLive = Layer.succeed(
  HttpFetch,
  (url, init): Effect.Effect<Response, TransportError, never> =>
    Effect.tryPromise({
      try: () => globalThis.fetch(url, init),
      catch: (cause) => new TransportError({ cause: normalizeError(cause) }),
    }),
);
