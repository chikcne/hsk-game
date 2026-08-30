import type { LevelProgress, WordProgress } from "../../shared/schemas";
import type { LearningDeck } from "./types";

function isNonnegativeInteger(value: number): boolean { return Number.isInteger(value) && value >= 0; }

function validateRecord(id: string, progress: WordProgress, nextSpawnOrdinal: number, checkCurrentOrdinals: boolean): string[] {
  const errors: string[] = [];
  const prefix = `words[${JSON.stringify(id)}]`;
  if (!Number.isInteger(progress.appearanceWeight) || progress.appearanceWeight < 1 || progress.appearanceWeight > 100) errors.push(`${prefix}.appearanceWeight must be an integer from 1 to 100`);
  for (const key of ["attempts", "completeCorrect", "wrongPinyin", "wrongMeaning", "landed"] as const) {
    if (!isNonnegativeInteger(progress[key])) errors.push(`${prefix}.${key} must be a nonnegative integer`);
  }
  if (progress.attempts !== progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed) errors.push(`${prefix}.attempts does not equal its outcome counters`);
  for (const key of ["totalThinkingMs", "totalPinyinMs"] as const) {
    if (!Number.isFinite(progress[key]) || progress[key] < 0) errors.push(`${prefix}.${key} must be finite and nonnegative`);
  }
  for (const key of ["fastestCorrectMs", "fastestPinyinMs", "lastPinyinMs"] as const) {
    const value = progress[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) errors.push(`${prefix}.${key} must be null or finite and nonnegative`);
  }
  if (!isNonnegativeInteger(progress.nextEligibleSpawn)) errors.push(`${prefix}.nextEligibleSpawn must be a nonnegative integer`);
  if (!Number.isInteger(progress.reinforcementRemaining) || progress.reinforcementRemaining < 0 || progress.reinforcementRemaining > 10) errors.push(`${prefix}.reinforcementRemaining must be an integer from 0 to 10`);
  if (progress.appearanceWeight === 1 && progress.reinforcementRemaining !== 0) errors.push(`${prefix}.reinforcementRemaining must be zero at weight 1`);
  if (progress.introducedAtOrdinal !== null) {
    if (!isNonnegativeInteger(progress.introducedAtOrdinal)) errors.push(`${prefix}.introducedAtOrdinal must be null or a nonnegative integer`);
    else if (checkCurrentOrdinals && progress.introducedAtOrdinal > nextSpawnOrdinal) errors.push(`${prefix}.introducedAtOrdinal cannot be in the future`);
  }
  if (progress.lastSpawnOrdinal !== null) {
    if (!isNonnegativeInteger(progress.lastSpawnOrdinal)) errors.push(`${prefix}.lastSpawnOrdinal must be null or a nonnegative integer`);
    else {
      if (checkCurrentOrdinals && progress.lastSpawnOrdinal >= nextSpawnOrdinal) errors.push(`${prefix}.lastSpawnOrdinal must precede nextSpawnOrdinal`);
      if (progress.introducedAtOrdinal === null) errors.push(`${prefix} was spawned before it was introduced`);
      else if (progress.lastSpawnOrdinal < progress.introducedAtOrdinal) errors.push(`${prefix}.lastSpawnOrdinal precedes introduction`);
    }
  }
  if (progress.lastSeenAt !== null && !Number.isFinite(Date.parse(progress.lastSeenAt))) errors.push(`${prefix}.lastSeenAt must be null or an ISO-compatible timestamp`);
  return errors;
}

/** Returns every invariant violation; suitable for validation diagnostics and tests. */
export function validateLevelInvariants(level: LevelProgress, deck: LearningDeck): string[] {
  const errors: string[] = [];
  if (level.deckId !== deck.id) errors.push("level.deckId does not match deck.id");
  if (level.deckFingerprint !== deck.fingerprint) errors.push("level.deckFingerprint does not match deck.fingerprint");
  if (!isNonnegativeInteger(level.nextSpawnOrdinal)) errors.push("nextSpawnOrdinal must be a nonnegative integer");
  if (!isNonnegativeInteger(level.curriculumCursor) || level.curriculumCursor > deck.words.length) errors.push("curriculumCursor is outside the deck order");
  if (!isNonnegativeInteger(level.currentLevelIndex)) errors.push("currentLevelIndex must be a nonnegative integer");
  if (level.schedulerRng.length !== 4 || level.schedulerRng.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff) || level.schedulerRng.every((word) => word === 0)) errors.push("schedulerRng must be a non-zero four-uint32 state");

  const deckIds = deck.words.map((word) => word.id);
  const known = new Set(deckIds);
  if (known.size !== deckIds.length) errors.push("deck contains duplicate word IDs");
  for (const id of Object.keys(level.words)) if (!known.has(id)) errors.push(`unknown current word ID: ${id}`);
  for (const id of deckIds) if (level.words[id] === undefined) errors.push(`missing current word progress: ${id}`);

  const current = new Set<string>();
  for (const id of level.currentLevelWordIds) {
    if (current.has(id)) errors.push(`duplicate current-level ID: ${id}`);
    current.add(id);
    const progress = level.words[id];
    if (!progress) errors.push(`unknown current-level ID: ${id}`);
    else if (progress.introducedAtOrdinal === null) errors.push(`unintroduced current-level word: ${id}`);
  }

  const active = new Set<string>();
  for (const id of level.activeLearningWordIds) {
    if (active.has(id)) errors.push(`duplicate active learning ID: ${id}`);
    active.add(id);
    const progress = level.words[id];
    if (!progress) errors.push(`unknown active learning ID: ${id}`);
    else {
      if (progress.appearanceWeight === 1) errors.push(`mastered word is active: ${id}`);
      if (progress.introducedAtOrdinal === null) errors.push(`unintroduced word is active: ${id}`);
    }
  }
  for (const id of current) if (level.words[id]?.appearanceWeight !== 1 && !active.has(id)) errors.push(`unmastered current-level word is not active: ${id}`);

  const reviewed = new Set<string>();
  for (const id of level.reviewedOlderWordIds) {
    if (reviewed.has(id)) errors.push(`duplicate reviewed older ID: ${id}`);
    reviewed.add(id);
    const progress = level.words[id];
    if (!progress) errors.push(`unknown reviewed older ID: ${id}`);
    else if (current.has(id)) errors.push(`current-level word marked as older review: ${id}`);
    else if (progress.introducedAtOrdinal === null) errors.push(`unintroduced word marked as reviewed: ${id}`);
  }

  for (const [id, progress] of Object.entries(level.words)) {
    errors.push(...validateRecord(id, progress, level.nextSpawnOrdinal, true));
    if (progress.introducedAtOrdinal !== null && progress.appearanceWeight > 1 && !active.has(id)) errors.push(`introduced unmastered word is not active: ${id}`);
  }
  for (const [id, progress] of Object.entries(level.orphanedProgress)) {
    if (known.has(id)) errors.push(`current word is also orphaned: ${id}`);
    errors.push(...validateRecord(`orphan:${id}`, progress, level.nextSpawnOrdinal, false));
  }
  if (level.firstCompletedAt !== null && !Number.isFinite(Date.parse(level.firstCompletedAt))) errors.push("firstCompletedAt must be null or an ISO-compatible timestamp");
  return errors;
}

export function assertLevelInvariants(level: LevelProgress, deck: LearningDeck): void {
  const errors = validateLevelInvariants(level, deck);
  if (errors.length > 0) throw new Error(`Invalid level progress:\n- ${errors.join("\n- ")}`);
}
