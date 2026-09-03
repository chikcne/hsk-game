import type { LevelProgress, WordProgress } from "../../shared/schemas";
import { HARD_MIN_INTERVENING_WORDS, LEARNING_STEPS, RELEARNING_STEPS } from "./constants";
import type { LearningDeck } from "./types";

function isNonnegativeInteger(value: number): boolean { return Number.isInteger(value) && value >= 0; }

function isValidTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }

function validateRecord(id: string, progress: WordProgress, nextSpawnOrdinal: number, checkCurrentOrdinals: boolean): string[] {
  const errors: string[] = [];
  const prefix = `words[${JSON.stringify(id)}]`;
  for (const key of ["attempts", "completeCorrect", "wrongPinyin", "wrongMeaning", "landed", "lapses"] as const) {
    if (!isNonnegativeInteger(progress[key])) errors.push(`${prefix}.${key} must be a nonnegative integer`);
  }
  if (progress.attempts !== progress.completeCorrect + progress.wrongPinyin + progress.wrongMeaning + progress.landed) errors.push(`${prefix}.attempts does not equal its outcome counters`);
  for (const key of ["totalThinkingMs", "totalPinyinMs", "stability"] as const) {
    if (!Number.isFinite(progress[key]) || progress[key] < 0) errors.push(`${prefix}.${key} must be finite and nonnegative`);
  }
  if (!Number.isFinite(progress.difficulty) || progress.difficulty < 1 || progress.difficulty > 10) errors.push(`${prefix}.difficulty must be between 1 and 10`);
  for (const key of ["fastestCorrectMs", "fastestPinyinMs", "lastPinyinMs"] as const) {
    const value = progress[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) errors.push(`${prefix}.${key} must be null or finite and nonnegative`);
  }
  if (progress.phase === "new" || progress.phase === "review") {
    if (progress.stepIndex !== 0) errors.push(`${prefix}.stepIndex must be zero outside the step-based phases`);
  } else {
    const steps = progress.phase === "relearning" ? RELEARNING_STEPS : LEARNING_STEPS;
    if (!Number.isInteger(progress.stepIndex) || progress.stepIndex < 0 || progress.stepIndex >= steps.length) errors.push(`${prefix}.stepIndex is outside the ${progress.phase} steps`);
  }
  if (progress.phase === "learning" || progress.phase === "relearning") {
    if (!isNonnegativeInteger(progress.dueOrdinal ?? -1)) errors.push(`${prefix}.dueOrdinal must be a nonnegative integer while ${progress.phase}`);
  } else if (progress.dueOrdinal !== null) {
    errors.push(`${prefix}.dueOrdinal must be null outside the step-based phases`);
  }
  if (progress.phase === "review") {
    if (progress.dueAt === null || !isValidTimestamp(progress.dueAt)) errors.push(`${prefix}.dueAt must be a valid timestamp while graduated`);
  } else if (progress.dueAt !== null) {
    errors.push(`${prefix}.dueAt must be null until the word graduates`);
  }
  if (!isNonnegativeInteger(progress.nextEligibleSpawn)) errors.push(`${prefix}.nextEligibleSpawn must be a nonnegative integer`);
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
      if (progress.nextEligibleSpawn < progress.lastSpawnOrdinal + 1 + HARD_MIN_INTERVENING_WORDS) errors.push(`${prefix}.nextEligibleSpawn must reserve at least ${HARD_MIN_INTERVENING_WORDS} intervening words`);
      if (progress.dueOrdinal !== null && progress.dueOrdinal < progress.nextEligibleSpawn) errors.push(`${prefix}.dueOrdinal cannot precede its hard spacing floor`);
    }
  }
  if (progress.lastSeenAt !== null && !isValidTimestamp(progress.lastSeenAt)) errors.push(`${prefix}.lastSeenAt must be null or an ISO-compatible timestamp`);
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
      if (progress.phase === "review") errors.push(`graduated word is active: ${id}`);
      if (progress.introducedAtOrdinal === null) errors.push(`unintroduced word is active: ${id}`);
    }
  }
  for (const id of current) if (level.words[id]?.phase !== "review" && !active.has(id)) errors.push(`ungraduated current-level word is not active: ${id}`);

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
    if (progress.introducedAtOrdinal !== null && progress.phase !== "review" && !active.has(id)) errors.push(`introduced ungraduated word is not active: ${id}`);
  }
  for (const [id, progress] of Object.entries(level.orphanedProgress)) {
    if (known.has(id)) errors.push(`current word is also orphaned: ${id}`);
    errors.push(...validateRecord(`orphan:${id}`, progress, level.nextSpawnOrdinal, false));
  }
  if (level.firstCompletedAt !== null && !isValidTimestamp(level.firstCompletedAt)) errors.push("firstCompletedAt must be null or an ISO-compatible timestamp");
  return errors;
}

export function assertLevelInvariants(level: LevelProgress, deck: LearningDeck): void {
  const errors = validateLevelInvariants(level, deck);
  if (errors.length > 0) throw new Error(`Invalid level progress:\n- ${errors.join("\n- ")}`);
}
