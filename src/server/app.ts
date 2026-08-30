import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_SAVE_BYTES,
  });

  // navigator.sendBeacon(string) uses text/plain; the route still applies the
  // exact same JSON and save schema validation as PUT.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  const gameDataDirectory = options.gameDataDirectory ?? resolve("public/game-data");
  const catalog = options.catalog ?? await loadDeckCatalog(gameDataDirectory);
  const repository = options.repository ?? new SaveRepository({
    directory: options.saveDirectory ?? resolve("saves"),
    catalog,
  });
  await repository.initialize();

  app.get("/api/health", async () => ({ status: "ok" }));
  await registerSaveRoutes(app, { repository, catalog });

  const shouldServeStatic = options.serveStatic ?? process.env.NODE_ENV === "production";
  if (shouldServeStatic) {
    const root = options.publicDirectory ?? resolve("dist");
    await access(root);
    await app.register(staticPlugin, { root, prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    });
  }

  return app;
}
