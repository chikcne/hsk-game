import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Data, Effect, Layer } from "effect";
import { DECK_IDS } from "../../src/shared/constants";
import { extractAcards, type ExtractError } from "./extract";
import { AnkiDatabase } from "../import-decks/sqlite/read-collection";
import { Fs, type FsError } from "../shared/fs";

/** Typed failure for invalid command-line usage. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const USAGE =
  "Usage: npm run import:acards -- [--write] [--force] [--recover hsk-1] [--cards PATH]\n" +
  "  Extracts the .apkg packages into cards/<grade>/*.acard plus cards/audio/.\n" +
  "  Prints the plan and writes nothing unless --write is given.";

const usage = Effect.fail(new UsageError({ detail: USAGE }));

type Options = { write: boolean; force: boolean; recover: string[]; cardsRoot?: string };

const parseArguments = (args: string[]): Effect.Effect<Options, UsageError, never> =>
  Effect.gen(function* () {
    const options: Options = { write: false, force: false, recover: [] };
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--write") options.write = true;
      else if (argument === "--force") options.force = true;
      else if (argument === "--dry-run") options.write = false;
      else if (argument === "--recover" || argument.startsWith("--recover=")) {
        const id = argument.startsWith("--recover=") ? argument.slice("--recover=".length) : args[++index];
        if (!id || !(DECK_IDS as readonly string[]).includes(id)) return yield* usage;
        options.recover.push(id);
      } else if (argument === "--cards" || argument.startsWith("--cards=")) {
        const path = argument.startsWith("--cards=") ? argument.slice("--cards=".length) : args[++index];
        if (!path) return yield* usage;
        options.cardsRoot = resolve(path);
      } else return yield* usage;
    }
    return options;
  });

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const program: Effect.Effect<void, UsageError | ExtractError | FsError, Fs | AnkiDatabase> =
  Effect.gen(function* () {
    const options = yield* parseArguments(process.argv.slice(2));
    const report = yield* extractAcards({
      repositoryRoot,
      cardsRoot: options.cardsRoot,
      recover: options.recover,
      dryRun: !options.write,
      force: options.force,
    });
    const counts = { create: 0, update: 0, identical: 0, conflict: 0 };
    for (const entry of report.entries) counts[entry.action] += 1;
    for (const deck of report.byDeck) {
      const note = deck.from === "generated-deck-json" ? "  (recovered from generated deck.json)" : "";
      console.log(`${deck.id}: ${deck.words} words${note}`);
    }
    console.log(
      `\n${report.entries.length} cards — ` +
        `${counts.create} create, ${counts.update} update, ${counts.identical} identical, ${counts.conflict} conflict`,
    );
    console.log(`audio: ${report.audioAssets} assets, ${(report.audioBytes / 1_048_576).toFixed(1)} MiB`);
    console.log(report.wrote ? "\nWritten." : "\nDry run — nothing written. Re-run with --write to apply.");
  });

const liveDependencies: Layer.Layer<Fs | AnkiDatabase> = Layer.mergeAll(Fs.layer, AnkiDatabase.layer);

void Effect.runPromise(
  Effect.provide(program, liveDependencies).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
