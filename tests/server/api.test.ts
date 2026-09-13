import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import { loadBattleConfig } from "../../src/server/config";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";

import { cleanupDirectories, temporaryDirectory, writeCurriculumFixture } from "./helpers";

afterEach(cleanupDirectories);

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
// The real tuning source of truth, loaded the same way the server loads it —
// these tests assert behavior, not any particular set of numbers.
const battleConfig = loadBattleConfig(join(repositoryRoot, "config/battle.yaml"));

async function makeApp(curriculumCount = 8) {
  const root = await temporaryDirectory("hanzi-api-");
  const fixture = await writeCurriculumFixture(curriculumCount);
  const app = await buildApp({
    saveDirectory: join(root, "saves"),
    curriculumPath: fixture.path,
    // No configPath: the real config/battle.yaml must load and validate.
    serveStatic: false,
  });
  return { root, fixture, app };
}

describe("save API", () => {
  it("serves health and a fresh first-run save state from the real YAML", async () => {
    const { app } = await makeApp();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const response = await app.inject({ method: "GET", url: "/api/saves/default" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      settings: DEFAULT_SETTINGS,
      vocab: [],
      battleConfig,
    });
    await app.close();
  });

  it("battle open seeds five slots and is idempotent", async () => {
    const { fixture, app } = await makeApp();
    const first = await app.inject({ method: "POST", url: "/api/saves/default/battle/open" });
    expect(first.statusCode).toBe(200);
    const opened = first.json();
    expect(opened.addedRows.map((row: { id: number }) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(opened.vocab).toEqual(opened.addedRows);

    const second = await app.inject({ method: "POST", url: "/api/saves/default/battle/open" });
    expect(second.statusCode).toBe(200);
    expect(second.json().addedRows).toEqual([]);
    expect(second.json().vocab).toHaveLength(5);
    expect(fixture.cardIds).toHaveLength(8);
    await app.close();
  });

  it("outcome updates mastery and refills on graduation", async () => {
    const { fixture, app } = await makeApp();
    await app.inject({ method: "POST", url: "/api/saves/default/battle/open" });
    const url = `/api/saves/default/vocab/${fixture.cardIds[2]}/outcome`;

    // Answers at the midpoint speed each earn masteryCurve.midGain. Enough of
    // them to reach but not exceed lowMax keep the word in the low category
    // (no refill); one more graduates the slot.
    const { midGain, midMsPerChar } = battleConfig.masteryCurve;
    const lowMax = battleConfig.boundaries.lowMax;
    const stayingAnswers = Math.floor(lowMax / midGain);
    for (let index = 0; index < stayingAnswers; index += 1) {
      const response = await app.inject({ method: "POST", url, payload: { outcome: { kind: "correct", answerMs: midMsPerChar, charCount: 1 } } });
      expect(response.statusCode).toBe(200);
      expect(response.json().addedRows).toEqual([]);
    }
    // Graduation: mastery crosses lowMax and position 6 is appended.
    const graduated = await app.inject({ method: "POST", url, payload: { outcome: { kind: "correct", answerMs: midMsPerChar, charCount: 1 } } });
    expect(graduated.statusCode).toBe(200);
    const body = graduated.json();
    expect(body.row).toMatchObject({ id: 3, cardId: fixture.cardIds[2], mastery: Math.min(100, (stayingAnswers + 1) * midGain) });
    expect(body.addedRows.map((row: { id: number }) => row.id)).toEqual([6]);

    const state = await app.inject({ method: "GET", url: "/api/saves/default" });
    expect(state.json().vocab).toHaveLength(6);
    await app.close();
  });

  it("outcome rejects unknown cards, malformed IDs, and invalid bodies", async () => {
    const { fixture, app } = await makeApp();
    await app.inject({ method: "POST", url: "/api/saves/default/battle/open" });

    const unknown = await app.inject({
      method: "POST",
      url: `/api/saves/default/vocab/${fixture.cardIds[7]}/outcome`,
      payload: { outcome: { kind: "correct", answerMs: 5_000, charCount: 1 } },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "unknown_card" });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/saves/default/vocab/not-a-card-id/outcome",
      payload: { outcome: { kind: "correct", answerMs: 5_000, charCount: 1 } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "invalid_card_id" });

    for (const payload of [
      {},
      { outcome: true },
      { outcome: { kind: "correct" } },
      { outcome: { kind: "correct", answerMs: -1, charCount: 1 } },
      { outcome: { kind: "shrug" } },
      { outcome: { kind: "wrong" }, extra: 1 },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: `/api/saves/default/vocab/${fixture.cardIds[0]}/outcome`,
        payload,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: "invalid_outcome" });
    }

    const nullBody = await app.inject({
      method: "POST",
      url: `/api/saves/default/vocab/${fixture.cardIds[0]}/outcome`,
      headers: { "content-type": "application/json" },
      payload: "null",
    });
    expect(nullBody.statusCode).toBe(400);
    expect(nullBody.json()).toMatchObject({ error: "invalid_outcome" });

    const malformedJson = await app.inject({
      method: "POST",
      url: `/api/saves/default/vocab/${fixture.cardIds[0]}/outcome`,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformedJson.statusCode).toBe(400);
    await app.close();
  });

  it("settings roundtrip through PUT and GET", async () => {
    const { app } = await makeApp();
    const next = {
      ...DEFAULT_SETTINGS,
      spawnIntervalMs: 2500,
      enemySpeedMultiplier: 1.2,
      desktopReviewMode: "selection" as const,
      masterVolume: 0.25,
      reducedMotion: true,
    };
    const accepted = await app.inject({ method: "PUT", url: "/api/saves/default/settings", payload: { settings: next } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(next);

    const state = await app.inject({ method: "GET", url: "/api/saves/default" });
    expect(state.json().settings).toEqual(next);
    await app.close();
  });

  it("settings rejects invalid bodies", async () => {
    const { app } = await makeApp();
    const outOfRange = await app.inject({
      method: "PUT",
      url: "/api/saves/default/settings",
      payload: { settings: { ...DEFAULT_SETTINGS, spawnIntervalMs: 10 } },
    });
    expect(outOfRange.statusCode).toBe(400);
    expect(outOfRange.json()).toMatchObject({ error: "invalid_settings" });

    const unknownMode = await app.inject({
      method: "PUT",
      url: "/api/saves/default/settings",
      payload: { settings: { ...DEFAULT_SETTINGS, desktopReviewMode: "voice" } },
    });
    expect(unknownMode.statusCode).toBe(400);

    const missingWrapper = await app.inject({
      method: "PUT",
      url: "/api/saves/default/settings",
      payload: DEFAULT_SETTINGS,
    });
    expect(missingWrapper.statusCode).toBe(400);

    const malformedJson = await app.inject({
      method: "PUT",
      url: "/api/saves/default/settings",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformedJson.statusCode).toBe(400);
    await app.close();
  });

  it("does not expose other profiles or path parameters", async () => {
    const { app } = await makeApp();
    for (const url of ["/api/saves/other", "/api/saves/default/..%2Fsecret", "/api/saves/default.json"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("seeds from the real ordered curriculum", async () => {
    const root = await temporaryDirectory("hanzi-real-");
    // Default curriculumPath: the repository's cards/curriculum.json.
    const app = await buildApp({ saveDirectory: join(root, "saves"), serveStatic: false });
    const opened = await app.inject({ method: "POST", url: "/api/saves/default/battle/open" });
    expect(opened.statusCode).toBe(200);
    const body = opened.json();
    expect(body.addedRows).toHaveLength(5);
    expect(body.addedRows.map((row: { id: number }) => row.id)).toEqual([1, 2, 3, 4, 5]);
    // Global positions 1..5 are 我, 你, 是, 在, 他 in the committed curriculum.
    expect(body.addedRows.map((row: { cardId: string }) => row.cardId)).toEqual([
      "b755617c48bfeec4d694db49",
      "65bed40b7b3a86118ec4c85c",
      "3176e0539e27ccb4c8e4fb56",
      "944cf5f64bb7b26816440186",
      "4473c682e51be511c6427db3",
    ]);
    await app.close();
  });
});

describe("production static server", () => {
  it("serves built assets and falls back to index.html outside /api", async () => {
    const root = await temporaryDirectory("hanzi-static-");
    const dist = join(root, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.html"), "<!doctype html><title>Ziduoduo</title>");
    await writeFile(join(dist, "asset.txt"), "local asset");
    const fixture = await writeCurriculumFixture(8);
    const app = await buildApp({
      saveDirectory: join(root, "saves"),
      curriculumPath: fixture.path,
      publicDirectory: dist,
      serveStatic: true,
    });

    expect((await app.inject({ method: "GET", url: "/asset.txt" })).body).toBe("local asset");
    expect((await app.inject({ method: "GET", url: "/battle" })).body).toContain("Ziduoduo");
    expect((await app.inject({ method: "GET", url: "/api/unknown" })).statusCode).toBe(404);
    await app.close();
  });
});
