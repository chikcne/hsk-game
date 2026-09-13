import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadBattleSaveEffect, openBattleEffect, postVocabOutcomeEffect, putSettingsEffect,
} from "../../src/client/api/battle";
import { TransportError } from "../../src/client/api/saves";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { VocabRow } from "../../src/shared/battle";

const row = (id: number, mastery: number): VocabRow => ({
  id,
  cardId: `card-${id}`,
  mastery,
  timeAdded: "2026-01-01T00:00:00.000Z",
  timeMastered: mastery === 100 ? "2026-01-02T00:00:00.000Z" : null,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("battle save API", () => {
  it("GET /api/saves/default returns the validated bundle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      settings: { ...DEFAULT_SETTINGS },
      vocab: [row(1, 0)],
      battleConfig: {
        learningSlots: 5,
        boundaries: { lowMax: 50, developingMax: 99 },
        masteryDelta: 10,
        masteryCurve: { maxMsPerChar: 2000, maxGain: 20, midMsPerChar: 5000, midGain: 10, floorMsPerChar: 8000, floorGain: 1, secondChanceGain: 0 },
        relief: { correct: 0.1, secondChance: 0.05 },
        curve: { midpoint: 5, shape: 1.3 },
        asymptotes: { low: 0.1, developing: 0.5, mastered: 0.4 },
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const bundle = await Effect.runPromise(loadBattleSaveEffect);
    expect(bundle.vocab).toHaveLength(1);
    expect(bundle.vocab[0]!.cardId).toBe("card-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/saves/default", { cache: "no-store" });
  });

  it("a transport failure REJECTS — there is no offline fallback bundle", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("network down")) as unknown as typeof fetch;
    const either = await Effect.runPromise(Effect.either(loadBattleSaveEffect));
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") expect(either.left).toBeInstanceOf(TransportError);
  });

  it("a body failing DTO validation REJECTS instead of substituting defaults", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ settings: {}, vocab: "nope" })) as unknown as typeof fetch;
    await expect(Effect.runPromise(loadBattleSaveEffect)).rejects.toThrow(/failed validation/);
  });

  it("POST /battle/open returns the seeded vocab plus its added rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      vocab: [row(1, 0), row(2, 0), row(3, 0), row(4, 0), row(5, 0)],
      addedRows: [row(1, 0), row(2, 0), row(3, 0), row(4, 0), row(5, 0)],
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opened = await Effect.runPromise(openBattleEffect);
    expect(opened.vocab).toHaveLength(5);
    expect(opened.addedRows).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledWith("/api/saves/default/battle/open", { method: "POST" });
  });

  it("POST /vocab/:cardId/outcome sends the outcome and returns the authoritative row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ row: row(1, 10), addedRows: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await Effect.runPromise(postVocabOutcomeEffect("card/1:值得", { kind: "correct", answerMs: 1_450, charCount: 2 }));
    expect(outcome.row.mastery).toBe(10);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/saves/default/vocab/card%2F1%3A%E5%80%BC%E5%BE%97/outcome");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ outcome: { kind: "correct", answerMs: 1_450, charCount: 2 } });
  });

  it("posts second-chance and wrong outcomes without an answer time", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ row: row(1, 10), addedRows: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await Effect.runPromise(postVocabOutcomeEffect("card-1", { kind: "secondChance" }));
    await Effect.runPromise(postVocabOutcomeEffect("card-1", { kind: "wrong" }));
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toEqual([{ outcome: { kind: "secondChance" } }, { outcome: { kind: "wrong" } }]);
  });

  it("a rejected outcome POST fails with BattleApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "unknown card" }, 404)) as unknown as typeof fetch;
    await expect(Effect.runPromise(postVocabOutcomeEffect("missing", { kind: "wrong" }))).rejects.toThrow(/rejected \(404\)/);
  });

  it("PUT /settings sends the settings object and returns the stored settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...DEFAULT_SETTINGS, enemySpeedMultiplier: 1.2 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stored = await Effect.runPromise(putSettingsEffect({ ...DEFAULT_SETTINGS }));
    expect(stored.enemySpeedMultiplier).toBe(1.2);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/saves/default/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ settings: DEFAULT_SETTINGS });
  });
});
