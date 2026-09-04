import { Effect, Either } from "effect";

/**
 * Promise compatibility adapter for framework and legacy test boundaries.
 * Effect.runPromise wraps typed failures in a FiberFailure; this adapter keeps
 * the original tagged error as the Promise rejection while the application
 * program itself remains Effect-native.
 */
export function runPromiseWithTypedError<A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> {
  return Effect.runPromise(Effect.either(effect)).then((result) => {
    if (Either.isLeft(result)) throw result.left;
    return result.right;
  });
}

/** Synchronous compatibility adapter that preserves the typed error identity. */
export function runSyncWithTypedError<A, E>(
  effect: Effect.Effect<A, E, never>,
): A {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}
