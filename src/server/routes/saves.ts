import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CorruptSaveError,
  RevisionConflictError,
  type SaveRepository,
} from "../saves/repository";
import { parseSaveRequest } from "../saves/validation";
import type { DeckCatalog } from "../saves/manifests";

export type SaveRoutesOptions = {
  repository: SaveRepository;
  catalog?: DeckCatalog;
};

function errorResponse(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: "invalid_save",
      message: "The save request failed validation",
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  if (error instanceof RevisionConflictError) {
    return reply.code(409).send({
      error: "revision_conflict",
      message: error.message,
      current: error.current,
    });
  }
  if (error instanceof CorruptSaveError) {
    return reply.code(503).send({
      error: "save_corrupt",
      message: error.message,
      recovery: {
        canStartFresh: true,
        canDownloadQuarantined: error.quarantinedFile !== null,
        quarantinedFile: error.quarantinedFile,
        backupError: error.backupError,
      },
    });
  }
  throw error;
}

export async function registerSaveRoutes(
  app: FastifyInstance,
  options: SaveRoutesOptions,
): Promise<void> {
  const { repository, catalog } = options;

  app.get("/api/saves/default", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const loaded = await repository.load();
      if (loaded.recovery) {
        reply.header("x-hanzi-save-recovery", loaded.recovery.source);
        if (loaded.recovery.quarantinedFile) {
          reply.header("x-hanzi-quarantined-save", loaded.recovery.quarantinedFile);
        }
      }
      return loaded.save;
    } catch (error) {
      return errorResponse(error, reply);
    }
  });

  const save = async (body: unknown, reply: FastifyReply, beacon: boolean): Promise<unknown> => {
    reply.header("cache-control", "no-store");
    try {
      const decoded = typeof body === "string" ? JSON.parse(body) as unknown : body;
      const request = parseSaveRequest(decoded, catalog);
      const authoritative = await repository.save(request.expectedRevision, request.snapshot);
      return reply.code(beacon ? 202 : 200).send({
        revision: authoritative.revision,
        savedAt: authoritative.savedAt,
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return reply.code(400).send({ error: "invalid_json", message: "Request body is not valid JSON" });
      }
      return errorResponse(error, reply);
    }
  };

  app.put("/api/saves/default", async (request, reply) => save(request.body, reply, false));
  app.post("/api/saves/default/beacon", async (request, reply) => save(request.body, reply, true));
}
