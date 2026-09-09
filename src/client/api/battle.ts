import { Data, Effect } from "effect";
import { HttpFetch, HttpFetchLive, TransportError } from "./saves";
import {
  BattleOpenResponseSchema, BattleSaveBundleSchema,
  VocabOutcomeResponseSchema, type BattleOpenResponse, type BattleOutcome,
  type BattleSaveBundle, type VocabOutcomeResponse,
} from "../../shared/battle";
import { SettingsSchema, type DifficultySettings } from "../../shared/schemas";

/** A non-2xx response or a body that fails DTO validation. Transport-level
 * failures (offline fetch, malformed JSON) surface as `TransportError`
 * from the shared HttpFetch capability. */
export class BattleApiError extends Data.TaggedError("BattleApiError")<{
  readonly message: string;
}> {}

const toMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const requestJson = (url: string, init?: RequestInit): Effect.Effect<unknown, BattleApiError | TransportError, HttpFetch> =>
  Effect.flatMap(HttpFetch, (http) =>
    http(url, init).pipe(
      Effect.flatMap((response) => response.ok
        ? Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: (cause) => new BattleApiError({ message: `Battle API response was not JSON (${toMessage(cause)})` }),
          })
        : Effect.fail(new BattleApiError({ message: `Battle API request rejected (${response.status})` }))),
    ));

const parseWith = <T>(schema: { parse: (input: unknown) => T }, payload: unknown): Effect.Effect<T, BattleApiError, never> =>
  Effect.try({
    try: () => schema.parse(payload),
    catch: () => new BattleApiError({ message: "Battle API response failed validation" }),
  });

/** GET /api/saves/default. There is deliberately NO fallback: an
 * unreachable server or an invalid body rejects (TransportError /
 * BattleApiError) and the caller must surface the failure honestly. */
export const loadBattleSaveEffect: Effect.Effect<BattleSaveBundle, BattleApiError | TransportError, never> =
  requestJson("/api/saves/default", { cache: "no-store" }).pipe(
    Effect.flatMap((payload) => parseWith(BattleSaveBundleSchema, payload)),
    Effect.provide(HttpFetchLive),
  );

/** POST /api/saves/default/battle/open: the first launch atomically seeds
 * curriculum positions 1..5 at mastery 0 on the server. */
export const openBattleEffect: Effect.Effect<BattleOpenResponse, BattleApiError | TransportError, never> =
  requestJson("/api/saves/default/battle/open", { method: "POST" }).pipe(
    Effect.flatMap((payload) => parseWith(BattleOpenResponseSchema, payload)),
    Effect.provide(HttpFetchLive),
  );

/** POST /api/saves/default/vocab/:cardId/outcome: persists one resolved
 * encounter — the server reads the mastery move off its own configured speed
 * curve — and returns the authoritative row plus any refill rows appended
 * because a low row graduated out of the learning slots. */
export const postVocabOutcomeEffect = (
  cardId: string,
  outcome: BattleOutcome,
): Effect.Effect<VocabOutcomeResponse, BattleApiError | TransportError, never> =>
  requestJson(`/api/saves/default/vocab/${encodeURIComponent(cardId)}/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome }),
  }).pipe(
    Effect.flatMap((payload) => parseWith(VocabOutcomeResponseSchema, payload)),
    Effect.provide(HttpFetchLive),
  );

/** PUT /api/saves/default/settings: replaces the settings key/value table
 * and returns the stored settings. */
export const putSettingsEffect = (
  settings: DifficultySettings,
): Effect.Effect<DifficultySettings, BattleApiError | TransportError, never> =>
  requestJson("/api/saves/default/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  }).pipe(
    Effect.flatMap((payload) => parseWith(SettingsSchema, payload)),
    Effect.provide(HttpFetchLive),
  );

/** Promise adapters for non-Effect callers (fire-and-forget persistence). */
export function postVocabOutcome(cardId: string, outcome: BattleOutcome): Promise<VocabOutcomeResponse> {
  return Effect.runPromise(postVocabOutcomeEffect(cardId, outcome));
}

export function putSettings(settings: DifficultySettings): Promise<DifficultySettings> {
  return Effect.runPromise(putSettingsEffect(settings));
}
