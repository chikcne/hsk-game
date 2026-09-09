import { readFileSync } from "node:fs";
import { Data } from "effect";
import { z } from "zod";

/** cards/curriculum.json is missing, unparseable, or does not satisfy the
 * ordered curriculum contract. Fatal at startup — never defaulted. */
export class CurriculumError extends Data.TaggedError("CurriculumError")<{
  readonly path: string;
  readonly message: string;
}> {}

const CARD_ID_PATTERN = /^[0-9a-f]{24}$/;

/** One word's placement in the global curriculum. Mirrors the generator's
 * CurriculumEntrySchema (tools/sort-curriculum/types.ts); the containing
 * object's key insertion order IS the curriculum order. */
const CurriculumEntrySchema = z.object({
  file: z.string().min(1),
  hanzi: z.string().min(1),
  prerequisiteIds: z.array(z.string().regex(CARD_ID_PATTERN)),
  hskLevel: z.number().int().min(1).max(6),
}).strict();

export type CurriculumEntry = z.infer<typeof CurriculumEntrySchema>;

/**
 * The ordered global curriculum: a top-level insertion-ordered object keyed
 * by 24-hex card ID. Position 1 is the first key; position N the last. The
 * save database's `vocab.id` column stores these 1-based positions.
 */
export class Curriculum {
  private readonly entries: ReadonlyMap<string, CurriculumEntry>;
  readonly orderedCardIds: readonly string[];
  readonly size: number;

  private constructor(entries: ReadonlyMap<string, CurriculumEntry>) {
    this.entries = entries;
    this.orderedCardIds = [...entries.keys()];
    this.size = entries.size;
  }

  cardIdAt(position: number): string | undefined {
    return this.orderedCardIds[position - 1];
  }

  entryOf(cardId: string): CurriculumEntry | undefined {
    return this.entries.get(cardId);
  }

  static load(path: string): Curriculum {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new CurriculumError({ path, message: `Cannot read curriculum: ${String(cause)}` });
    }

    let document: unknown;
    try {
      document = JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new CurriculumError({ path, message: `Curriculum is not valid JSON: ${String(cause)}` });
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new CurriculumError({ path, message: "Curriculum must be a top-level object keyed by card ID" });
    }

    const entries = new Map<string, CurriculumEntry>();
    for (const [cardId, value] of Object.entries(document)) {
      if (!CARD_ID_PATTERN.test(cardId)) {
        throw new CurriculumError({ path, message: `Curriculum key "${cardId}" is not a 24-hex card ID` });
      }
      const parsed = CurriculumEntrySchema.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new CurriculumError({ path, message: `Curriculum entry "${cardId}" failed validation: ${issues}` });
      }
      entries.set(cardId, parsed.data);
    }
    if (entries.size === 0) {
      throw new CurriculumError({ path, message: "Curriculum is empty" });
    }
    // Order-critical contract: insertion order IS the curriculum. Every
    // prerequisite must sit at a strictly earlier position than its dependent,
    // and the effective HSK grade blocks must be nondecreasing (grade 1
    // through 6 after prerequisite hoisting). The generator and validator
    // guarantee both; the runtime loader enforces them.
    const positionByCardId = new Map<string, number>();
    let position = 0;
    for (const [cardId, entry] of entries) {
      position += 1;
      positionByCardId.set(cardId, position);
      if (entry.prerequisiteIds.includes(cardId)) {
        throw new CurriculumError({ path, message: `Curriculum entry "${cardId}" lists itself as a prerequisite` });
      }
      for (const prerequisiteId of entry.prerequisiteIds) {
        if (!entries.has(prerequisiteId)) {
          throw new CurriculumError({ path, message: `Curriculum entry "${cardId}" references unknown prerequisite "${prerequisiteId}"` });
        }
        const prerequisitePosition = positionByCardId.get(prerequisiteId);
        if (prerequisitePosition === undefined || prerequisitePosition >= position) {
          throw new CurriculumError({ path, message: `Curriculum entry "${cardId}" at position ${position} references prerequisite "${prerequisiteId}", which is not strictly earlier in curriculum order` });
        }
      }
    }
    let previousHskLevel = 0;
    for (const [cardId, entry] of entries) {
      if (entry.hskLevel < previousHskLevel) {
        throw new CurriculumError({ path, message: `Curriculum hskLevel blocks must be nondecreasing: entry "${cardId}" has hskLevel ${entry.hskLevel} after an earlier entry with hskLevel ${previousHskLevel}` });
      }
      previousHskLevel = entry.hskLevel;
    }
    return new Curriculum(entries);
  }
}
