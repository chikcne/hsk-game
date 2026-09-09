import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BattleConfigError, loadBattleConfig } from "./config";
import { FastifyPluginError, FsError, normalizeError } from "./errors";
import { FileSystem } from "./filesystem";
import { runPromiseUnchecked } from "./runtime";
import { registerSaveRoutes } from "./routes/saves";
import { Curriculum, CurriculumError } from "./saves/curriculum";
import { BattleSaveRepository, SaveDatabaseError } from "./saves/repository";

/** Paths resolve from the repository root regardless of the process cwd, so
 * dev (`tsx watch`), tests, and production (`tsx src/server/index.ts`) all
 * find config/, cards/, and saves/. */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type BuildAppOptions = {
  saveDirectory?: string;
  curriculumPath?: string;
  configPath?: string;
  repository?: BattleSaveRepository;
  serveStatic?: boolean;
  publicDirectory?: string;
  logger?: FastifyServerOptions["logger"];
};

export type BuildAppError = FsError | FastifyPluginError | BattleConfigError | CurriculumError | SaveDatabaseError;

export const buildAppEffect = (
  options: BuildAppOptions = {},
): Effect.Effect<FastifyInstance, BuildAppError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const app = Fastify({
      logger: options.logger ?? false,
    });

    // The battle tuning YAML and the ordered curriculum are parsed and
    // strictly validated exactly once at startup; any violation is fatal and
    // never defaulted.
    const configPath = options.configPath ?? join(repositoryRoot, "config/battle.yaml");
    const battleConfig = yield* Effect.try({
      try: () => loadBattleConfig(configPath),
      catch: (cause): BattleConfigError =>
        cause instanceof BattleConfigError ? cause : new BattleConfigError({ path: configPath, message: String(cause) }),
    });

    const curriculumPath = options.curriculumPath ?? join(repositoryRoot, "cards/curriculum.json");
    const curriculum = yield* Effect.try({
      try: () => Curriculum.load(curriculumPath),
      catch: (cause): CurriculumError =>
        cause instanceof CurriculumError ? cause : new CurriculumError({ path: curriculumPath, message: String(cause) }),
    });

    // The SQLite save database (default saves/default.sql) is initialized
    // only when missing; an existing incompatible file fails loudly here.
    const saveDirectory = options.saveDirectory ?? join(repositoryRoot, "saves");
    const repository = options.repository ?? (yield* Effect.try({
      try: () => new BattleSaveRepository({ directory: saveDirectory, curriculum, battleConfig }),
      catch: (cause): SaveDatabaseError =>
        cause instanceof SaveDatabaseError ? cause : SaveDatabaseError.wrap(saveDirectory, cause),
    }));
    const ownsRepository = options.repository === undefined;
    if (ownsRepository) {
      app.addHook("onClose", () => {
        repository.close();
      });
    }

    yield* Effect.sync(() => {
      app.get("/api/health", () => ({ status: "ok" }));
      registerSaveRoutes(app, { repository });
    });

    const shouldServeStatic = options.serveStatic ?? process.env.NODE_ENV === "production";
    if (shouldServeStatic) {
      const root = options.publicDirectory ?? join(repositoryRoot, "dist");
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
