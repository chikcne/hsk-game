import type { FastifyInstance, FastifyReply } from "fastify";
import { Effect } from "effect";
import { FsError, JsonParseError, normalizeError } from "../errors";
import { FileSystem } from "../filesystem";
import { runPromiseUnchecked } from "../runtime";
import type { AtomicWriteError } from "../saves/atomic-writer";
import type { DeckCatalog } from "../saves/manifests";
import { RevisionConflictError, type SaveRepository } from "../saves/repository";
import { parseSaveRequestEffect, SaveValidationError } from "../saves/validation";

export type SaveRoutesOptions = {
  repository: SaveRepository;
  catalog?: DeckCatalog;
};

const setNoStore = (reply: FastifyReply): Effect.Effect<void, never, never> =>
  Effect.sync(() => reply.header("cache-control", "no-store"));

const sendJson = (reply: FastifyReply, code: number, payload: unknown): Effect.Effect<void, never, never> =>
  Effect.sync(() => reply.code(code).send(payload));

const decodeJsonBody = (body: string): Effect.Effect<unknown, JsonParseError, never> =>
  Effect.try({ try: () => JSON.parse(body) as unknown, catch: (cause) => new JsonParseError({ cause: normalizeError(cause) }) });

export function registerSaveRoutes(app: FastifyInstance, options: SaveRoutesOptions): void {
  const { repository, catalog } = options;

  const loadDefault = (reply: FastifyReply): Effect.Effect<void, FsError, FileSystem> =>
    Effect.gen(function* () {
      yield* setNoStore(reply);
      const loaded = yield* repository.loadEffect();
      yield* sendJson(reply, 200, loaded.save);
    });

  /** Expected failures map onto their API responses; unexpected failures
   * (e.g. fs errors) reject the handler promise and become Fastify 500s. */
  const save = (
    body: unknown,
    reply: FastifyReply,
    beacon: boolean,
  ): Effect.Effect<void, FsError | AtomicWriteError, FileSystem> =>
    Effect.gen(function* () {
      yield* setNoStore(reply);
      const decoded = typeof body === "string" ? yield* decodeJsonBody(body) : body;
      const request = yield* parseSaveRequestEffect(decoded, catalog);
      const authoritative = yield* repository.saveEffect(request.expectedRevision, request.snapshot);
      yield* sendJson(reply, beacon ? 202 : 200, {
        revision: authoritative.revision,
        savedAt: authoritative.savedAt,
      });
    }).pipe(
      Effect.catchTags({
        JsonParseError: () =>
          sendJson(reply, 400, { error: "invalid_json", message: "Request body is not valid JSON" }),
        SaveValidationError: (error) =>
          sendJson(reply, 400, {
            error: "invalid_save",
            message: "The save request failed validation",
            issues: error.cause.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          }),
        RevisionConflictError: (error) =>
          sendJson(reply, 409, {
            error: "revision_conflict",
            message: error.message,
            current: error.current,
          }),
      }),
    );

  // Each Fastify handler is a thin Effect boundary; rejections surface the
  // original error (no FiberFailure wrapper) for Fastify's error logger.
  app.get("/api/saves/default", (_request, reply) =>
    runPromiseUnchecked(loadDefault(reply).pipe(Effect.provide(FileSystem.layer))));
  app.put("/api/saves/default", (request, reply) =>
    runPromiseUnchecked(save(request.body, reply, false).pipe(Effect.provide(FileSystem.layer))));
  app.post("/api/saves/default/beacon", (request, reply) =>
    runPromiseUnchecked(save(request.body, reply, true).pipe(Effect.provide(FileSystem.layer))));
}
