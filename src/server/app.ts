import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { Effect } from "effect";
import { resolve } from "node:path";
import { DeckManifestError, FastifyPluginError, FsError, normalizeError } from "./errors";
import { FileSystem } from "./filesystem";
import { runPromiseUnchecked } from "./runtime";
import { registerSaveRoutes } from "./routes/saves";
import { loadDeckCatalog, type DeckCatalog } from "./saves/manifests";
import { MAX_SAVE_BYTES, SaveRepository } from "./saves/repository";

export type BuildAppOptions = {
  saveDirectory?: string;
  gameDataDirectory?: string;
  publicDirectory?: string;
  repository?: SaveRepository;
  catalog?: DeckCatalog;
  serveStatic?: boolean;
  logger?: FastifyServerOptions["logger"];
};

export type BuildAppError = FsError | DeckManifestError | FastifyPluginError;

export const buildAppEffect = (
  options: BuildAppOptions = {},
): Effect.Effect<FastifyInstance, BuildAppError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const app = Fastify({
      logger: options.logger ?? false,
      bodyLimit: MAX_SAVE_BYTES,
    });

    // navigator.sendBeacon(string) uses text/plain; the route still applies the
    // exact same JSON and save schema validation as PUT.
    yield* Effect.sync(() => {
      app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
        done(null, body);
      });
    });

    const gameDataDirectory = options.gameDataDirectory ?? resolve("public/game-data");
    const catalog = options.catalog ?? (yield* loadDeckCatalog(gameDataDirectory));
    const repository = options.repository ?? new SaveRepository({
      directory: options.saveDirectory ?? resolve("saves"),
      catalog,
    });
    yield* repository.initializeEffect();

    yield* Effect.sync(() => {
      app.get("/api/health", () => ({ status: "ok" }));
      registerSaveRoutes(app, { repository, catalog });
    });

    const shouldServeStatic = options.serveStatic ?? process.env.NODE_ENV === "production";
    if (shouldServeStatic) {
      const root = options.publicDirectory ?? resolve("dist");
      yield* fs.access(root);
      yield* Effect.tryPromise({
        try: () => app.register(staticPlugin, { root, prefix: "/" }),
        catch: (cause) => new FastifyPluginError({ plugin: "@fastify/static", cause: normalizeError(cause) }),
      });
      yield* Effect.sync(() => {
        app.setNotFoundHandler((request, reply) => {
          if (request.url.startsWith("/api/")) {
            return reply.code(404).send({ error: "not_found" });
          }
          return reply.type("text/html; charset=utf-8").sendFile("index.html");
        });
      });
    }

    return app;
  });

/** Thin `Effect.runPromise` boundary for non-Effect consumers (tests, `tsx`). */
export const buildApp = (options: BuildAppOptions = {}): Promise<FastifyInstance> =>
  runPromiseUnchecked(buildAppEffect(options).pipe(Effect.provide(FileSystem.layer)));
