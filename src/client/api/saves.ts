import { Context, Data, Effect, Layer } from "effect";
import { runPromiseWithTypedError } from "../../shared/effect-runtime";
import { DEFAULT_SETTINGS } from "../../shared/constants";
import { SaveFileSchema, type SaveFile } from "../../shared/schemas";
import { createSecureRandomState } from "../../domain/random";

const EMERGENCY_CACHE_KEY = "ziduoduo-emergency-save";

export const blankSave = (): SaveFile => ({
  schemaVersion: 5, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
  settings: { ...DEFAULT_SETTINGS },
  spawnOrdinal: 0,
  schedulerRng: createSecureRandomState(),
  levels: {},
  acquiredWords: [],
  learnSessions: {},
  relearnSession: null,
  lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
});

/** Pure: validates an untrusted payload as a complete v5 save. Anything
 * missing, extraneous, or malformed is rejected — a partial or foreign
 * object must never be adopted as live progress. */
export function parseSavePayload(payload: unknown): SaveFile | null {
  const result = SaveFileSchema.safeParse(payload);
  return result.success ? result.data : null;
}

/** Pure: parses + validates a raw emergency-cache string. Corrupt JSON, an
 * older schema, or any schema violation yields null — the caller then falls
 * back to a blank save instead of crashing on a poisoned cache. */
export function parseEmergencySave(raw: string | null): SaveFile | null {
  if (raw === null || raw === "") return null;
  const parsed = Effect.runSync(Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).pipe(Effect.merge));
  return parsed === null ? null : parseSavePayload(parsed);
}

/** Raised when the SERVER actively rejected a snapshot (non-2xx). Distinct
 * from transport errors so the cache policy can tell "the snapshot is bad"
 * apart from "the network is down". */
export class SaveRejectedError extends Data.TaggedError("SaveRejectedError")<{
  readonly message: string;
}> {
  // String-argument constructor preserved: callers construct it exactly as
  // before — name, message and the instanceof chains are unchanged; only the
  // Effect ergonomics (tagged, yieldable, structural) are new.
  constructor(message: string) {
    super({ message });
    this.name = "SaveRejectedError";
  }
}

/** A fetch/JSON failure at the transport level. `cause` carries the raw
 * browser error (TypeError from an offline fetch, SyntaxError from a
 * malformed 200 body) so the Promise boundary can rethrow it unchanged. */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly cause: Error;
}> {}

/** A localStorage failure (unavailable, quota-exceeded). */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: Error;
}> {}

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** Pure cache policy: a server REJECTION (400 validation, 409 revision
 * conflict, …) means the local snapshot itself is unacceptable — writing it
 * into the emergency cache would silently displace the last GOOD copy. Only
 * transport-level failures (offline, timeout, malformed 200 body) may. */
export function mayOverwriteEmergencyCache(error: unknown): boolean {
  return !(error instanceof SaveRejectedError);
}

/** The browser fetch capability, behind a Context.Tag so workflows stay
 * declarative and the global lookup happens only inside the Live layer. */
export type HttpFetchService = (
  url: string,
  init?: RequestInit,
) => Effect.Effect<Response, TransportError, never>;

export class HttpFetch extends Context.Tag("HttpFetch")<HttpFetch, HttpFetchService>() {}

/** The localStorage capability save workflows need (emergency cache). */
export interface SavesStorageService {
  readonly getItem: (key: string) => Effect.Effect<string | null, StorageError, never>;
  readonly setItem: (key: string, value: string) => Effect.Effect<void, StorageError, never>;
}

export class SavesStorage extends Context.Tag("SavesStorage")<SavesStorage, SavesStorageService>() {}

/** Live capabilities backed by the real browser globals. Globals are resolved
 * lazily at call time, so tests (and callers) may stub fetch/localStorage. */
export const HttpFetchLive = Layer.succeed(
  HttpFetch,
  (url, init): Effect.Effect<Response, TransportError, never> =>
    Effect.tryPromise({
      try: () => globalThis.fetch(url, init),
      catch: (cause) => new TransportError({ cause: normalizeError(cause) }),
    }),
);

export const SavesStorageLive = Layer.succeed(SavesStorage, {
  getItem: (key) =>
    Effect.try({
      try: () => globalThis.localStorage.getItem(key),
      catch: (cause) => new StorageError({ cause: normalizeError(cause) }),
    }),
  setItem: (key, value) =>
    Effect.try({
      try: () => {
        globalThis.localStorage.setItem(key, value);
      },
      catch: (cause) => new StorageError({ cause: normalizeError(cause) }),
    }),
});

/** Both capabilities the save workflows require, wired in one layer. */
export const SavesApiLive = Layer.mergeAll(HttpFetchLive, SavesStorageLive);

/** Internal workflow: adopt the server copy when it fully validates, else
 * fall back to the emergency cache, else a blank save. Transport failures
 * (unreachable server, malformed body) ARE the offline path and never
 * escape; only a failing localStorage read escapes as an error. */
const loadSaveWorkflow: Effect.Effect<
  { save: SaveFile; online: boolean },
  StorageError,
  HttpFetch | SavesStorage
> = Effect.gen(function* () {
  const http = yield* HttpFetch;
  const storage = yield* SavesStorage;

  const fetched = yield* Effect.gen(function* () {
    const response = yield* http("/api/saves/default");
    if (!response.ok) return null;
    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new TransportError({ cause: normalizeError(cause) }),
    });
    return parseSavePayload(payload);
  }).pipe(
    // Offline or unreachable, or a body that will not parse — all fall
    // through to the emergency cache.
    Effect.catchAll(() => Effect.succeed(null)),
  );

  if (fetched) return { save: fetched, online: true };
  // Schema v4 is a fresh start; older or invalid emergency copies parse as
  // null and are ignored.
  const cached = parseEmergencySave(yield* storage.getItem(EMERGENCY_CACHE_KEY));
  if (cached) return { save: cached, online: false };
  return { save: blankSave(), online: false };
});

/** Wired boot entry point: requirements discharged; a storage failure
 * degrades to a blank save instead of crashing startup. */
export const loadSaveEffect: Effect.Effect<{ save: SaveFile; online: boolean }, never, never> =
  loadSaveWorkflow.pipe(
    Effect.catchAll(() => Effect.succeed({ save: blankSave(), online: false })),
    Effect.provide(SavesApiLive),
  );

/** Internal workflow: PUT the snapshot, adopt the server's authoritative copy
 * when it fully validates, and keep the emergency cache consistent via the
 * pure cache policy. */
const putSaveWorkflow = (
  save: SaveFile,
): Effect.Effect<SaveFile, SaveRejectedError | TransportError | StorageError, HttpFetch | SavesStorage> =>
  Effect.gen(function* () {
    const http = yield* HttpFetch;
    const storage = yield* SavesStorage;
    const snapshot = { ...save } as Record<string, unknown>;
    delete snapshot.revision;
    delete snapshot.savedAt;
    const response = yield* http("/api/saves/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: save.revision, snapshot }),
    });
    if (!response.ok) {
      return yield* Effect.fail(new SaveRejectedError(`Save failed (${response.status})`));
    }
    const result = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ revision?: unknown; savedAt?: unknown; snapshot?: unknown }>,
      catch: (cause) => new TransportError({ cause: normalizeError(cause) }),
    });
    // Adopt the server's authoritative copy only when it fully validates;
    // otherwise rebase the local snapshot with the returned revision/savedAt.
    const authoritative = parseSavePayload(result.snapshot)
      ?? { ...save, revision: Number(result.revision ?? save.revision), savedAt: typeof result.savedAt === "string" ? result.savedAt : save.savedAt };
    yield* storage.setItem(EMERGENCY_CACHE_KEY, JSON.stringify(authoritative));
    return authoritative;
  }).pipe(
    // Pure cache policy: a server REJECTION must never displace the last-good
    // copy; transport-level failures (and storage failures) may stash the
    // local snapshot for offline recovery.
    Effect.catchAll((error) => {
      if (!mayOverwriteEmergencyCache(error)) return Effect.fail(error);
      return Effect.gen(function* () {
        const cache = yield* SavesStorage;
        // A full/unavailable cache must never mask the save failure itself.
        yield* Effect.ignore(cache.setItem(EMERGENCY_CACHE_KEY, JSON.stringify(save)));
        return yield* Effect.fail(error);
      });
    }),
  );

/** Wired save entry point: requirements discharged; failures remain typed in
 * the error channel so callers can distinguish rejection from transport. */
export const putSaveEffect = (
  save: SaveFile,
): Effect.Effect<SaveFile, SaveRejectedError | TransportError | StorageError, never> =>
  putSaveWorkflow(save).pipe(Effect.provide(SavesApiLive));

/** Compatibility adapter: Promise surface for non-Effect callers. Never
 * rejects — the offline/degraded paths resolve exactly as the workflow does. */
export function loadSave(): Promise<{ save: SaveFile; online: boolean }> {
  return runPromiseWithTypedError(loadSaveEffect);
}

/** Compatibility adapter: Promise surface for non-Effect callers. Transport
 * and storage wrappers are unwrapped so rejections carry the raw browser
 * error (TypeError offline, SaveRejectedError on non-2xx), exactly as the
 * pre-Effect implementation did. */
export function putSave(save: SaveFile): Promise<SaveFile> {
  return runPromiseWithTypedError(
    putSaveEffect(save).pipe(
      Effect.mapError((error) =>
        error instanceof TransportError || error instanceof StorageError ? error.cause : error
      ),
    ),
  );
}
