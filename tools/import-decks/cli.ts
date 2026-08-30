import { resolve } from "node:path";
import { DECK_IDS, type DeckId } from "../../src/shared/constants";
import { checkGeneratedData, compileDecks } from "./compile/compiler";

function usage(): never {
  throw new Error("Usage: npm run import:decks -- [--deck hsk-1 ...] [--output PATH] [--check]");
}

function parseArguments(args: string[]): { deckIds?: DeckId[]; outputDirectory?: string; check: boolean } {
  const deckIds: DeckId[] = [];
  let outputDirectory: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--check") check = true;
    else if (argument === "--deck") {
      const id = args[++index];
      if (!id || !(DECK_IDS as readonly string[]).includes(id)) usage();
      deckIds.push(id as DeckId);
    } else if (argument.startsWith("--deck=")) {
      const id = argument.slice("--deck=".length);
      if (!(DECK_IDS as readonly string[]).includes(id)) usage();
      deckIds.push(id as DeckId);
    } else if (argument === "--output") {
      const path = args[++index];
      if (!path) usage();
      outputDirectory = resolve(path);
    } else if (argument.startsWith("--output=")) outputDirectory = resolve(argument.slice("--output=".length));
    else usage();
  }
  return { deckIds: deckIds.length ? [...new Set(deckIds)] : undefined, outputDirectory, check };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.check) {
    if (options.outputDirectory) throw new Error("--output cannot be used with --check");
    await checkGeneratedData({ deckIds: options.deckIds });
    console.log("Generated deck data is present and current.");
    return;
  }
  const result = await compileDecks({ deckIds: options.deckIds, outputDirectory: options.outputDirectory });
  for (const report of result.reports) {
    console.log(`${report.id}: ${report.sourceNoteCount} notes -> ${report.logicalWordCount} words, ${report.output.audioAssetCount} audio assets`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
