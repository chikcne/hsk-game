import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { BattleOutcomeSchema } from "../../shared/battle";
import { SettingsSchema } from "../../shared/schemas";
import type { BattleSaveRepository } from "../saves/repository";

export type SaveRoutesOptions = {
  repository: BattleSaveRepository;
};

/** Curriculum card IDs are 24-character hex strings (see the ordered
 * curriculum manifest and the generator's CurriculumEntrySchema). */
const CARD_ID_PATTERN = /^[0-9a-f]{24}$/;

/** POST /api/saves/default/vocab/:cardId/outcome body. */
const OutcomeRequestSchema = z.object({
  outcome: BattleOutcomeSchema,
}).strict();

/** PUT /api/saves/default/settings body. */
const SettingsRequestSchema = z.object({
  settings: SettingsSchema.strict(),
}).strict();

const issueList = (error: z.ZodError): Array<{ path: (string | number)[]; message: string }> =>
  error.issues.map((issue) => ({ path: issue.path, message: issue.message }));

/**
 * The four Battle save endpoints:
 *
 * - GET  /api/saves/default
 *       -> { settings, vocab, battleConfig }
 * - POST /api/saves/default/battle/open
 *       -> { vocab, addedRows }  (atomically seeds/refills the learning slots)
 * - POST /api/saves/default/vocab/:cardId/outcome  body { outcome }
 *       -> { row, addedRows }    (atomic curve delta/clamp/time_mastered + refill)
 * - PUT  /api/saves/default/settings  body { settings }
 *       -> the validated, persisted settings
 *
 * The repository serializes every mutation through SQLite transactions, so
 * these handlers only translate validation and lookup outcomes into status
 * codes. Unexpected repository failures reject the handler and surface as
 * Fastify 500s.
 */
export function registerSaveRoutes(app: FastifyInstance, options: SaveRoutesOptions): void {
  const { repository } = options;

  const noStore = (reply: FastifyReply): void => {
    reply.header("cache-control", "no-store");
  };

  app.get("/api/saves/default", (_request, reply) => {
    noStore(reply);
    return repository.getState();
  });

  app.post("/api/saves/default/battle/open", (_request, reply) => {
    noStore(reply);
    return repository.openBattle();
  });

  app.post("/api/saves/default/vocab/:cardId/outcome", (request, reply) => {
    noStore(reply);
    const { cardId } = request.params as { cardId?: string };
    if (typeof cardId !== "string" || !CARD_ID_PATTERN.test(cardId)) {
      return reply.code(400).send({ error: "invalid_card_id", message: "cardId must be a 24-hex curriculum card ID" });
    }
    const parsed = OutcomeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_outcome", message: "body must be { outcome } with a correct/secondChance/wrong outcome", issues: issueList(parsed.error) });
    }
    const outcome = repository.applyOutcome(cardId, parsed.data.outcome);
    if (outcome === null) {
      return reply.code(404).send({ error: "unknown_card", message: `card ${cardId} is not in the vocab pool` });
    }
    return outcome;
  });

  app.put("/api/saves/default/settings", (request, reply) => {
    noStore(reply);
    const parsed = SettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_settings", message: "body must be { settings } with valid Battle settings", issues: issueList(parsed.error) });
    }
    // Input already validated; updateSettings re-parses defensively and only
    // throws on database-level failures.
    return repository.updateSettings(parsed.data.settings);
  });
}
