import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { runPromiseWithTypedError } from "../../src/shared/effect-runtime";
import { HttpFetch, HttpFetchLive, TransportError } from "../../src/client/api/saves";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs one fetch through the HttpFetch capability with the live layer,
 * preserving the typed error identity at the Promise boundary. */
const fetchVia = (url: string, init?: RequestInit): Promise<Response> =>
  runPromiseWithTypedError(
    Effect.flatMap(HttpFetch, (http) => http(url, init)).pipe(Effect.provide(HttpFetchLive)),
  );

describe("HttpFetch capability", () => {
  it("resolves with the fetched Response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const response = await fetchVia("/api/saves/default");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("maps transport failures (offline fetch) to TransportError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const failure = await fetchVia("/api/saves/default").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).cause).toBeInstanceOf(TypeError);
  });

  it("resolves the fetch global lazily so callers may stub it per test", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }));

    await fetchVia("/game-data/x.json", { cache: "no-store" });
    expect(calls).toEqual([["/game-data/x.json", { cache: "no-store" }]]);
  });
});
