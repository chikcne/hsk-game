import { z } from "zod";

export const CURRICULUM_RULES_VERSION = "frequency-prerequisites-v1";
export const CURRICULUM_LESSON_SIZE = 20;

export const ManifestCardSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  file: z.string().min(1),
  hanzi: z.string().min(1),
  prerequisiteIds: z.array(z.string().regex(/^[0-9a-f]{24}$/)),
}).strict();

export const CurriculumManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generator: z.object({
    name: z.literal("sort-curriculum"),
    version: z.literal("1.0.0"),
    rulesVersion: z.string().min(1),
  }).strict(),
  lessonSize: z.literal(20),
  levels: z.array(z.object({
    deckId: z.enum(["hsk-1", "hsk-2", "hsk-3", "hsk-4", "hsk-5", "hsk-6"]),
    hskLevel: z.number().int().min(1).max(6),
    cardCount: z.number().int().positive(),
    lessons: z.array(z.object({
      id: z.string().min(1),
      cards: z.array(ManifestCardSchema).min(1).max(CURRICULUM_LESSON_SIZE),
    }).strict()).min(1),
  }).strict()).length(6),
}).strict();

export type ManifestCard = z.infer<typeof ManifestCardSchema>;
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
