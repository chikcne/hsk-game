import { resolve } from "node:path";
import { Data, Effect, Layer } from "effect";
import { DECK_IDS, type DeckId } from "../../src/shared/constants";
import { compileDecksEffect, checkGeneratedDataEffect, type CompileError } from "./compile/compiler";
import { AnkiDatabase } from "./sqlite/read-collection";
import { Fs, type FsError } from "../shared/fs";

/** Typed failure for invalid command-line usage. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const usage: Effect.Effect<never, UsageError, never> = Effect.fail(
  new UsageError({ detail: "Usage: npm run import:decks -- [--deck hsk-1 ...] [--output PATH] [--check]" }),
);

type Options = { deckIds?: DeckId[]; outputDirectory?: string; check: boolean };

const parseArguments = (args: string[]): Effect.Effect<Options, UsageError, never> =>
  Effect.gen(function* () {
    const deckIds: DeckId[] = [];
    let outputDirectory: string | undefined;
    let check = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--check") check = true;
      else if (argument === "--deck") {
        const id = args[++index];
        if (!id || !(DECK_IDS as readonly string[]).includes(id)) yield* usage;
        deckIds.push(id as DeckId);
      } else if (argument.startsWith("--deck=")) {
        const id = argument.slice("--deck=".length);
        if (!(DECK_IDS as readonly string[]).includes(id)) yield* usage;
        deckIds.push(id as DeckId);
      } else if (argument === "--output") {
        const path = args[++index];
        if (!path) return yield* usage;
        outputDirectory = resolve(path);
      } else if (argument.startsWith("--output=")) outputDirectory = resolve(argument.slice("--output=".length));
      else yield* usage;
    }
    return { deckIds: deckIds.length ? [...new Set(deckIds)] : undefined, outputDirectory, check };
  });

const program: Effect.Effect<void, UsageError | CompileError | FsError, Fs | AnkiDatabase> =
  Effect.gen(function* () {
    const options = yield* parseArguments(process.argv.slice(2));
    if (options.check) {
      if (options.outputDirectory) {
        return yield* Effect.fail(new UsageError({ detail: "--output cannot be used with --check" }));
      }
      yield* checkGeneratedDataEffect({ deckIds: options.deckIds });
      console.log("Generated deck data is present and current.");
      return;
    }
    const result = yield* compileDecksEffect({ deckIds: options.deckIds, outputDirectory: options.outputDirectory });
    for (const report of result.reports) {
      console.log(`${report.id}: ${report.sourceNoteCount} notes -> ${report.logicalWordCount} words, ${report.output.audioAssetCount} audio assets`);
    }
  });

const liveDependencies: Layer.Layer<Fs | AnkiDatabase> = Layer.mergeAll(Fs.layer, AnkiDatabase.layer);

void Effect.runPromise(Effect.provide(program, liveDependencies).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.error(error.message);
    process.exitCode = 1;
  })),
));
