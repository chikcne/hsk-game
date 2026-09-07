/** Builds the confusable-meaning artifact from the card corpus: meaning keys
 * (exactly the values `normalizedKey` produces over card meanings, i.e. the
 * runtime's `RuntimeWord.meaningKey` / `deck.allMeaningKeys` space) are linked
 * when a player could not reliably tell their glosses apart, and groups are the
 * candidate graph's maximal cliques. Three signals nominate a pair:
 *
 *  1. synonym class — both glosses score the same hand-authored class from
 *     lexicon.ts (说 "to speak, to say" ↔ 说话 "to talk" via SPEAK; 走 ↔ 去 via
 *     MOTION);
 *  2. shared content word — their operative-word sets overlap by ≥ 2/3 of the
 *     smaller set (高兴 "happy, glad" ↔ 开心 "happy");
 *  3. shared Han character with lexically close glosses — the character alone
 *     is NEVER sufficient (上 appears in dozens of unrelated compounds); it
 *     only corroborates a pair the two signals above already nominated.
 *
 * Cliques, not connected components: confusability is a similarity relation,
 * not an equivalence relation — it is not transitive, so unioning the graph
 * collapsed "to seem" ~ "as if" ~ "if" ~ "only if" ~ "only merely" into one
 * group. Every member of a clique is pairwise-linked to every other member.
 * Precision beats recall: a false positive silently shrinks a distractor pool,
 * a false negative just preserves the status quo. Pairs the heuristics get
 * wrong are corrected last via overrides (force-link / force-unlink); force
 * links are pairwise assertions and take part in cliques like any other edge. */

import { stableJson } from "../import-decks/compile/stable-json";
import { normalizedKey } from "../import-decks/normalize/text";
import { contentUnitsForLabel, operativeWordsForLabel } from "./gloss";
import { SYNONYM_LEXICON, classTagsForLabel } from "./lexicon";

export type CorpusCard = { hanzi: string; meaning: string; level: number };

export type ForceEntry = { keys: string[]; reason: string };
export type ForceUnlinkTagsEntry = { key: string; tags: string[]; reason: string };
export type ConfusableOverrides = {
  forceLink: ForceEntry[];
  forceUnlink: ForceEntry[];
  /** Strips specific class tags from one meaning key before pairing: the tool
   * for polysemous English glosses ("can, jar", "whether or not, if") whose
   * incidental word drags a key into a class it does not belong to. */
  forceUnlinkTags: ForceUnlinkTagsEntry[];
};

export type ConfusableGroup = { id: string; meaningKeys: string[] };

export type PairSignals = { class: boolean; word: boolean; charWithCloseness: boolean; forcedLink: boolean };

export type ConfusableReport = {
  meaningKeys: number;
  candidatePairs: number;
  pairsBySignal: Record<"class" | "word" | "charWithCloseness", number>;
  forceLinkedPairs: number;
  forceUnlinkedPairs: number;
  groups: number;
  groupedKeys: number;
  coverageByLevel: Array<{ level: number; keys: number; keysInGroups: number; groupsTouched: number }>;
};

export type ConfusableResult = {
  groups: ConfusableGroup[];
  report: ConfusableReport;
  /** Every nominated pair with the signals that fired, for curation (--debug). */
  pairs: Array<{ keys: [string, string]; signals: PairSignals; sharedWords: string[]; sharedClasses: string[] }>;
};

type KeyInfo = {
  labels: Set<string>;
  unitSet: Set<string>;
  operatives: Set<string>;
  tags: Set<string>;
  chars: Set<string>;
  minLevel: number;
};

const HAN_CHARACTER = /\p{Script=Han}/u;

function collectKeyInfo(cards: readonly CorpusCard[]): Map<string, KeyInfo> {
  const info = new Map<string, KeyInfo>();
  for (const card of cards) {
    const key = normalizedKey(card.meaning);
    if (!key) throw new Error(`Card ${card.hanzi} has an empty normalized meaning key (meaning ${JSON.stringify(card.meaning)})`);
    let entry = info.get(key);
    if (!entry) {
      entry = {
        labels: new Set(),
        unitSet: new Set(),
        operatives: new Set(),
        tags: new Set(),
        chars: new Set([...card.hanzi].filter((character) => HAN_CHARACTER.test(character))),
        minLevel: card.level,
      };
      info.set(key, entry);
    } else {
      entry.minLevel = Math.min(entry.minLevel, card.level);
      for (const character of card.hanzi) if (HAN_CHARACTER.test(character)) entry.chars.add(character);
    }
    entry.labels.add(card.meaning);
    for (const unit of contentUnitsForLabel(card.meaning)) entry.unitSet.add(unit);
    for (const operative of operativeWordsForLabel(card.meaning)) entry.operatives.add(operative);
    for (const tag of classTagsForLabel(card.meaning)) entry.tags.add(tag);
  }
  return info;
}

const overlap = (left: Set<string>, right: Set<string>): Set<string> =>
  new Set([...left].filter((value) => right.has(value)));

/** Word-set closeness: both glosses must carry at least two content units, the
 * shared fraction must clear 2/3 of the smaller set, and the shared words must
 * touch what at least one of the glosses is ABOUT (its operative word) — so
 * "left side"/"right side" share only a modifier noun and do not pair. */
const wordPairsShareMeaning = (a: KeyInfo, b: KeyInfo): boolean => {
  const shared = overlap(a.unitSet, b.unitSet);
  const smaller = Math.min(a.unitSet.size, b.unitSet.size);
  if (smaller < 2 || shared.size * 3 < smaller * 2) return false;
  const operatives = overlap(a.operatives, shared);
  if (operatives.size > 0) return true;
  return overlap(b.operatives, shared).size > 0;
};

function groupIdFor(groupKeys: string[], info: Map<string, KeyInfo>, taken: Set<string>): string {
  const kebab = (words: readonly string[]): string =>
    words.map((word) => word.replace(/[^a-z0-9]+/g, "")).filter(Boolean).join("-");
  // Content words in label order across the group's sorted keys: "to speak to
  // say" + "to talk" → speak-say-talk.
  const words: string[] = [];
  const seen = new Set<string>();
  for (const key of groupKeys) {
    const label = [...info.get(key)!.labels].sort()[0]!;
    for (const unit of contentUnitsForLabel(label)) {
      for (const word of unit.split(" ")) {
        if (!seen.has(word)) { seen.add(word); words.push(word); }
      }
    }
  }
  for (let cap = 3; cap <= words.length; cap += 1) {
    const id = kebab(words.slice(0, cap));
    if (!taken.has(id)) return id;
  }
  const base = kebab(words);
  const stem = base || "group";
  for (let suffix = 2; ; suffix += 1) {
    const id = `${stem}-${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** Confusability is a similarity relation, NOT an equivalence relation: it is
 * not transitive ("to seem" ~ "as if" ~ "if" ~ "only if" ~ "only merely" walks
 * from SEEM to ONLY). Groups are therefore the candidate graph's MAXIMAL
 * CLIQUES — every member pairwise-linked to every other member — never
 * connected components. Overlapping groups are fine: the runtime treats a key
 * as confusable with another iff they share at least one group. */
const MAX_GROUP_SIZE = 12;

/** Bron–Kerbosch with pivoting. Vertices are visited in sorted order and each
 * maximal clique is emitted exactly once, so the enumeration is deterministic. */
function maximalCliques(adjacency: Map<string, Set<string>>): string[][] {
  const cliques: string[][] = [];
  const bronKerbosch = (current: string[], candidates: Set<string>, excluded: Set<string>): void => {
    if (candidates.size === 0 && excluded.size === 0) {
      if (current.length >= 2) cliques.push(current);
      return;
    }
    let pivot = "";
    let pivotReach = -1;
    for (const vertex of [...candidates, ...excluded].sort()) {
      const reach = [...candidates].filter((candidate) => adjacency.get(vertex)!.has(candidate)).length;
      if (reach > pivotReach) { pivot = vertex; pivotReach = reach; }
    }
    const pivotNeighbours = adjacency.get(pivot)!;
    for (const vertex of [...candidates].filter((candidate) => !pivotNeighbours.has(candidate))) {
      const neighbours = adjacency.get(vertex)!;
      bronKerbosch(
        [...current, vertex],
        new Set([...candidates].filter((candidate) => neighbours.has(candidate))),
        new Set([...excluded].filter((excludedVertex) => neighbours.has(excludedVertex))),
      );
      candidates.delete(vertex);
      excluded.add(vertex);
    }
  };
  bronKerbosch([], new Set([...adjacency.keys()].sort()), new Set());
  return cliques;
}

export function buildConfusableGroups(cards: readonly CorpusCard[], overrides: ConfusableOverrides): ConfusableResult {
  const info = collectKeyInfo(cards);
  for (const entry of overrides.forceUnlinkTags ?? []) {
    const target = info.get(entry.key);
    if (!target) throw new Error(`forceUnlinkTags references unknown meaning key ${JSON.stringify(entry.key)}`);
    if (!entry.reason?.trim()) throw new Error(`forceUnlinkTags for ${JSON.stringify(entry.key)} has no reason`);
    for (const tag of entry.tags) {
      // Tag ids are validated against the lexicon so typos fail loudly; an
      // entry for a tag the key no longer scores (a signal tightened since the
      // entry was written) is simply a no-op.
      if (!(tag in SYNONYM_LEXICON.classes)) throw new Error(`forceUnlinkTags: ${JSON.stringify(tag)} is not a lexicon class id`);
      target.tags.delete(tag);
    }
  }
  const keys = [...info.keys()].sort();

  const validateKeys = (entry: ForceEntry, kind: string): [string, string][] => {
    if (!Array.isArray(entry.keys) || entry.keys.length < 2 || new Set(entry.keys).size !== entry.keys.length) {
      throw new Error(`Override ${kind} entry needs >= 2 distinct keys: ${JSON.stringify(entry)}`);
    }
    if (!entry.reason?.trim()) throw new Error(`Override ${kind} entry ${JSON.stringify(entry.keys)} has no reason`);
    for (const key of entry.keys) {
      if (!info.has(key)) {
        throw new Error(`Override ${kind} references unknown meaning key ${JSON.stringify(key)} (not in the card corpus)`);
      }
    }
    const sorted = [...entry.keys].sort();
    const pairs: [string, string][] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) pairs.push([sorted[i]!, sorted[j]!]);
    }
    return pairs;
  };
  const forcedLinks = overrides.forceLink.flatMap((entry) => validateKeys(entry, "forceLink"));
  const forbidden = new Set<string>();
  for (const pair of overrides.forceUnlink.flatMap((entry) => validateKeys(entry, "forceUnlink"))) {
    forbidden.add(pair.join("\u0000"));
  }

  const pairs: ConfusableResult["pairs"] = [];
  const signalsOf = (left: string, right: string): { signals: PairSignals; sharedWords: string[]; sharedClasses: string[] } => {
    const a = info.get(left)!;
    const b = info.get(right)!;
    const sharedWords = [...overlap(a.unitSet, b.unitSet)].sort();
    const sharedClasses = [...overlap(a.tags, b.tags)].sort();
    const word = wordPairsShareMeaning(a, b);
    const klass = sharedClasses.length > 0;
    const char = overlap(a.chars, b.chars).size > 0;
    return {
      signals: {
        class: klass,
        word,
        // Shared character only corroborates an already lexically-close pair.
        charWithCloseness: char && (klass || word),
        forcedLink: false,
      },
      sharedWords,
      sharedClasses,
    };
  };

  const nominated = new Map<string, { keys: [string, string]; signals: PairSignals; sharedWords: string[]; sharedClasses: string[] }>();
  const nominate = (left: string, right: string) => {
    const pairKey = `${left}\u0000${right}`;
    const analysis = signalsOf(left, right);
    if (analysis.signals.class || analysis.signals.word || analysis.signals.charWithCloseness) {
      nominated.set(pairKey, { keys: [left, right], ...analysis });
    }
  };
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) nominate(keys[i]!, keys[j]!);
  }
  for (const [left, right] of forcedLinks) {
    const analysis = signalsOf(left, right);
    nominated.set(`${left}\u0000${right}`, {
      keys: [left, right],
      sharedWords: analysis.sharedWords,
      sharedClasses: analysis.sharedClasses,
      signals: { ...analysis.signals, forcedLink: true },
    });
  }

  // The candidate graph: one edge per surviving pair (heuristic or force-link),
  // minus force-unlinked pairs. Groups are maximal cliques of this graph.
  const adjacency = new Map<string, Set<string>>();
  for (const key of keys) adjacency.set(key, new Set());
  let forceUnlinkedApplied = 0;
  for (const { keys: [left, right] } of nominated.values()) {
    if (forbidden.has(`${left}\u0000${right}`)) { forceUnlinkedApplied += 1; continue; }
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }

  const cliques = maximalCliques(adjacency);
  const oversized = cliques.filter((members) => members.length > MAX_GROUP_SIZE);
  if (oversized.length > 0) {
    const detail = oversized
      .map((members) => `  [${members.length}] ${members.join(" | ")}`)
      .join("\n");
    throw new Error(`cliques above ${MAX_GROUP_SIZE} keys — the pairing signals are over-linking, tighten them (do NOT add overrides):\n${detail}`);
  }
  // Sort before id assignment so `-2`/`-3` suffixes are deterministic.
  for (const members of cliques) members.sort();
  cliques.sort((left, right) => (left.join("\u0000") < right.join("\u0000") ? -1 : 1));

  const groups: ConfusableGroup[] = [];
  const takenIds = new Set<string>();
  for (const members of cliques) {
    const id = groupIdFor(members, info, takenIds);
    takenIds.add(id);
    groups.push({ id, meaningKeys: members });
  }
  groups.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const pairsBySignal = { class: 0, word: 0, charWithCloseness: 0 };
  for (const { signals } of nominated.values()) {
    if (signals.class) pairsBySignal.class += 1;
    if (signals.word) pairsBySignal.word += 1;
    if (signals.charWithCloseness) pairsBySignal.charWithCloseness += 1;
  }

  const keysInAnyGroup = new Set(groups.flatMap((group) => group.meaningKeys));
  const coverageByLevel = [1, 2, 3, 4, 5, 6].map((level) => {
    const levelKeys = keys.filter((key) => info.get(key)!.minLevel === level);
    const grouped = levelKeys.filter((key) => keysInAnyGroup.has(key));
    const groupsTouched = groups.filter((group) => group.meaningKeys.some((key) => info.get(key)!.minLevel === level)).length;
    return { level, keys: levelKeys.length, keysInGroups: grouped.length, groupsTouched };
  });

  return {
    groups,
    report: {
      meaningKeys: keys.length,
      candidatePairs: nominated.size,
      pairsBySignal,
      forceLinkedPairs: forcedLinks.length,
      forceUnlinkedPairs: forceUnlinkedApplied,
      groups: groups.length,
      groupedKeys: groups.reduce((total, group) => total + group.meaningKeys.length, 0),
      coverageByLevel,
    },
    pairs: [...nominated.values()].map(({ keys, signals, sharedWords, sharedClasses }) => ({ keys, signals, sharedWords, sharedClasses })),
  };
}

export function artifactJson(result: Pick<ConfusableResult, "groups">): string {
  return stableJson({ schemaVersion: 1, groups: result.groups });
}
