import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import { MAX_SAVE_BYTES } from "../../src/server/saves/repository";
import { makeSnapshot } from "./helpers";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hanzi-api-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeApp() {
  const root = await temporaryDirectory();
  const app = await buildApp({
    saveDirectory: join(root, "saves"),
    gameDataDirectory: join(root, "game-data"),
    serveStatic: false,
  });
  return { root, app };
}

describe("save API", () => {
  it("serves health and a valid first-run save", async () => {
    const { app } = await makeApp();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const response = await app.inject({ method: "GET", url: "/api/saves/default" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ schemaVersion: 2, profileId: "default", revision: 0 });
    await app.close();
  });

  it("accepts PUT, increments revision, and rejects a stale tab", async () => {
    const { app } = await makeApp();
    const payload = { expectedRevision: 0, snapshot: makeSnapshot() };
    const accepted = await app.inject({ method: "PUT", url: "/api/saves/default", payload });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ revision: 1 });

    const conflict = await app.inject({ method: "PUT", url: "/api/saves/default", payload });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "revision_conflict", current: { revision: 1 } });
    await app.close();
  });

  it("accepts a validated text/plain pagehide beacon", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/saves/default/beacon",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: JSON.stringify({ expectedRevision: 0, snapshot: makeSnapshot() }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ revision: 1 });
    await app.close();
  });

  it("returns 400 for malformed JSON, invalid schema, and out-of-range values", async () => {
    const { app } = await makeApp();
    const malformed = await app.inject({
      method: "PUT",
      url: "/api/saves/default",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);

    const snapshot = makeSnapshot();
    snapshot.settings.spawnIntervalMs = 100;
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/saves/default",
      payload: { expectedRevision: 0, snapshot },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_save" });
    await app.close();
  });

  it("rejects request bodies over the configured save limit", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/saves/default",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(MAX_SAVE_BYTES) }),
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it("does not expose profile or path parameters", async () => {
    const { app } = await makeApp();
    for (const url of ["/api/saves/other", "/api/saves/default/..%2Fsecret", "/api/saves/default.json"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("reports quarantine rather than replacing corruption", async () => {
    const { root, app } = await makeApp();
    await writeFile(join(root, "saves", "default.json"), "broken");
    const response = await app.inject({ method: "GET", url: "/api/saves/default" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "save_corrupt",
      recovery: { canStartFresh: true, canDownloadQuarantined: true },
    });
    await app.close();
  });
});

describe("production static server", () => {
  it("serves built assets and falls back to index.html outside /api", async () => {
    const root = await temporaryDirectory();
    const dist = join(root, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.html"), "<!doctype html><title>Ziduoduo</title>");
    await writeFile(join(dist, "asset.txt"), "local asset");
    const app = await buildApp({
      saveDirectory: join(root, "saves"),
      gameDataDirectory: join(root, "game-data"),
      publicDirectory: dist,
      serveStatic: true,
    });

    expect((await app.inject({ method: "GET", url: "/asset.txt" })).body).toBe("local asset");
    expect((await app.inject({ method: "GET", url: "/battle/hsk-1" })).body).toContain("Ziduoduo");
    expect((await app.inject({ method: "GET", url: "/api/unknown" })).statusCode).toBe(404);
    await app.close();
  });
});
