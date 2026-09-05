import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLearnRating, prepareLearnLaunch } from "../src/domain/learn";
import { countGraduated } from "../src/domain/learning";
import { serializeSave } from "../src/server/saves/atomic-writer";
import { createDefaultSave } from "../src/server/saves/repository";
import { parseSaveFile } from "../src/server/saves/validation";
import { DECK_IDS, type DeckId } from "../src/shared/constants";
import { RuntimeDeckSchema, type SaveFile } from "../src/shared/schemas";

/**
 * Seeds a fresh save with the first lessons of HSK 1 fully mastered.
 *
 * The save is not hand-assembled: the script drives the REAL domain pipeline
 * (`prepareLearnLaunch` + `applyLearnRating` with "good" ratings) against the
 * generated HSK 1 deck, so every derived field (FSRS cards, `acquiredWords`
 * ordering, `curriculumCursor`, session bookkeeping) is exactly what actual
 * gameplay would have produced. Ratings are backdated one hour so the seeded
 * review cards sit in the future — the game opens on a clean "lesson 3" start
 * with no maintenance words due.
 *
 * Usage:
 *   npm run seed:save                # seeds saves/default.json
 *   npx tsx tools/seed-save.mts      # same
 *   npx tsx tools/seed-save.mts --out saves/test.json  # write elsewhere
 *
 * An existing target file is renamed to `<name>.backup-<timestamp>` first,
 * never silently destroyed.
 */

const DECK_ID: DeckId = "hsk-1";
const LESSONS_TO_SEED = 2;
/** How far back the simulated play session sits. */
const BACKDATE_MS = 60 * 60 * 1000;
/** Runaway guard: a 20-word session needs ~2 ratings per word. */
const MAX_RATINGS_PER_SESSION = 1000;

const usage = "usage: tsx tools/seed-save.mts [--out <save-path>]";
const args = process.argv.slice(2);
let outPath: string | undefined;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--out" && args[index + 1] !== undefined) outPath = args[++index];
  else {
    console.error(`Unknown argument: ${args[index]}\n${usage}`);
    process.exit(1);
  }
}

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
if (!DECK_IDS.includes(DECK_ID)) throw new Error(`Unknown deck ID: ${DECK_ID}`);

const deckPath = join(repositoryRoot, "public", "game-data", DECK_ID, "deck.json");
const deck = RuntimeDeckSchema.parse(JSON.parse(readFileSync(deckPath, "utf8")) as unknown);

const indexPath = join(repositoryRoot, "public", "game-data", "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8")) as { decks: Array<{ id: string; fingerprint: string }> };
const manifest = index.decks.find((entry) => entry.id === DECK_ID);
if (!manifest || manifest.fingerprint !== deck.fingerprint) {
  throw new Error(`Generated deck ${deckPath} is out of sync with public/game-data/index.json — re-run the import tool first`);
}

const lessonSize = deck.curriculum.lessonSize;
const expectedMastered = LESSONS_TO_SEED * lessonSize;
if (expectedMastered > deck.words.length) {
  throw new Error(`Cannot seed ${LESSONS_TO_SEED} lessons (${expectedMastered} words): deck ${DECK_ID} only has ${deck.words.length} words`);
}

const ratedAt = new Date(Date.now() - BACKDATE_MS);
let save: SaveFile = createDefaultSave(ratedAt);
let totalRatings = 0;

for (let lesson = 1; lesson <= LESSONS_TO_SEED; lesson++) {
  const launch = prepareLearnLaunch(save, deck, ratedAt, { levelSize: lessonSize });
  save = { ...save, levels: launch.levels };
  const learnSessions: SaveFile["learnSessions"] = { ...save.learnSessions };
  learnSessions[deck.id] = launch.session;
  save = { ...save, learnSessions };

  console.log(`Lesson ${lesson}: introduced ${launch.session.wordIds.length} new words`);
  for (let rating = 0; rating <= MAX_RATINGS_PER_SESSION; rating++) {
    const session = save.learnSessions[deck.id];
    if (!session) break;
    if (rating === MAX_RATINGS_PER_SESSION) throw new Error(`Lesson ${lesson}: session did not complete within ${MAX_RATINGS_PER_SESSION} ratings`);
    save = applyLearnRating(save, deck.id, session.currentWordId, "good", ratedAt).save;
    totalRatings++;
  }
}

const level = save.levels[deck.id];
if (!level) throw new Error(`Seeding finished without a level record for ${deck.id}`);
const mastered = countGraduated(level);
if (mastered !== expectedMastered) {
  throw new Error(`Expected ${expectedMastered} mastered words, found ${mastered}`);
}
if (level.curriculumCursor !== expectedMastered) {
  throw new Error(`Expected curriculum cursor at ${expectedMastered}, found ${level.curriculumCursor}`);
}
if (save.learnSessions[deck.id] != null) throw new Error("Seeding finished with an active Learn session");
if (save.acquiredWords.length !== expectedMastered) {
  throw new Error(`Expected ${expectedMastered} acquired words, found ${save.acquiredWords.length}`);
}

// The exact validation the save server applies on load (no catalog) and on
// PUT (with catalog: word IDs must exist and the cursor must equal the
// introduced count). A save that cannot pass both would be discarded as a
// first run, so this guards the seed before it touches disk.
const catalog = new Map([[deck.id, { fingerprint: deck.fingerprint, wordIds: new Set(deck.words.map((word) => word.id)) }]]);
parseSaveFile(save);
parseSaveFile(save, catalog);

save = { ...save, savedAt: new Date().toISOString() };
const target = outPath ?? join(repositoryRoot, "saves", "default.json");
mkdirSync(dirname(target), { recursive: true });
let backupPath: string | undefined;
if (existsSync(target)) {
  backupPath = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(target, backupPath);
}
const tempPath = `${target}.tmp-seed`;
writeFileSync(tempPath, serializeSave(save));
renameSync(tempPath, target);

const dueDates = Object.values(level.words)
  .filter((word) => word.card.state === "review")
  .map((word) => word.card.due)
  .sort();
console.log(`Seeded ${target}`);
console.log(`  deck:            ${deck.id} (${deck.title}, fingerprint ${deck.fingerprint.slice(0, 12)}…)`);
console.log(`  lessons done:    ${LESSONS_TO_SEED} (${mastered} words mastered, ${totalRatings} "good" ratings applied)`);
console.log(`  curriculum:      lesson ${Math.floor(level.curriculumCursor / lessonSize) + 1} is next; nothing due before ${dueDates[0]}`);
if (backupPath) console.log(`  previous save:   kept at ${backupPath}`);
