import { DEFAULT_SETTINGS } from "../../shared/constants";
import { SaveFileSchema, type SaveFile } from "../../shared/schemas";
import { createSecureRandomState } from "../../domain/random";

const EMERGENCY_CACHE_KEY = "ziduoduo-emergency-save";

export const blankSave = (): SaveFile => ({
  schemaVersion: 4, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
  settings: { ...DEFAULT_SETTINGS },
  spawnOrdinal: 0,
  schedulerRng: createSecureRandomState(),
  levels: {},
  acquiredWords: [],
  learnSessions: {},
  relearnSession: null,
  lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
});

/** Pure: validates an untrusted payload as a complete v4 save. Anything
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseSavePayload(parsed);
}

/** Thrown when the SERVER actively rejected a snapshot (non-2xx). Distinct
 * from transport errors so the cache policy can tell "the snapshot is bad"
 * apart from "the network is down". */
export class SaveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveRejectedError";
  }
}

/** Pure cache policy: a server REJECTION (400 validation, 409 revision
 * conflict, …) means the local snapshot itself is unacceptable — writing it
 * into the emergency cache would silently displace the last GOOD copy. Only
 * transport-level failures (offline, timeout, malformed 200 body) may. */
export function mayOverwriteEmergencyCache(error: unknown): boolean {
  return !(error instanceof SaveRejectedError);
}

export async function loadSave(): Promise<{ save: SaveFile; online: boolean }> {
  let fetched: SaveFile | null = null;
  try {
    const response = await fetch("/api/saves/default");
    if (response.ok) fetched = parseSavePayload(await response.json());
  } catch {
    // Offline or unreachable — fall through to the emergency cache.
  }
  if (fetched) return { save: fetched, online: true };
  // Schema v4 is a fresh start; older or invalid emergency copies parse as
  // null and are ignored.
  const cached = parseEmergencySave(localStorage.getItem(EMERGENCY_CACHE_KEY));
  if (cached) return { save: cached, online: false };
  return { save: blankSave(), online: false };
}

export async function putSave(save: SaveFile): Promise<SaveFile> {
  const snapshot = { ...save } as Record<string, unknown>;
  delete snapshot.revision; delete snapshot.savedAt;
  try {
    const response = await fetch("/api/saves/default", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: save.revision, snapshot }) });
    if (!response.ok) throw new SaveRejectedError(`Save failed (${response.status})`);
    const result = await response.json() as { revision?: unknown; savedAt?: unknown; snapshot?: unknown };
    // Adopt the server's authoritative copy only when it fully validates;
    // otherwise rebase the local snapshot with the returned revision/savedAt.
    const authoritative = parseSavePayload(result.snapshot)
      ?? { ...save, revision: Number(result.revision ?? save.revision), savedAt: typeof result.savedAt === "string" ? result.savedAt : save.savedAt };
    localStorage.setItem(EMERGENCY_CACHE_KEY, JSON.stringify(authoritative));
    return authoritative;
  } catch (error) {
    if (mayOverwriteEmergencyCache(error)) {
      try {
        localStorage.setItem(EMERGENCY_CACHE_KEY, JSON.stringify(save));
      } catch {
        // A full/unavailable cache must never mask the save failure itself.
      }
    }
    throw error;
  }
}
