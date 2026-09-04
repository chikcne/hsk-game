import { Cause, Effect, Exit } from "effect";

/** Runs an effect, rejecting the promise with its original error instead of an
 * Effect `FiberFailure` wrapper, so non-Effect consumers (tests, Fastify
 * error handling) can keep `instanceof` checks against the typed errors. */
export const runPromiseUnchecked = <A, E extends Error>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
