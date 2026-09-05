import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SaveRejectedError, blankSave, loadSave, mayOverwriteEmergencyCache,
  parseEmergencySave, parseSavePayload, putSave,
} from "../../src/client/api/saves";

const CACHE_KEY = "ziduoduo-emergency-save";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function localStorageStub(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    dump: () => Object.fromEntries(store),
  };
}

describe("pure save payload validation", () => {
  it("adopted saves must fully validate; anything else is rejected", () => {
    const save = blankSave();
    expect(parseSavePayload(save)).toEqual(save);
    expect(parseSavePayload({ schemaVersion: 4 })).toBeNull();
    expect(parseSavePayload(null)).toBeNull();
    const corrupted = { ...save } as unknown as Record<string, unknown>;
    corrupted.spawnOrdinal = -1;
    expect(parseSavePayload(corrupted)).toBeNull();
  });

  it("parseEmergencySave guards JSON.parse and the v4 fresh-start boundary", () => {
    const save = blankSave();
    expect(parseEmergencySave(null)).toBeNull();
    expect(parseEmergencySave("")).toBeNull();
    expect(parseEmergencySave("{not json")).toBeNull(); // would have thrown before the guard
    expect(parseEmergencySave(JSON.stringify({ schemaVersion: 3 }))).toBeNull(); // v3: unsupported old schema
    expect(parseEmergencySave(JSON.stringify(save))).toEqual(save);
  });
});

describe("emergency cache policy", () => {
  it("a server rejection must never overwrite the last-good cache; transport failures may", () => {
    expect(mayOverwriteEmergencyCache(new SaveRejectedError("Save failed (400)"))).toBe(false);
    expect(mayOverwriteEmergencyCache(new SaveRejectedError("Save failed (409)"))).toBe(false);
    expect(mayOverwriteEmergencyCache(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("putSave against stubbed endpoints", () => {
  it("caches the authoritative server copy on success", async () => {
    const storage = localStorageStub();
    vi.stubGlobal("localStorage", storage);
    const authoritative = { ...blankSave(), revision: 7, savedAt: "2026-02-02T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: 7, savedAt: authoritative.savedAt, snapshot: authoritative,
    }), { status: 200 })));

    const result = await putSave(blankSave());
    expect(result.revision).toBe(7);
    expect(parseEmergencySave(storage.dump()[CACHE_KEY] ?? null)).toEqual(authoritative);
  });

  it("a 400/409 rejection keeps the previous emergency cache intact", async () => {
    const lastGood = { ...blankSave(), spawnOrdinal: 42 };
    const storage = localStorageStub({ [CACHE_KEY]: JSON.stringify(lastGood) });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "validation_failed" }), { status: 400 })));

    await expect(putSave({ ...blankSave(), spawnOrdinal: 9999 })).rejects.toBeInstanceOf(SaveRejectedError);
    // The REJECTED snapshot must not displace the last-good copy.
    expect(parseEmergencySave(storage.dump()[CACHE_KEY] ?? null)).toEqual(lastGood);
  });

  it("a transport failure caches the local snapshot for offline recovery", async () => {
    const storage = localStorageStub();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

    const local = { ...blankSave(), spawnOrdinal: 5 };
    await expect(putSave(local)).rejects.toBeInstanceOf(TypeError);
    expect(parseEmergencySave(storage.dump()[CACHE_KEY] ?? null)).toEqual(local);
  });
});

describe("loadSave against stubbed endpoints", () => {
  it("adopts a valid server save", async () => {
    const save = { ...blankSave(), spawnOrdinal: 3 };
    vi.stubGlobal("localStorage", localStorageStub());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(save), { status: 200 })));
    await expect(loadSave()).resolves.toEqual({ save, online: true });
  });

  it("falls back to a valid emergency cache when the server is unreachable or the payload invalid", async () => {
    const cached = { ...blankSave(), spawnOrdinal: 9 };
    vi.stubGlobal("localStorage", localStorageStub({ [CACHE_KEY]: JSON.stringify(cached) }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(loadSave()).resolves.toEqual({ save: cached, online: false });

    // An HTTP error is the same offline path.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 500 })));
    await expect(loadSave()).resolves.toEqual({ save: cached, online: false });

    // A 200 with a garbage body does NOT crash and does NOT get adopted.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{oops", { status: 200 })));
    await expect(loadSave()).resolves.toEqual({ save: cached, online: false });
  });

  it("an invalid or missing cache falls back to a blank save", async () => {
    vi.stubGlobal("localStorage", localStorageStub({ [CACHE_KEY]: "not json at all" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const result = await loadSave();
    expect(result.online).toBe(false);
    expect(result.save.schemaVersion).toBe(5);
    expect(result.save.spawnOrdinal).toBe(0);
    expect(result.save.levels).toEqual({});

    vi.stubGlobal("localStorage", localStorageStub({ [CACHE_KEY]: JSON.stringify({ schemaVersion: 3 }) }));
    const fresh = await loadSave();
    expect(fresh.save.schemaVersion).toBe(5);
    expect(fresh.save.acquiredWords).toEqual([]);
  });
});
