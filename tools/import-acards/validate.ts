import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import { DECK_SOURCES } from "../import-decks/compile/compiler";
import { buildMeaningIndexesEffect, type WordImportError } from "../import-decks/normalize/words";
import { normalizeHanzi } from "../import-decks/normalize/hanzi";
import { acceptedPinyinForms } from "../import-decks/normalize/pinyin";
import { normalizedKey } from "../import-decks/normalize/text";
import { stableJson } from "../import-decks/compile/stable-json";
import { Fs, type FsError } from "../shared/fs";
import { ACARD_FILENAME_PATTERN, AcardSchema, acardFilename, type Acard } from "../shared/acard";
import { componentsOf } from "./extract";

/** Typed failure carrying every validation problem found, not just the first:
 * fixing cards one build at a time is miserable. */
export class CardValidationError extends Data.TaggedError("CardValidationError")<{
  readonly problems: readonly string[];
}> {
  get message(): string {
    const shown = this.problems.slice(0, 40).join("\n  ");
    const rest = this.problems.length > 40 ? `\n  … and ${this.problems.length - 40} more` : "";
    return `${this.problems.length} card validation problem(s):\n  ${shown}${rest}`;
  }
}

/** The two cross-grade id collisions that exist in the source decks and are
 * expected: 看 kān "to look after" (HSK 1 and 5, the HSK 5 note is literally a
 * copy of the HSK 1 one) and 结果 jiēguǒ (HSK 4 and 6). Ids are a hash of
 * semantic identity, so two genuinely identical words collide by design. This
 * is harmless — `LevelProgress.words` is keyed per grade and cross-grade keys
 * are `deckId:wordId` — but a *new* collision means a deck changed, so the
 * allowlist is exact. */
export const EXPECTED_CROSS_GRADE_DUPLICATE_IDS: readonly string[] = [
  "7f7fbf1c776b176ea78384bb", // 结果 jiēguǒ, hsk-4 + hsk-6
  "d0a8a7bd1b799464cb405f40", // 看 kān, hsk-1 + hsk-5
];

export type ValidationReport = {
  cards: number;
  byGrade: Record<string, number>;
  audioAssets: number;
  orphanAudio: number;
  /** Null when the deep checks were skipped. */
  minimumSafeDistractors: number | null;
  deep: boolean;
};

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const isMp3 = (prefix: Buffer): boolean =>
  (prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "ID3") ||
  (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0);

export type ValidateOptions = {
  /** Also hash every audio blob and re-run the per-grade distractor-pool
   * simulation. Both are O(corpus) and add ~25s, so they are opt-in: the fast
   * path still proves every card is structurally sound and every referenced
   * blob exists. CI and the release check should pass `deep: true`. */
  deep?: boolean;
};

export const validateCards = (
  cardsRoot: string,
  options: ValidateOptions = {},
): Effect.Effect<ValidationReport, CardValidationError | FsError | WordImportError, Fs> =>
  Effect.gen(function* () {
    const problems: string[] = [];
    const cards: Array<{ relative: string; card: Acard }> = [];
    const byGrade: Record<string, number> = {};

    const audioNames = new Set(
      (yield* Effect.tryPromise({
        try: () => readdir(join(cardsRoot, "audio")),
        catch: () => new CardValidationError({ problems: ["cards/audio is missing"] }),
      }).pipe(Effect.catchTag("CardValidationError", () => Effect.succeed([] as string[])))).filter((name) => name.endsWith(".mp3")),
    );

    for (const source of DECK_SOURCES) {
      const directory = join(cardsRoot, source.id);
      const names = yield* Effect.tryPromise({
        try: () => readdir(directory),
        catch: () => new CardValidationError({ problems: [`${source.id}: directory is missing`] }),
      }).pipe(Effect.catchTag("CardValidationError", (error) => {
        problems.push(...error.problems);
        return Effect.succeed([] as string[]);
      }));
      const acards = names.filter((name) => name.endsWith(".acard")).sort();
      byGrade[source.id] = acards.length;

      const seenNames = new Set<string>();
      for (const name of acards) {
        const relative = `${source.id}/${name}`;
        if (!ACARD_FILENAME_PATTERN.test(name)) problems.push(`${relative}: filename does not match the naming rule`);
        const lower = name.toLowerCase();
        if (seenNames.has(lower)) problems.push(`${relative}: filename collides case-insensitively`);
        seenNames.add(lower);

        const text = yield* Effect.tryPromise({
          try: () => readFile(join(directory, name), "utf8"),
          catch: (error) => new CardValidationError({ problems: [`${relative}: unreadable (${String(error)})`] }),
        }).pipe(Effect.catchTag("CardValidationError", (error) => {
          problems.push(...error.problems);
          return Effect.succeed("");
        }));
        if (!text) continue;

        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch (error) {
          problems.push(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        const parsed = AcardSchema.safeParse(raw);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) problems.push(`${relative}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
          continue;
        }
        const card = parsed.data;
        cards.push({ relative, card });

        // Serialization is canonical, so a card that does not round-trip has
        // been hand-formatted and would churn the next extraction's diff.
        if (stableJson(card) !== text) problems.push(`${relative}: not in canonical form — run the extractor to reformat`);

        if (card.curriculum.grade !== source.hskLevel) {
          problems.push(`${relative}: curriculum.grade ${card.curriculum.grade} does not match its directory (${source.hskLevel})`);
        }

        const expectedId = sha256(`word-v1\0${card.hanzi}\0${card.pinyin}\0${normalizedKey(card.meaning)}`).slice(0, 24);
        if (expectedId !== card.id) {
          problems.push(`${relative}: id ${card.id} does not re-derive from its content (expected ${expectedId}) — a gloss or pinyin edit must update the id deliberately`);
        }

        try {
          const normalized = normalizeHanzi(card.hanzi);
          if (normalized.displayHanzi !== card.hanzi) problems.push(`${relative}: hanzi is not in normalized form`);
        } catch (error) {
          problems.push(`${relative}: hanzi rejected (${error instanceof Error ? error.message : String(error)})`);
        }

        const accepted = acceptedPinyinForms(card.pinyin);
        if (!accepted.length) problems.push(`${relative}: pinyin yields no canonical form`);
        else {
          const expectedName = acardFilename(card.hanzi, accepted[0]!, card.id, new Set());
          const bare = `${card.hanzi}.acard`;
          if (name !== bare && !name.startsWith(expectedName.replace(/\.acard$/u, "").split("__")[0]!)) {
            problems.push(`${relative}: filename does not begin with its hanzi`);
          }
        }

        if (card.curriculum.pin && !card.curriculum.notes) problems.push(`${relative}: a pinned card must explain itself in notes`);
        if (card.audio && !audioNames.has(card.audio)) problems.push(`${relative}: audio ${card.audio} is not in cards/audio`);
      }
    }

    // Ids: unique within a grade always; across grades only the two known
    // source duplicates are tolerated.
    const perGrade = new Map<string, Set<string>>();
    const globalIds = new Map<string, string[]>();
    for (const { relative, card } of cards) {
      const grade = relative.split("/")[0]!;
      const set = perGrade.get(grade) ?? new Set<string>();
      if (set.has(card.id)) problems.push(`${relative}: duplicate id ${card.id} within ${grade}`);
      set.add(card.id);
      perGrade.set(grade, set);
      globalIds.set(card.id, [...(globalIds.get(card.id) ?? []), relative]);
    }
    for (const [id, paths] of globalIds) {
      if (paths.length > 1 && !EXPECTED_CROSS_GRADE_DUPLICATE_IDS.includes(id)) {
        problems.push(`unexpected cross-grade duplicate id ${id}: ${paths.join(", ")}`);
      }
    }

    // `components` must match a recomputation over the whole corpus, or the
    // component-before-compound constraint is being fed stale inputs.
    const corpus = new Set(cards.map(({ card }) => card.hanzi));
    for (const { relative, card } of cards) {
      const expected = componentsOf(card.hanzi, corpus);
      if (stableJson(expected) !== stableJson(card.curriculum.components)) {
        problems.push(`${relative}: curriculum.components is stale (expected [${expected.join(", ")}])`);
      }
    }

    // Audio blobs must be content-addressed and actually be MP3s.
    let orphanAudio = 0;
    const referenced = new Set(cards.map(({ card }) => card.audio).filter((name): name is string => Boolean(name)));
    for (const name of audioNames) {
      if (!referenced.has(name)) orphanAudio += 1;
    }
    for (const name of options.deep ? referenced : []) {
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(join(cardsRoot, "audio", name)),
        catch: () => new CardValidationError({ problems: [`audio/${name}: unreadable`] }),
      }).pipe(Effect.catchTag("CardValidationError", (error) => {
        problems.push(...error.problems);
        return Effect.succeed(Buffer.alloc(0));
      }));
      if (!bytes.length) continue;
      if (`${sha256(bytes)}.mp3` !== name) problems.push(`audio/${name}: filename is not its own SHA-256`);
      if (!isMp3(bytes.subarray(0, 3))) problems.push(`audio/${name}: not an MP3`);
    }

    // The existing distractor-safety rule, per grade, unchanged.
    let minimumSafeDistractors = Number.POSITIVE_INFINITY;
    for (const source of options.deep ? DECK_SOURCES : []) {
      const graded = cards.filter(({ relative }) => relative.startsWith(`${source.id}/`));
      if (!graded.length) continue;
      const words = graded.map(({ card }) => ({
        id: card.id,
        sourceGuids: card.source.guids,
        displayHanzi: card.hanzi,
        hanziKey: normalizeHanzi(card.hanzi).hanziKey,
        displayPinyin: card.pinyin,
        acceptedPinyin: acceptedPinyinForms(card.pinyin),
        partOfSpeech: card.pos,
        partOfSpeechKey: card.pos ? normalizedKey(card.pos) || null : null,
        senseLabel: card.senseLabel,
        meaning: card.meaning,
        meaningKey: normalizedKey(card.meaning),
        audioUrl: "",
      }));
      const indexes = yield* buildMeaningIndexesEffect(words);
      minimumSafeDistractors = Math.min(minimumSafeDistractors, indexes.minimumSafeDistractors);
    }

    if (problems.length) return yield* Effect.fail(new CardValidationError({ problems }));
    return {
      cards: cards.length,
      byGrade,
      audioAssets: audioNames.size,
      orphanAudio,
      minimumSafeDistractors: Number.isFinite(minimumSafeDistractors) ? minimumSafeDistractors : null,
      deep: options.deep === true,
    };
  });
