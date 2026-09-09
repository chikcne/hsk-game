import { z } from "zod";

export const CURRICULUM_RULES_VERSION = "frequency-prerequisites-v1";
export const CURRICULUM_LESSON_SIZE = 20;

const CardIdSchema = z.string().regex(/^[0-9a-f]{24}$/);

/** One word's placement in the global curriculum. The containing object's
 * key insertion order — effective grade 1 through 6, scheduled order within
 * each grade — IS the curriculum order; there is deliberately no wrapper or
 * generator metadata around it. */
export const CurriculumEntrySchema = z.object({
  file: z.string().min(1),
  hanzi: z.string().min(1),
  prerequisiteIds: z.array(CardIdSchema),
  /** Effective grade after prerequisite closure; always `<=` the source
   * card's official directory level. */
  hskLevel: z.number().int().min(1).max(6),
}).strict();

export const CurriculumManifestSchema = z.record(CardIdSchema, CurriculumEntrySchema);

export type CurriculumEntry = z.infer<typeof CurriculumEntrySchema>;
export type CurriculumManifest = z.infer<typeof CurriculumManifestSchema>;

export type CurriculumLock = {
  schemaVersion: 1;
  rulesVersion: string;
  corpusSha256: string;
  topicsSha256: string;
  overridesSha256: string;
  cardsSha256: string;
  manifestSha256: string;
};
