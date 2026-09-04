import { Cause, Effect, Exit, Option } from "effect";
import { InvalidTimestampError, type DomainFailure, toThrowable } from "./errors";

/**
 * Shared `Effect` plumbing for the domain: the bridge used by the legacy
 * throwing adapters, plus the one timestamp validator reused across every
 * module that accepts a clock argument.
 */

/** Runs a domain effect synchronously on behalf of a legacy throwing
 * adapter. Typed failures are rethrown as the equivalent legacy exception
 * instance (see `toThrowable`); defects — which in this codebase are only
 * impossible internal invariant assertions — propagate verbatim, exactly as
 * the pre-Effect implementation threw them. */
export function runDomain<A>(effect: Effect.Effect<A, DomainFailure, never>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw toThrowable(failure.value);
  throw Cause.squash(exit.cause);
}

/** Parses a clock argument into epoch milliseconds, failing with a typed
 * `InvalidTimestampError` when the value is not a finite timestamp. Accepts
 * every clock shape the domain APIs take (`string | number | Date`). */
export function validTimestamp(now: string | number | Date): Effect.Effect<number, InvalidTimestampError, never> {
  return Effect.suspend(() => {
    const nowMs = typeof now === "string" ? Date.parse(now) : typeof now === "number" ? now : now.getTime();
    return Number.isFinite(nowMs) ? Effect.succeed(nowMs) : Effect.fail(new InvalidTimestampError({ param: "now" }));
  });
}
