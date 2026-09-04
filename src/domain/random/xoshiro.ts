import { Effect } from "effect";
import { runDomain } from "../effect";
import { CryptoUnavailableError, InsufficientSeedBytesError, InvalidRandomStateError } from "../errors";
import type { RandomSource, RandomState } from "./types";

const UINT32_RANGE = 0x1_0000_0000;

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function validateState(state: readonly number[]): asserts state is RandomState {
  if (
    state.length !== 4 ||
    state.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff)
  ) {
    throw new RangeError("xoshiro128** state must contain four uint32 values");
  }
  if (state.every((word) => word === 0)) {
    throw new RangeError("xoshiro128** does not permit an all-zero state");
  }
}

/** Serializable xoshiro128** (Blackman/Vigna) random source.
 *
 * The constructor keeps its throwing validation (the RNG contract is a
 * programming invariant); typed construction goes through
 * {@link makeXoshiro128StarStar}. */
export class Xoshiro128StarStar implements RandomSource {
  readonly #words: RandomState;

  constructor(state: readonly [number, number, number, number]) {
    validateState(state);
    this.#words = [state[0] >>> 0, state[1] >>> 0, state[2] >>> 0, state[3] >>> 0];
  }

  nextUint32(): number {
    const s = this.#words;
    const result = Math.imul(rotateLeft(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const temporary = (s[1] << 9) >>> 0;

    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ temporary) >>> 0;
    s[3] = rotateLeft(s[3], 11);

    return result;
  }

  nextUnit(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  state(): RandomState {
    return [...this.#words];
  }
}

/** Typed constructor for {@link Xoshiro128StarStar}: fails with an
 * `InvalidRandomStateError` for malformed or all-zero states instead of
 * throwing from a class constructor. */
export function makeXoshiro128StarStar(state: readonly [number, number, number, number]): Effect.Effect<Xoshiro128StarStar, InvalidRandomStateError, never> {
  return Effect.suspend(() => {
    if (state.length !== 4 || state.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff)) {
      return Effect.fail(new InvalidRandomStateError({ reason: "shape" }));
    }
    if (state.every((word) => word === 0)) return Effect.fail(new InvalidRandomStateError({ reason: "all-zero" }));
    return Effect.succeed(new Xoshiro128StarStar(state));
  });
}

/** Deterministically derives a valid state from a string (useful for tests/session streams). */
export function randomStateFromSeed(seed: string): RandomState {
  // cyrb128 is a compact, stable 128-bit string mixer. It is not used for security.
  let h1 = 1_779_033_703;
  let h2 = 3_144_134_277;
  let h3 = 1_013_904_242;
  let h4 = 2_773_480_762;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);
  const state: RandomState = [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
  if (state.every((word) => word === 0)) state[0] = 1;
  return state;
}

/** Derives state from raw seed bytes; all-zero outcomes are repaired.
 * Fails with an `InsufficientSeedBytesError` instead of throwing a
 * `RangeError` when fewer than 16 bytes are provided. */
export function randomStateFromBytesEffect(bytes: Uint8Array): Effect.Effect<RandomState, InsufficientSeedBytesError, never> {
  return Effect.gen(function* () {
    if (bytes.byteLength < 16) return yield* Effect.fail(new InsufficientSeedBytesError());
    return yield* Effect.sync(() => randomStateFromBytesUnchecked(bytes));
  });
}

function randomStateFromBytesUnchecked(bytes: Uint8Array): RandomState {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state: RandomState = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];
  if (state.every((word) => word === 0)) state[0] = 1;
  return state;
}

export function randomStateFromBytes(bytes: Uint8Array): RandomState {
  return runDomain(randomStateFromBytesEffect(bytes));
}

/** Typed variant of {@link createSecureRandomState}: fails with a
 * `CryptoUnavailableError` when the platform has no WebCrypto, or an
 * `InsufficientSeedBytesError` should the platform return short buffers. */
export function createSecureRandomStateEffect(): Effect.Effect<RandomState, CryptoUnavailableError | InsufficientSeedBytesError, never> {
  return Effect.gen(function* () {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi === undefined) return yield* Effect.fail(new CryptoUnavailableError());
    return yield* randomStateFromBytesEffect(cryptoApi.getRandomValues(new Uint8Array(16)));
  });
}

/** Creates first-run state from the platform cryptographic random generator. */
export function createSecureRandomState(): RandomState {
  return runDomain(createSecureRandomStateEffect());
}
