import { createHash } from "node:crypto";
import type { RuntimeDeck, RuntimeWord } from "../../../src/shared/schemas";
import type { MediaIndex, RawNote } from "../raw-types";
import { parseSoundReference } from "../archive/media";
import { normalizeHanzi } from "./hanzi";
import { acceptedPinyinForms } from "./pinyin";
import { normalizedKey, nullableText, sanitizeText } from "./text";
import { choiceShortcutsForLabel } from "../../../src/domain/session/choices";

export type Override = { displayHanzi: string; reason: string };
export type Overrides = Record<string, Override>;

export type WordAudit = {
  appliedOverrides: Array<{ guid: string; originalValue: string; displayHanzi: string; reason: string }>;
  nfkcChangedValues: Array<{ guid: string; originalValue: string; normalizedValue: string }>;
  parsedSenseLabels: Array<{ guid: string; originalValue: string; senseLabel: string }>;
  blankFields: Array<{ guid: string; fields: string[] }>;
  pinyinAlternatives: Array<{ guid: string; displayPinyin: string; acceptedPinyin: string[] }>;
  canonicalPinyinCollisions: Array<{ canonical: string; wordIds: string[] }>;
  exactDuplicateGroups: Array<{ wordId: string; sourceGuids: string[] }>;
  maxMeaningLength: number;
};

export type CompiledWord = RuntimeWord & { audioFilename: string; sourceNoteId: number };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeAndDedupe(
  notes: RawNote[],
  media: MediaIndex,
  overrides: Overrides,
): { words: CompiledWord[]; audit: WordAudit } {
  const audit: WordAudit = {
    appliedOverrides: [], nfkcChangedValues: [], parsedSenseLabels: [], blankFields: [],
    pinyinAlternatives: [], canonicalPinyinCollisions: [], exactDuplicateGroups: [], maxMeaningLength: 0,
  };
  const seenGuids = new Set<string>();
  const groups = new Map<string, CompiledWord>();
  const fullHashById = new Map<string, string>();

  for (const note of notes) {
    if (seenGuids.has(note.guid)) throw new Error(`Duplicate Anki note GUID: ${note.guid}`);
    seenGuids.add(note.guid);
    const override = overrides[note.guid];
    const hanziInput = override?.displayHanzi ?? note.fields.hanzi;
    const hanzi = normalizeHanzi(hanziInput);
    const sanitizedOriginal = sanitizeText(note.fields.hanzi);
    const nfkcOriginal = sanitizedOriginal.normalize("NFKC");
    if (override) {
      if (!override.reason.trim()) throw new Error(`Override ${note.guid} has no review reason`);
      audit.appliedOverrides.push({
        guid: note.guid, originalValue: note.fields.hanzi,
        displayHanzi: hanzi.displayHanzi, reason: override.reason,
      });
    }
    if (nfkcOriginal !== sanitizedOriginal) {
      audit.nfkcChangedValues.push({
        guid: note.guid, originalValue: note.fields.hanzi,
        normalizedValue: nfkcOriginal,
      });
    }
    if (hanzi.senseLabel) {
      audit.parsedSenseLabels.push({ guid: note.guid, originalValue: note.fields.hanzi, senseLabel: hanzi.senseLabel });
    }

    const displayPinyin = sanitizeText(note.fields.pinyin);
    const meaning = sanitizeText(note.fields.meaning);
    if (!displayPinyin) throw new Error(`Note ${note.guid} has blank Pinyin`);
    if (!meaning) throw new Error(`Note ${note.guid} has blank Meaning`);
    const acceptedPinyin = acceptedPinyinForms(displayPinyin);
    if (!acceptedPinyin.length) throw new Error(`Note ${note.guid} has no canonical pinyin form`);
    if (displayPinyin.includes("/")) {
      audit.pinyinAlternatives.push({ guid: note.guid, displayPinyin, acceptedPinyin });
    }
    const meaningKey = normalizedKey(meaning);
    if (!meaningKey) throw new Error(`Note ${note.guid} has an empty normalized meaning key`);
    const partOfSpeech = nullableText(note.fields.partOfSpeech);
    const partOfSpeechKey = partOfSpeech ? normalizedKey(partOfSpeech) || null : null;
    const blanks = Object.entries(note.fields).filter(([, value]) => !value.trim()).map(([name]) => name);
    if (blanks.length) audit.blankFields.push({ guid: note.guid, fields: blanks.sort() });
    audit.maxMeaningLength = Math.max(audit.maxMeaningLength, [...meaning].length);

    const audioFilename = parseSoundReference(note.fields.audioHanzi);
    if (!media.memberByFilename.has(audioFilename)) {
      throw new Error(`Word audio ${JSON.stringify(audioFilename)} for note ${note.guid} is absent from media map`);
    }
    const exampleValues = [note.fields.sentenceHanzi, note.fields.sentencePinyin, note.fields.sentenceMeaning].map(sanitizeText);
    const example = exampleValues.some(Boolean)
      ? { hanzi: exampleValues[0]!, pinyin: exampleValues[1]!, meaning: exampleValues[2]! }
      : null;
    const semanticIdentity = `${hanzi.displayHanzi}\0${displayPinyin}\0${meaningKey}`;
    const fullId = hash(`word-v1\0${semanticIdentity}`);
    const id = fullId.slice(0, 24);
    const priorFullId = fullHashById.get(id);
    if (priorFullId && priorFullId !== fullId) throw new Error(`Stable word ID prefix collision: ${id}`);
    fullHashById.set(id, fullId);

    const existing = groups.get(semanticIdentity);
    if (existing) {
      existing.sourceGuids.push(note.guid);
      continue;
    }
    groups.set(semanticIdentity, {
      id, sourceGuids: [note.guid], displayHanzi: hanzi.displayHanzi, hanziKey: hanzi.hanziKey,
      displayPinyin, acceptedPinyin, partOfSpeech, partOfSpeechKey, senseLabel: hanzi.senseLabel,
      meaning, meaningKey, example, audioUrl: "", audioFilename, sourceNoteId: note.id,
    });
  }

  const words = [...groups.values()].map((word) => ({ ...word, sourceGuids: [...word.sourceGuids].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  audit.exactDuplicateGroups = words.filter((word) => word.sourceGuids.length > 1)
    .map((word) => ({ wordId: word.id, sourceGuids: word.sourceGuids }));

  const idsByCanonical = new Map<string, Set<string>>();
  for (const word of words) for (const canonical of word.acceptedPinyin) {
    const ids = idsByCanonical.get(canonical) ?? new Set<string>();
    ids.add(word.id);
    idsByCanonical.set(canonical, ids);
  }
  audit.canonicalPinyinCollisions = [...idsByCanonical.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([canonical, ids]) => ({ canonical, wordIds: [...ids].sort() }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
  return { words, audit };
}

/** Largest set of labels whose hotkeys are pairwise disjoint and disjoint from `answerKeys`,
 * packed greedily from the key-hungriest label down. `generateChoices` walks the pool in a
 * seed-dependent order, so this pessimistic packing is a lower bound on what any round can fill. */
function disjointShortcutCapacity(labels: string[], answerKeys: Set<string>): number {
  const keySets = labels
    .map((label) => choiceShortcutsForLabel(label).map((shortcut) => shortcut.key))
    .filter((keys) => keys.length > 0 && keys.every((key) => !answerKeys.has(key)))
    .sort((a, b) => b.length - a.length);
  const taken = new Set(answerKeys);
  let packed = 0;
  for (const keys of keySets) {
    if (keys.some((key) => taken.has(key))) continue;
    for (const key of keys) taken.add(key);
    packed += 1;
    if (packed === 7) break;
  }
  return packed;
}

export function buildMeaningIndexes(words: RuntimeWord[]): Pick<RuntimeDeck, "meaningIndex" | "meaningKeysByPartOfSpeech" | "allMeaningKeys"> & { minimumSafeDistractors: number } {
  const mutable: Record<string, { labels: Set<string>; wordIds: Set<string>; hanziKeys: Set<string>; partOfSpeechKeys: Set<string> }> = {};
  const posPools = new Map<string, Set<string>>();
  for (const word of words) {
    const entry = mutable[word.meaningKey] ??= { labels: new Set(), wordIds: new Set(), hanziKeys: new Set(), partOfSpeechKeys: new Set() };
    entry.labels.add(word.meaning); entry.wordIds.add(word.id); entry.hanziKeys.add(word.hanziKey);
    if (word.partOfSpeechKey) {
      entry.partOfSpeechKeys.add(word.partOfSpeechKey);
      const pool = posPools.get(word.partOfSpeechKey) ?? new Set<string>();
      pool.add(word.meaningKey); posPools.set(word.partOfSpeechKey, pool);
    }
  }
  const meaningIndex: RuntimeDeck["meaningIndex"] = {};
  for (const key of Object.keys(mutable).sort()) {
    const value = mutable[key]!;
    meaningIndex[key] = {
      label: [...value.labels].sort()[0]!, wordIds: [...value.wordIds].sort(),
      hanziKeys: [...value.hanziKeys].sort(), partOfSpeechKeys: [...value.partOfSpeechKeys].sort(),
    };
  }
  const allMeaningKeys = Object.keys(meaningIndex).sort();
  const meaningKeysByPartOfSpeech: Record<string, string[]> = {};
  for (const [key, values] of [...posPools.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    meaningKeysByPartOfSpeech[key] = [...values].sort();
  }
  let minimumSafeDistractors = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const safe = allMeaningKeys.filter((key) => key !== word.meaningKey && !meaningIndex[key]!.hanziKeys.includes(word.hanziKey));
    minimumSafeDistractors = Math.min(minimumSafeDistractors, safe.length);
    if (safe.length < 7) throw new Error(`Word ${word.id} (${word.displayHanzi}) has only ${safe.length} safe meaning distractors`);
    // Being safe is not enough: a round also needs 7 distractors whose hotkeys do not collide,
    // or generateChoices throws mid-battle instead of failing the import.
    const answerKeys = new Set(choiceShortcutsForLabel(word.meaning.trim()).map((shortcut) => shortcut.key));
    if (answerKeys.size === 0) throw new Error(`Word ${word.id} (${word.displayHanzi}) has a meaning with no A-Z hotkey: ${word.meaning}`);
    const capacity = disjointShortcutCapacity(safe.map((key) => meaningIndex[key]!.label.trim()), answerKeys);
    if (capacity < 7) throw new Error(`Word ${word.id} (${word.displayHanzi}) has only ${capacity} distractors with non-colliding shortcuts`);
  }
  return { meaningIndex, meaningKeysByPartOfSpeech, allMeaningKeys, minimumSafeDistractors };
}
