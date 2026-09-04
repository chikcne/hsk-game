import { Data, Effect } from "effect";
import { sanitizeText } from "./text";

export type NormalizedHanzi = {
  displayHanzi: string;
  hanziKey: string;
  senseLabel: string | null;
  nfkcChanged: boolean;
};

/** Typed failure for Hanzi normalization (empty residue or non-CJK characters). */
export class HanziError extends Data.TaggedError("HanziError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Effect pipeline for normalizing a source Hanzi field into display/key forms,
 * extracting any trailing sense label along the way. */
export const normalizeHanziEffect = (input: string): Effect.Effect<NormalizedHanzi, HanziError, never> =>
  Effect.gen(function* () {
    const sanitized = sanitizeText(input);
    let value = sanitized.normalize("NFKC").trim();
    const nfkcChanged = value !== sanitized;
    value = value.replace(/\.\s*$/u, "").trim();

    let senseLabel: string | null = null;
    const qualifier = /\s*\(([^()]+)\)\s*$/u.exec(value);
    if (qualifier) {
      senseLabel = sanitizeText(qualifier[1]!);
      value = value.slice(0, qualifier.index).trim();
    } else {
      const numbered = /(?<=\p{Unified_Ideograph}|〇)\s*([12])\s*$/u.exec(value);
      if (numbered) {
        senseLabel = `sense ${numbered[1]}`;
        value = value.slice(0, numbered.index).trim();
      }
    }

    if (!value) {
      return yield* Effect.fail(new HanziError({ detail: `Hanzi is empty after normalization: ${JSON.stringify(input)}` }));
    }
    if (![...value].every((character) => /^(?:\p{Unified_Ideograph}|〇|·)$/u.test(character))) {
      return yield* Effect.fail(new HanziError({
        detail: `Unexpected non-CJK residue in Hanzi ${JSON.stringify(input)} -> ${JSON.stringify(value)}`,
      }));
    }
    return { displayHanzi: value.normalize("NFC"), hanziKey: value.normalize("NFKC"), senseLabel, nfkcChanged };
  });

// --- compatibility boundary ---------------------------------------------------
// The original module API was sync-throwing and is preserved for the test suite.

/** Synchronous boundary: throws the typed `HanziError` on failure. */
export function normalizeHanzi(input: string): NormalizedHanzi {
  return Effect.runSync(normalizeHanziEffect(input));
}
