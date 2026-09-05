import { z } from "zod";

/** The `acard/1` on-disk source format: one logical word per file, under
 * `cards/hsk-<grade>/`. An `.acard` stores *semantic* content only — anything
 * the compiler can recompute (`hanziKey`, `meaningKey`, `acceptedPinyin`,
 * `partOfSpeechKey`, the whole-deck meaning indexes, the deck fingerprint) is
 * deliberately absent so it cannot drift from its source of truth.
 *
 * `id` is the one stored derived value. It is re-derived and compared on every
 * read, which turns "an unrelated gloss edit silently repointed a word's
 * identity" into a build error.
 *
 * There is no `example` field: the source decks' sentences are carved out of
 * their own CC BY-NC-SA grant and nothing under `src/` renders them. See
 * designs/resorting/acard_structure.md §4.3. */
export const ACARD_SCHEMA = "acard/1";

/** Coarse frequency bucket the sorter groups on. Ordering inside a tier uses
 * `rank`, so a small wobble in the underlying corpus count can never reshuffle
 * a lesson across tier boundaries. */
export const FREQUENCY_TIERS = ["core", "common", "mid", "tail"] as const;
export type FrequencyTier = (typeof FREQUENCY_TIERS)[number];

const HskGradeSchema = z.number().int().min(1).max(6);

/** Hand-forced placement. Every non-null `pin` requires a non-null `notes`
 * (enforced in `AcardSchema`'s refinement), so no unexplained hand-placement
 * survives review. */
export const AcardPinSchema = z.union([
  z.object({ before: z.string().min(1) }).strict(),
  z.object({ after: z.string().min(1) }).strict(),
  z.object({ index: z.number().int().nonnegative() }).strict(),
]);

export const AcardCurriculumSchema = z
  .object({
    /** In-corpus words contained in `hanzi` — single characters plus shorter
     * multi-character words. Derived, but stored because it is the input to
     * the component-before-compound constraint and reviewers need to see it.
     * The compiler recomputes and diffs it. */
    components: z.array(z.string().min(1)),
    frequency: z
      .object({
        rank: z.number().int().positive().nullable(),
        source: z.string().min(1),
        tier: z.enum(FREQUENCY_TIERS),
      })
      .strict()
      .nullable(),
    /** Effective grade after component hoisting; always `<= level`. Source
     * files remain in their official-grade directory. */
    grade: HskGradeSchema,
    notes: z.string().min(1).nullable(),
    pin: AcardPinSchema.nullable(),
    /** Controlled vocabulary from `cards/topics.json`; `topics[0]` is the
     * block the card sorts into. */
    topics: z.array(z.string().min(1)),
  })
  .strict();

export const AcardSourceSchema = z
  .object({
    deck: z.string().min(1),
    guids: z.array(z.string().min(1)).min(1),
    /** Reviewed corrections applied during extraction, by source GUID. */
    overrides: z.array(z.object({ guid: z.string().min(1), reason: z.string().min(1) }).strict()),
    sharedId: z.number().int().positive(),
  })
  .strict();

export const AcardSchema = z
  .object({
    schema: z.literal(ACARD_SCHEMA),
    /** Filename in `cards/audio/`, equal to its own content SHA-256. */
    audio: z.string().regex(/^[0-9a-f]{64}\.mp3$/).nullable(),
    curriculum: AcardCurriculumSchema,
    hanzi: z.string().min(1),
    /** Stable 24-hex logical hash. Immutable; re-derived on read. */
    id: z.string().regex(/^[0-9a-f]{24}$/),
    /** Official HSK grade from the source deck. Immutable. */
    level: HskGradeSchema,
    meaning: z.string().min(1),
    pinyin: z.string().min(1),
    pos: z.string().min(1).nullable(),
    senseLabel: z.string().min(1).nullable(),
    source: AcardSourceSchema,
  })
  .strict()
  .superRefine((card, ctx) => {
    if (card.curriculum.pin && card.curriculum.notes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["curriculum", "notes"],
        message: "a non-null pin requires notes explaining it",
      });
    }
    if (card.curriculum.grade > card.level) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["curriculum", "grade"],
        message: `curriculum.grade ${card.curriculum.grade} exceeds official level ${card.level}`,
      });
    }
  });

export type Acard = z.infer<typeof AcardSchema>;
export type AcardCurriculum = z.infer<typeof AcardCurriculumSchema>;

/** Permitted characters in a card filename stem: Han ideographs plus the
 * `〇` allowlist, optionally disambiguated by canonical pinyin and then by an
 * id prefix. Mirrors the naming rule in acard_structure.md §3.1. */
export const ACARD_FILENAME_PATTERN = /^[\p{Script=Han}〇]+(__[a-z]+(__[0-9a-f]{8})?)?\.acard$/u;

/** Deterministic filename for a card, given the names already taken in its
 * directory. Tier 1 is the Hanzi alone; 62 Hanzi occur more than once across
 * the corpus (好 hǎo vs hào, 会, 只, 本…), so tier 2 appends the canonical
 * ASCII pinyin and tier 3 the first eight characters of the stable id. */
export function acardFilename(
  hanzi: string,
  acceptedPinyin: string,
  id: string,
  taken: ReadonlySet<string>,
): string {
  const candidates = [`${hanzi}.acard`, `${hanzi}__${acceptedPinyin}.acard`, `${hanzi}__${acceptedPinyin}__${id.slice(0, 8)}.acard`];
  for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
  throw new Error(`Cannot derive a unique .acard filename for ${hanzi} (${acceptedPinyin}, ${id})`);
}
