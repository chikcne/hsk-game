import { Data } from "effect";

/**
 * Typed domain failures for every recoverable, expected-failure validation
 * path in `src/domain/**`. Each class mirrors the legacy exception that the
 * pre-Effect throwing adapters re-raise: the `message` getter reproduces the
 * original text verbatim, and `toThrowable` picks the original error class
 * (`Error` vs `RangeError`) so existing consumers and tests are unaffected.
 *
 * Impossible internal invariant assertions are deliberately NOT modeled
 * here; they stay plain defects (raw throws) so they never infect the
 * `Effect` error channels of pure APIs.
 */

/** A deck (or any word collection) repeats a word ID. */
export class DuplicateWordIdsError extends Data.TaggedError("DuplicateWordIdsError")<{}> {
  get message(): string { return "Deck word IDs must be unique"; }
}

/** A relearn session selection repeats a word key. */
export class DuplicateWordKeysError extends Data.TaggedError("DuplicateWordKeysError")<{}> {
  get message(): string { return "Relearn session word keys must be unique"; }
}

/** A word collection that must be nonempty is empty. */
export class EmptyWordSetError extends Data.TaggedError("EmptyWordSetError")<{
  readonly subject: "learning grade" | "relearn session";
}> {
  get message(): string {
    return this.subject === "learning grade"
      ? "A learning grade must contain at least one word"
      : "A relearn session needs at least one word";
  }
}

/** A clock argument does not parse to a finite epoch timestamp. */
export class InvalidTimestampError extends Data.TaggedError("InvalidTimestampError")<{
  readonly param: string;
}> {
  get message(): string { return `${this.param} must be a valid timestamp`; }
}

/** Progress recorded for one deck cannot be reconciled against another. */
export class DeckMismatchError extends Data.TaggedError("DeckMismatchError")<{
  readonly sourceDeckId: string;
  readonly deckId: string;
}> {
  get message(): string { return `Cannot reconcile ${this.sourceDeckId} progress with ${this.deckId}`; }
}

/** Persisted level progress violates one or more invariants. */
export class InvalidLevelProgressError extends Data.TaggedError("InvalidLevelProgressError")<{
  readonly violations: ReadonlyArray<string>;
}> {
  get message(): string { return `Invalid level progress:\n- ${this.violations.join("\n- ")}`; }
}

/** The save has no level progress record for the grade. */
export class MissingLevelProgressError extends Data.TaggedError("MissingLevelProgressError")<{
  readonly deckId: string;
}> {
  get message(): string { return `Missing level progress for ${this.deckId}`; }
}

/** A word ID is not part of the addressed grade's level progress. */
export class UnknownWordError extends Data.TaggedError("UnknownWordError")<{
  readonly wordId: string;
}> {
  get message(): string { return `Unknown word ID: ${this.wordId}`; }
}

/** A Learn session cannot be opened: nothing is due and no new curriculum
 * words remain (the "all caught up" state). */
export class NoLearnCandidatesError extends Data.TaggedError("NoLearnCandidatesError")<{}> {
  get message(): string { return "No learn candidates: nothing is due and no new curriculum words remain"; }
}

/** A numeric option that must be >= 0 is negative. */
export class NegativeLimitError extends Data.TaggedError("NegativeLimitError")<{
  readonly param: string;
}> {
  get message(): string { return `${this.param} must be nonnegative`; }
}

/** A numeric argument that must be a nonnegative integer is not one. */
export class NonNegativeIntegerError extends Data.TaggedError("NonNegativeIntegerError")<{
  readonly param: string;
}> {
  get message(): string { return `${this.param} must be a nonnegative integer`; }
}

/** A numeric argument that must be a positive integer is not one. */
export class PositiveIntegerError extends Data.TaggedError("PositiveIntegerError")<{
  readonly param: string;
}> {
  get message(): string { return `${this.param} must be a positive integer`; }
}

/** A numeric argument must be finite (not NaN/±Infinity). */
export class NonFiniteNumberError extends Data.TaggedError("NonFiniteNumberError")<{
  readonly param: string;
}> {
  get message(): string { return `${this.param} must be finite`; }
}

/** A relearn rating was applied while no relearn session is active. */
export class NoActiveRelearnSessionError extends Data.TaggedError("NoActiveRelearnSessionError")<{}> {
  get message(): string { return "No active relearn session"; }
}

/** The rated word key is not a member of the active relearn session. */
export class RelearnMembershipError extends Data.TaggedError("RelearnMembershipError")<{
  readonly wordKey: string;
}> {
  get message(): string { return `Word key is not a member of the active relearn session: ${this.wordKey}`; }
}

/** A cross-grade review word key has no `"deckId:wordId"` shape. */
export class InvalidReviewKeyError extends Data.TaggedError("InvalidReviewKeyError")<{
  readonly key: string;
}> {
  get message(): string { return `Invalid review word key: ${this.key}`; }
}

/** An xoshiro128** state is malformed or the forbidden all-zero state. */
export class InvalidRandomStateError extends Data.TaggedError("InvalidRandomStateError")<{
  readonly reason: "shape" | "all-zero";
}> {
  get message(): string {
    return this.reason === "shape"
      ? "xoshiro128** state must contain four uint32 values"
      : "xoshiro128** does not permit an all-zero state";
  }
}

/** Fewer seed bytes than required were provided. */
export class InsufficientSeedBytesError extends Data.TaggedError("InsufficientSeedBytesError")<{}> {
  get message(): string { return "At least 16 seed bytes are required"; }
}

/** The platform provides no cryptographic random source. */
export class CryptoUnavailableError extends Data.TaggedError("CryptoUnavailableError")<{}> {
  get message(): string { return "A cryptographic random source is unavailable"; }
}

/** A `RandomSource` implementation returned a value outside its contract. */
export class InvalidRandomOutputError extends Data.TaggedError("InvalidRandomOutputError")<{}> {
  get message(): string { return "RandomSource.nextUnit() must return a finite value in [0, 1)"; }
}

/** A meaning label contains no A-Z letter to anchor a choice shortcut on. */
export class MeaningWithoutLetterError extends Data.TaggedError("MeaningWithoutLetterError")<{
  readonly meaning: string;
}> {
  get message(): string { return `Meaning must contain A-Z: ${this.meaning}`; }
}

/** The deck cannot supply eight distractor meanings with unique shortcuts. */
export class InsufficientChoicesError extends Data.TaggedError("InsufficientChoicesError")<{
  readonly wordId: string;
}> {
  get message(): string { return `Not enough meanings with non-colliding shortcuts for ${this.wordId}`; }
}

/** Every typed recoverable failure the domain can produce. */
export type DomainFailure =
  | DuplicateWordIdsError
  | DuplicateWordKeysError
  | EmptyWordSetError
  | InvalidTimestampError
  | DeckMismatchError
  | InvalidLevelProgressError
  | MissingLevelProgressError
  | UnknownWordError
  | NoLearnCandidatesError
  | NegativeLimitError
  | NonNegativeIntegerError
  | PositiveIntegerError
  | NonFiniteNumberError
  | NoActiveRelearnSessionError
  | RelearnMembershipError
  | InvalidReviewKeyError
  | InvalidRandomStateError
  | InsufficientSeedBytesError
  | CryptoUnavailableError
  | InvalidRandomOutputError
  | MeaningWithoutLetterError
  | InsufficientChoicesError;

/** Converts a typed domain failure into the equivalent legacy exception
 * instance (same class — `Error` vs `RangeError` — and same message) so the
 * pre-Effect throwing adapters keep their exact observable behavior. */
export function toThrowable(failure: DomainFailure): Error {
  switch (failure._tag) {
    case "DuplicateWordIdsError": return new Error(failure.message);
    case "DuplicateWordKeysError": return new RangeError(failure.message);
    case "EmptyWordSetError": return new RangeError(failure.message);
    case "InvalidTimestampError": return new RangeError(failure.message);
    case "DeckMismatchError": return new Error(failure.message);
    case "InvalidLevelProgressError": return new Error(failure.message);
    case "MissingLevelProgressError": return new Error(failure.message);
    case "UnknownWordError": return new Error(failure.message);
    case "NoLearnCandidatesError": return new RangeError(failure.message);
    case "NegativeLimitError": return new RangeError(failure.message);
    case "NonNegativeIntegerError": return new RangeError(failure.message);
    case "PositiveIntegerError": return new RangeError(failure.message);
    case "NonFiniteNumberError": return new RangeError(failure.message);
    case "NoActiveRelearnSessionError": return new Error(failure.message);
    case "RelearnMembershipError": return new Error(failure.message);
    case "InvalidReviewKeyError": return new Error(failure.message);
    case "InvalidRandomStateError": return new RangeError(failure.message);
    case "InsufficientSeedBytesError": return new RangeError(failure.message);
    case "CryptoUnavailableError": return new Error(failure.message);
    case "InvalidRandomOutputError": return new RangeError(failure.message);
    case "MeaningWithoutLetterError": return new Error(failure.message);
    case "InsufficientChoicesError": return new Error(failure.message);
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}
