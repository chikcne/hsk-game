import { afterEach, describe, expect, test, vi } from "vitest";
import { loadStrokeBundle, loadStrokeBundles } from "../../src/client/data/strokeData";

const bundle = (character: string) => ({
  schemaVersion: 1,
  sourceCommit: "618dbab8a8ddefb958763c8b4afbaa741a4460de",
  sourceSha256: "a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee",
  characters: {
    [character]: { strokes: ["M 0 0 L 1 1 Z"], medians: [[[0, 0], [1, 1]]] },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stroke bundle loading", () => {
  test("uses local deck URLs, deduplicates requests, and merges review bundles", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const character = url.includes("hsk-1") ? "一" : "二";
      return new Response(JSON.stringify(bundle(character)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, duplicate] = await Promise.all([loadStrokeBundle("hsk-1"), loadStrokeBundle("hsk-1")]);
    expect(first).toBe(duplicate);
    const merged = await loadStrokeBundles(["hsk-1", "hsk-2"]);
    expect([...merged.keys()].sort()).toEqual(["一", "二"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/stroke-data/hsk-1.json",
      "/stroke-data/hsk-2.json",
    ]);
  });

  test("turns HTTP and schema failures into a non-blocking empty fallback", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("hsk-3")
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify({ schemaVersion: 99, characters: {} }), { status: 200 })));

    await expect(loadStrokeBundle("hsk-3")).resolves.toEqual(new Map());
    await expect(loadStrokeBundle("hsk-4")).resolves.toEqual(new Map());
    expect(error).toHaveBeenCalledTimes(2);
  });
});
