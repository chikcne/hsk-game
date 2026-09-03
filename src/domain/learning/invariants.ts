import type { LevelProgress, WordProgress } from "../../shared/schemas";
import type { LearningDeck } from "./types";

function isNonnegativeInteger(value: number): boolean { return Number.isInteger(value) && value >= 0; }

function isIsoTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }

function validateMemory(prefix: string, memory: WordProgress["pinyin"]): string[] {
  const errors: string[] = [];
  if (!["new", "learning", "review", "relearning"].includes(memory.state)) errors.push(`${prefix}.state is invalid`);
  if (!isIsoTimestamp(memory.due)) errors.push(`${prefix}.due must be an ISO-compatible timestamp`);
  if (memory.lastReview !== null && !isIsoTimestamp(memory.lastReview)) errors.push(`${prefix}.lastReview must be null or an ISO-compatible timestamp`);
  if (!Number.isFinite(memory.stability) || memory.stability < 0) errors.push(`${prefix}.stability must be finite and nonnegative`);
  if (!Number.isFinite(memory.difficulty) || memory.difficulty < 0 || memory.difficulty > 10) errors.push(`${prefix}.difficulty must be between 0 and 10`);
  for (const key of ["elapsedDays", "scheduledDays"] as const) {
    if (!Number.isFinite(memory[key]) || memory[key] < 0) errors.push(`${prefix}.${key} must be finite and nonnegative`);
  }
  for (const key of ["learningSteps", "reps", "lapses"] as const) {
    if (!isNonnegativeInteger(memory[key])) errors.push(`${prefix}.${key} must be a nonnegative integer`);
  }
  return errors;
}

function validateRecord(id: string, progress: WordProgress, spawnOrdinal: number, checkCurrentOrdinals: boolean): string[] {
  const errors: string[] = [];
  errors.push(...validateMemory(`words[${JSON.stringify(id)}].pinyin`, progress.pinyin));
  errors.push(...validateMemory(`words[${JSON.stringify(id)}].meaning`, progress.meaning));
  for (const key of ["attempts", "completeCorrect", "wrongPinyin", "wrongMeaning", "landed"] as const) {
    if (!isNonnegativeInteger(progress[key])) errors.push(`${prefix(id)}.${key} must be a nonnegative integer`);
  }
  if (progress.attempts !== progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed) {
    errors.push(`${prefix(id)}.attempts does not equal its outcome counters`);
  }
  for (const key of ["totalThinkingMs", "totalPinyinMs"] as const) {
    if (!Number.isFinite(progress[key]) || progress[key] < 0) errors.push(`${prefix(id)}.${key} must be finite and nonnegative`);
  }
  for (const key of ["fastestCorrectMs", "fastestPinyinMs", "lastPinyinMs"] as const) {
    const value = progress[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) errors.push(`${prefix(id)}.${key} must be null or finite and nonnegative`);
  }
  if (!isNonnegativeInteger(progress.nextEligibleSpawn)) errors.push(`${prefix(id)}.nextEligibleSpawn must be a nonnegative integer`);
  if (progress.introducedAtOrdinal !== null) {
    if (!isNonnegativeInteger(progress.introducedAtOrdinal)) errors.push(`${prefix(id)}.introducedAtOrdinal must be null or a nonnegative integer`);
    else if (checkCurrentOrdinals && progress.introducedAtOrdinal > spawnOrdinal) errors.push(`${prefix(id)}.introducedAtOrdinal cannot be in the future`);
  }
  if (progress.lastSpawnOrdinal !== null) {
    if (!isNonnegativeInteger(progress.lastSpawnOrdinal)) errors.push(`${prefix(id)}.lastSpawnOrdinal must be null or a nonnegative integer`);
    else {
      if (checkCurrentOrdinals && progress.lastSpawnOrdinal >= spawnOrdinal) errors.push(`${prefix(id)}.lastSpawnOrdinal must precede the current spawn ordinal`);
      if (progress.introducedAtOrdinal === null) errors.push(`${prefix(id)} was spawned before it was introduced`);
      else if (progress.lastSpawnOrdinal < progress.introducedAtOrdinal) errors.push(`${prefix(id)}.lastSpawnOrdinal precedes introduction`);
    }
  }
  if (progress.lastSeenAt !== null && !isIsoTimestamp(progress.lastSeenAt)) errors.push(`${prefix(id)}.lastSeenAt must be null or an ISO-compatible timestamp`);
  return errors;
}

function prefix(id: string): string { return `words[${JSON.stringify(id)}]`; }

/** Returns every invariant violation; suitable for validation diagnostics and tests. */
export function validateLevelInvariants(level: LevelProgress, deck: LearningDeck, spawnOrdinal: number): string[] {
  const errors: string[] = [];
  if (level.deckId !== deck.id) errors.push("level.deckId does not match deck.id");
  if (level.deckFingerprint !== deck.fingerprint) errors.push("level.deckFingerprint does not match deck.fingerprint");
  if (!isNonnegativeInteger(level.curriculumCursor)) errors.push("curriculumCursor must be a nonnegative integer");
  if (level.curriculumCursor > deck.words.length) errors.push("curriculumCursor is outside the deck order");
  if (!isNonnegativeInteger(spawnOrdinal)) errors.push("spawnOrdinal must be a nonnegative integer");

  const deckIds = deck.words.map((word) => word.id);
  const known = new Set(deckIds);
  if (known.size !== deckIds.length) errors.push("deck contains duplicate word IDs");
  for (const id of Object.keys(level.words)) if (!known.has(id)) errors.push(`unknown current word ID: ${id}`);
  for (const id of deckIds) if (level.words[id] === undefined) errors.push(`missing current word progress: ${id}`);

  const introduced = Object.entries(level.words).filter(([, progress]) => progress.introducedAtOrdinal !== null).length;
  if (introduced > level.curriculumCursor) errors.push("curriculumCursor is smaller than the introduced word count");

  for (const [id, progress] of Object.entries(level.words)) {
    errors.push(...validateRecord(id, progress, spawnOrdinal, true));
  }
  for (const [id, progress] of Object.entries(level.orphanedProgress)) {
    if (known.has(id)) errors.push(`current word is also orphaned: ${id}`);
    errors.push(...validateRecord(`orphan:${id}`, progress, spawnOrdinal, false));
  }
  if (level.firstCompletedAt !== null && !isIsoTimestamp(level.firstCompletedAt)) errors.push("firstCompletedAt must be null or an ISO-compatible timestamp");
  return errors;
}

export function assertLevelInvariants(level: LevelProgress, deck: LearningDeck, spawnOrdinal: number): void {
  const errors = validateLevelInvariants(level, deck, spawnOrdinal);
  if (errors.length > 0) throw new Error(`Invalid level progress:\n- ${errors.join("\n- ")}`);
}
