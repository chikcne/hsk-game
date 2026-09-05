import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pinyin } from "pinyin-pro";
import { AcardSchema, type Acard, type FrequencyTier } from "../shared/acard";
import { canonicalizePinyin } from "../import-decks/normalize/pinyin";
import { sanitizeText } from "../import-decks/normalize/text";
import { stableJson } from "../import-decks/compile/stable-json";
import { CURRICULUM_LESSON_SIZE, CURRICULUM_RULES_VERSION, type CurriculumLock, type CurriculumManifest } from "./types";

const CORPUS_SHA256 = "0a34556e278008539273e07bda10baca9e2b9637cff2ff3ca9cd93782571abbd";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function parseSourceCard(text: string): Acard {
  const raw = JSON.parse(text) as Record<string, unknown>;
  // Read the proposal-era fields long enough for the generator to remove
  // them from existing source cards. They never affect scheduling.
  if (raw.curriculum && typeof raw.curriculum === "object" && !Array.isArray(raw.curriculum)) {
    const { boundMorpheme: _boundMorpheme, seed: _seed, ...curriculum } = raw.curriculum as Record<string, unknown>;
    raw.curriculum = curriculum;
  }
  return AcardSchema.parse(raw);
}

export type CurriculumCard = { relative: string; card: Acard; prerequisiteIds: string[] };
export type GeneratedCurriculum = { cards: CurriculumCard[]; manifest: CurriculumManifest; lock: CurriculumLock };

type TopicsFile = { schemaVersion: 1; topics: Array<{ id: string; title: string }> };
type OverridesFile = {
  schemaVersion: 1;
  overrides: Record<string, { prerequisiteIds: string[]; reason: string }>;
};

const POS_MAP: Record<string, string> = {
  名: "noun", 动: "verb", 形: "adjective", 副: "adverb", 助: "auxiliary",
  后缀: "suffix", 前缀: "prefix", 连: "conjunction", 介: "preposition",
  代: "pronoun", 数: "number", 量: "measure word", 叹: "interjection",
};
const PARTICLE_POS = new Set(["auxiliary", "particle", "suffix", "prefix"]);
const normalizedPos = (value: string | null): string => (value ? (POS_MAP[value] ?? value).toLowerCase() : "");
const isParticle = (card: Acard): boolean => PARTICLE_POS.has(normalizedPos(card.pos));

/** Deterministic first-pass assignment to the reviewed controlled vocabulary.
 * The rules intentionally favor concrete domains before broad grammatical or
 * abstract fallbacks, so small gloss edits only affect one card. */
function classifyTopic(card: Acard): string {
  const pos = normalizedPos(card.pos);
  const text = `${card.hanzi} ${card.meaning}`.toLowerCase();
  if (pos.includes("pronoun")) return "g-pronouns";
  if (/number|numeral|measure word|classifier/.test(pos + " " + text)) return "g-numbers-measure-words";
  if (/conjunction|preposition|connective/.test(pos)) return "g-connectives";
  if (PARTICLE_POS.has(pos) || /modal/.test(pos)) return "g-particles-modals";
  if (pos.includes("adverb")) return "g-adverbs";
  const rules: Array<[RegExp, string]> = [
    [/family|father|mother|parent|brother|sister|husband|wife|son|daughter|relative|marry/, "people-family"],
    [/doctor|hospital|medicine|disease|ill|pain|health|body|blood|heart|head|hand|foot|eye|ear|mouth|tooth|sleep/, "body-health"],
    [/food|drink|eat|rice|noodle|fruit|vegetable|meat|tea|coffee|restaurant|delicious|cook|meal/, "food-drink"],
    [/shirt|shoe|clothes|wear|dress|appearance|beautiful|handsome|colour|color/, "clothing-appearance"],
    [/house|home|room|door|window|furniture|kitchen|clean|wash|household/, "home-household"],
    [/money|price|buy|sell|shop|store|market|cost|pay|cheap|expensive|bank/, "money-shopping"],
    [/document|form|certificate|passport|license|application|procedure|register|signature/, "admin-documents"],
    [/car|bus|train|plane|airport|station|road|street|travel|trip|transport|ticket|drive|ride/, "travel-transport"],
    [/weather|rain|snow|wind|cloud|temperature|climate|sunny/, "weather-climate"],
    [/animal|plant|tree|flower|river|mountain|sea|earth|nature|environment/, "nature-land-life"],
    [/school|student|teacher|study|learn|lesson|class|exam|university|education|homework/, "education-school"],
    [/job|work|career|office|colleague|salary|employ|profession|manager/, "work-career"],
    [/business|company|econom|trade|industry|profit|investment|finance/, "business-economy"],
    [/government|politic|society|nation|country|citizen|public|population/, "society-politics"],
    [/law|crime|police|court|prison|safe|danger|kill|steal|weapon|accident/, "law-safety-crime"],
    [/science|research|experiment|theory|chemical|physics|biology|mathemat/, "science-research"],
    [/computer|internet|phone|television|movie|film|media|software|digital|technology|website|video/, "technology-media"],
    [/material|factory|machine|metal|wood|plastic|manufactur|construct|energy/, "materials-industry"],
    [/music|art|book|literature|culture|paint|dance|sing|theatre|theater|poem/, "arts-culture"],
    [/sport|game|ball|exercise|swim|run|play|leisure|holiday/, "sports-leisure"],
    [/say|speak|tell|ask|answer|talk|conversation|discuss|explain|call/, "speech-conversation"],
    [/language|chinese|character|word|write|read|pinyin|translate|grammar|text/, "language-writing"],
    [/think|know|understand|remember|forget|believe|idea|mind|decide|consider/, "thinking-cognition"],
    [/happy|sad|angry|fear|love|hate|emotion|feeling|worry|excited|disappoint/, "emotions-feelings"],
    [/see|look|watch|hear|listen|smell|taste|feel|perceive|sound/, "perception-senses"],
    [/year|month|week|day|date|clock|hour|minute|today|tomorrow|yesterday|morning|evening/, "time-calendar"],
    [/time|duration|period|often|always|sometimes|never|sequence|frequency|before|after/, "time-duration"],
    [/place|position|left|right|above|below|inside|outside|near|far|direction|where/, "space-position"],
    [/person|people|man|woman|name|identity|guest|friend|child|adult|age/, "people-identity"],
    [/greet|thank|sorry|welcome|meet|visit|invite|polite|respect|relationship/, "social-interaction"],
    [/personality|character|honest|brave|kind|patient|lazy|clever|humor/, "personality-character"],
    [/give|receive|get|obtain|send|offer|borrow|lend|return/, "actions-giving-getting"],
    [/walk|come|go|arrive|leave|enter|exit|move|turn|rise|fall|pass/, "actions-motion"],
    [/push|pull|hold|take|put|open|close|cut|break|throw|hit|touch|carry/, "actions-physical"],
    [/change|become|develop|begin|start|finish|continue|process|increase|decrease/, "abstract-change-process"],
    [/control|influence|manage|force|allow|prevent|lead|command|affect/, "abstract-influence-control"],
    [/amount|quantity|many|few|more|less|half|all|each|some|percent|degree/, "measure-quantity"],
    [/size|shape|long|short|big|small|wide|narrow|round|straight|red|black|white/, "desc-size-shape-colour"],
    [/good|bad|correct|wrong|important|useful|value|quality|success|fail/, "desc-evaluation"],
    [/state|condition|way|manner|possible|ready|busy|quiet|serious|normal/, "desc-manner-state"],
  ];
  for (const [pattern, topic] of rules) if (pattern.test(text)) return topic;
  return pos.includes("verb") ? "actions-physical" : pos.includes("adjective") ? "desc-manner-state" : "abstract-relations";
}

function frequencyTier(rank: number | null): FrequencyTier {
  if (rank !== null && rank <= 500) return "core";
  if (rank !== null && rank <= 1500) return "common";
  if (rank !== null && rank <= 3500) return "mid";
  return "tail";
}

const canonicalizeTonedPinyin = (input: string): string => sanitizeText(input)
  .normalize("NFKC")
  .toLowerCase()
  .replace(/u:/gu, "ü")
  .replace(/[\s·'’\-]/gu, "")
  .normalize("NFC");

type AmbiguousPrerequisite = { wordId: string; relative: string; component: string; candidateIds: string[] };

function resolvePrerequisites(
  item: CurriculumCard,
  byHanzi: Map<string, CurriculumCard[]>,
  overrides: OverridesFile["overrides"],
  ambiguities: AmbiguousPrerequisite[],
): string[] {
  const override = overrides[item.card.id];
  if (override) return [...new Set(override.prerequisiteIds)].sort();
  const wordChars = Array.from(item.card.hanzi);
  const readings = pinyin(item.card.hanzi, { type: "array" }).map(canonicalizeTonedPinyin);
  const resolved = new Set<string>();
  for (const component of item.card.curriculum.components) {
    const candidates = byHanzi.get(component) ?? [];
    if (!candidates.length) continue;
    const componentChars = Array.from(component);
    const matchingReadings = new Set<string>();
    // pinyin-pro normally returns one item per character and handles
    // polyphones in phrase context. Erhua deliberately contracts 点儿 into
    // one `diǎnr` item, so fall back to the component's own contextual
    // reading whenever the arrays cannot be aligned by character index.
    if (readings.length === wordChars.length) {
      for (let start = 0; start + componentChars.length <= wordChars.length; start += 1) {
        if (wordChars.slice(start, start + componentChars.length).join("") === component) {
          matchingReadings.add(readings.slice(start, start + componentChars.length).join(""));
        }
      }
    } else {
      matchingReadings.add(pinyin(component, { type: "array" }).map(canonicalizeTonedPinyin).join(""));
    }
    const exact = candidates.filter((candidate) =>
      candidate.card.pinyin.split("/").map(canonicalizeTonedPinyin).some((form) => matchingReadings.has(form)));
    // A visually contained Hanzi with a different reading is not the same
    // vocabulary prerequisite (会 huì does not teach 会 kuài in 会计). When
    // the corpus has no matching standalone reading, treat it exactly like a
    // missing standalone card and teach the containing word whole.
    // Tone is part of the reading match: 好 hǎo can satisfy 你好 while 好 hào
    // cannot. If contextual tone sandhi means no dictionary form is an exact
    // match, accept a tone-insensitive fallback only when it identifies one
    // pronunciation. Multiple cards with that same pronunciation are duplicate
    // senses, not a reading ambiguity; the earliest official-grade card is the
    // stable representative.
    let pool = exact;
    if (!pool.length) {
      const untonedReadings = new Set([...matchingReadings].map(canonicalizePinyin));
      const fallback = candidates.filter((candidate) =>
        candidate.card.pinyin.split("/").map(canonicalizePinyin).some((form) => untonedReadings.has(form)));
      const pronunciations = new Set(fallback.flatMap((candidate) => candidate.card.pinyin.split("/").map(canonicalizeTonedPinyin)));
      if (pronunciations.size === 1) pool = fallback;
      else if (fallback.length) {
        ambiguities.push({
          wordId: item.card.id,
          relative: item.relative,
          component,
          candidateIds: [...new Set(fallback.map((candidate) => candidate.card.id))].sort(),
        });
      }
    }
    if (!pool.length) continue;
    pool.sort((left, right) => left.card.level - right.card.level || left.card.id.localeCompare(right.card.id));
    resolved.add(pool[0]!.card.id);
  }
  return [...resolved].sort();
}

const rankOf = (item: CurriculumCard): number => item.card.curriculum.frequency?.rank ?? Number.MAX_SAFE_INTEGER;
const stableCardCompare = (left: CurriculumCard, right: CurriculumCard): number =>
  rankOf(left) - rankOf(right) || left.card.hanzi.localeCompare(right.card.hanzi, "zh-CN") || left.card.id.localeCompare(right.card.id);

function baseOrder(items: CurriculumCard[]): CurriculumCard[] {
  const frequency = [...items].sort(stableCardCompare);
  const opening = frequency.filter((item) => !isParticle(item.card)).slice(0, 80);
  const used = new Set(opening.map((item) => item.card.id));
  const particles = frequency.filter((item) => !used.has(item.card.id) && isParticle(item.card));
  particles.forEach((item) => used.add(item.card.id));
  const highFrequency = frequency.filter((item) =>
    !used.has(item.card.id) && (item.card.curriculum.frequency?.tier === "core" || item.card.curriculum.frequency?.tier === "common"));
  highFrequency.forEach((item) => used.add(item.card.id));
  const remainder = frequency.filter((item) => !used.has(item.card.id));
  const byTopic = new Map<string, CurriculumCard[]>();
  for (const item of remainder) {
    const topic = item.card.curriculum.topics[0] ?? "abstract-relations";
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), item]);
  }
  for (const members of byTopic.values()) members.sort(stableCardCompare);
  const meanRank = (members: CurriculumCard[]): number => members.reduce((sum, item) => sum + Math.min(rankOf(item), 1_000_000), 0) / members.length;
  const topicCompare = (a: [string, CurriculumCard[]], b: [string, CurriculumCard[]]): number => meanRank(a[1]) - meanRank(b[1]) || a[0].localeCompare(b[0]);
  const content = [...byTopic].filter(([topic]) => !topic.startsWith("g-")).sort(topicCompare);
  const grammar = [...byTopic].filter(([topic]) => topic.startsWith("g-")).sort(topicCompare);
  const blocks: CurriculumCard[][] = [];
  let grammarIndex = 0;
  for (const [index, [, members]] of content.entries()) {
    blocks.push(members);
    if ((index + 1) % 3 === 0 && grammarIndex < grammar.length) blocks.push(grammar[grammarIndex++]![1]);
  }
  while (grammarIndex < grammar.length) blocks.push(grammar[grammarIndex++]![1]);
  const ordered = [...opening, ...particles, ...highFrequency, ...blocks.flat()];
  const pinned = items.filter((item) => item.card.curriculum.pin !== null)
    .sort((left, right) => left.card.id.localeCompare(right.card.id));
  for (const item of pinned) {
    const pin = item.card.curriculum.pin!;
    const current = ordered.findIndex((candidate) => candidate.card.id === item.card.id);
    if (current < 0) throw new Error(`Pinned card ${item.relative} is absent from its effective grade`);
    ordered.splice(current, 1);
    if ("index" in pin) ordered.splice(Math.min(pin.index, ordered.length), 0, item);
    else {
      const targetId = "before" in pin ? pin.before : pin.after;
      const target = ordered.findIndex((candidate) => candidate.card.id === targetId);
      if (target < 0) throw new Error(`Pin on ${item.relative} references a card outside its effective grade`);
      ordered.splice(target + ("after" in pin ? 1 : 0), 0, item);
    }
  }
  return ordered;
}

function scheduleLessons(items: CurriculumCard[]): CurriculumCard[][] {
  if (new Set(items.map((item) => item.card.id)).size !== items.length) {
    throw new Error("Duplicate word IDs within an effective grade");
  }
  const base = baseOrder(items);
  const baseIndex = new Map(base.map((item, index) => [item.card.id, index]));
  const sameGradeIds = new Set(items.map((item) => item.card.id));
  const urgency = new Map(items.map((item) => [item.card.id, baseIndex.get(item.card.id)!]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) for (const prerequisite of item.prerequisiteIds.filter((id) => sameGradeIds.has(id))) {
      const next = Math.min(urgency.get(prerequisite)!, urgency.get(item.card.id)!);
      if (next < urgency.get(prerequisite)!) { urgency.set(prerequisite, next); changed = true; }
    }
  }
  const remaining = new Map(items.map((item) => [item.card.id, item]));
  const scheduled = new Set<string>();
  const lessons: CurriculumCard[][] = [];
  while (remaining.size) {
    const eligible = [...remaining.values()].filter((item) =>
      item.prerequisiteIds.filter((id) => sameGradeIds.has(id)).every((id) => scheduled.has(id)));
    eligible.sort((left, right) =>
      urgency.get(left.card.id)! - urgency.get(right.card.id)! || baseIndex.get(left.card.id)! - baseIndex.get(right.card.id)! ||
      left.card.hanzi.localeCompare(right.card.hanzi, "zh-CN") || left.card.id.localeCompare(right.card.id));
    if (!eligible.length) throw new Error("Curriculum dependency graph contains a cycle");
    const lesson = eligible.slice(0, CURRICULUM_LESSON_SIZE);
    lessons.push(lesson);
    for (const item of lesson) { remaining.delete(item.card.id); scheduled.add(item.card.id); }
  }
  return lessons;
}

export async function generateCurriculum(repositoryRoot: string): Promise<GeneratedCurriculum> {
  const cardsRoot = join(repositoryRoot, "cards");
  const corpusPath = join(repositoryRoot, "tools/import-frequency/zh_cn_full.txt");
  const topicsPath = join(cardsRoot, "topics.json");
  const overridesPath = join(cardsRoot, "prerequisite-overrides.json");
  const [corpusText, topicsText, overridesText] = await Promise.all([readFile(corpusPath, "utf8"), readFile(topicsPath, "utf8"), readFile(overridesPath, "utf8")]);
  if (sha256(corpusText) !== CORPUS_SHA256) throw new Error("Frequency corpus checksum mismatch");
  const topics = JSON.parse(topicsText) as TopicsFile;
  const knownTopics = new Set(topics.topics.map((topic) => topic.id));
  if (knownTopics.size !== topics.topics.length) throw new Error("cards/topics.json contains duplicate topic IDs");
  const overrides = JSON.parse(overridesText) as OverridesFile;
  const cards: CurriculumCard[] = [];
  for (let grade = 1; grade <= 6; grade += 1) {
    const deckId = `hsk-${grade}`;
    for (const filename of (await readdir(join(cardsRoot, deckId))).filter((name) => name.endsWith(".acard")).sort()) {
      const relative = `${deckId}/${filename}`;
      cards.push({ relative, card: parseSourceCard(await readFile(join(cardsRoot, relative), "utf8")), prerequisiteIds: [] });
    }
  }
  const frequency = new Map<string, number>();
  for (const [index, line] of corpusText.split("\n").entries()) {
    const word = line.slice(0, line.lastIndexOf(" "));
    if (word && !frequency.has(word)) frequency.set(word, index + 1);
  }
  const byHanzi = new Map<string, CurriculumCard[]>();
  for (const item of cards) byHanzi.set(item.card.hanzi, [...(byHanzi.get(item.card.hanzi) ?? []), item]);
  for (const item of cards) {
    const rank = frequency.get(item.card.hanzi) ?? null;
    const topic = item.card.curriculum.topics[0] ?? classifyTopic(item.card);
    if (!knownTopics.has(topic)) throw new Error(`Unknown generated topic ${topic}`);
    item.card = { ...item.card, curriculum: { ...item.card.curriculum,
      frequency: { rank, source: "opensubtitles-2018-zh-cn", tier: frequencyTier(rank) }, grade: item.card.level, topics: [topic] } };
  }
  const ambiguities: AmbiguousPrerequisite[] = [];
  for (const item of cards) item.prerequisiteIds = resolvePrerequisites(item, byHanzi, overrides.overrides, ambiguities);
  if (ambiguities.length) {
    throw new Error(`Ambiguous reading-specific prerequisites require reviewed overrides:\n${stableJson(ambiguities)}`);
  }
  // Two source decks contain byte-identical cross-grade duplicate cards. A
  // dependency on that semantic ID is satisfied by the earliest copy; never
  // hoist the later duplicate into the same effective deck and create an ID
  // collision.
  const byId = new Map<string, CurriculumCard>();
  for (const item of [...cards].sort((left, right) => left.card.level - right.card.level || left.relative.localeCompare(right.relative))) {
    if (!byId.has(item.card.id)) byId.set(item.card.id, item);
  }
  for (const [wordId, override] of Object.entries(overrides.overrides)) {
    if (!byId.has(wordId)) throw new Error(`Prerequisite override references unknown word ${wordId}`);
    if (!override.reason.trim()) throw new Error(`Prerequisite override ${wordId} has no reason`);
    for (const prerequisiteId of override.prerequisiteIds) if (!byId.has(prerequisiteId)) throw new Error(`Override ${wordId} references unknown prerequisite ${prerequisiteId}`);
  }
  let moved = true;
  while (moved) {
    moved = false;
    for (const item of cards) for (const prerequisiteId of item.prerequisiteIds) {
      const prerequisite = byId.get(prerequisiteId)!;
      if (prerequisite.card.curriculum.grade > item.card.curriculum.grade) {
        prerequisite.card = { ...prerequisite.card, curriculum: { ...prerequisite.card.curriculum, grade: item.card.curriculum.grade } };
        moved = true;
      }
    }
  }
  const levels: CurriculumManifest["levels"] = [];
  for (let grade = 1; grade <= 6; grade += 1) {
    const lessons = scheduleLessons(cards.filter((item) => item.card.curriculum.grade === grade));
    levels.push({ deckId: `hsk-${grade}` as CurriculumManifest["levels"][number]["deckId"], hskLevel: grade, cardCount: lessons.flat().length,
      lessons: lessons.map((lesson, index) => ({ id: `hsk-${grade}-lesson-${index + 1}`,
        cards: lesson.map((item) => ({ id: item.card.id, file: item.relative, hanzi: item.card.hanzi, prerequisiteIds: item.prerequisiteIds })) })) });
  }
  const manifest: CurriculumManifest = { schemaVersion: 1, generator: { name: "sort-curriculum", version: "1.0.0", rulesVersion: CURRICULUM_RULES_VERSION }, lessonSize: CURRICULUM_LESSON_SIZE, levels };
  const cardInputs = cards.map((item) => ({ relative: item.relative, card: item.card, prerequisiteIds: item.prerequisiteIds }));
  const lock: CurriculumLock = { schemaVersion: 1, rulesVersion: CURRICULUM_RULES_VERSION, corpusSha256: sha256(corpusText), topicsSha256: sha256(topicsText),
    overridesSha256: sha256(overridesText), cardsSha256: sha256(stableJson(cardInputs)), manifestSha256: sha256(stableJson(manifest)) };
  return { cards, manifest, lock };
}
