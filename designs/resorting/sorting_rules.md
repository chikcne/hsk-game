# The deterministic curriculum order: rules and evidence

Status: **proposal**. Companion to [`acard_structure.md`](acard_structure.md),
which defines the file format this order is stored in. This document defines
how the order is computed and records the measurements behind each decision.

> **Constraint: no migrations, no datafixes.** The game is not in production
> and the save file has been deleted so this work can start clean. The order
> may be changed freely during implementation; nothing needs to preserve a
> player's position in an earlier version of it.

Scope note: the ordering is computed **per HSK grade**. The player picks a
grade on the title screen and Learn Mode draws only from that grade
(`src/domain/learn/session.ts`), so "the order" is really six orders. Grades
are never interleaved.

## 1. The three rules, restated precisely

1. **Common first.** Within a grade, high-frequency everyday vocabulary is
   introduced before rarer vocabulary.
2. **Then by topic.** Once the common core of a grade is exhausted, the
   remainder is grouped into coherent topic blocks.
3. **Components before compounds.** A single-character word is introduced
   before any multi-character word that contains it. Broken only with an
   explicit, recorded reason.

These are applied as a **three-phase sort within each grade**, not as three
independent sort keys:

```
grade order = [ curated survival seed, hand-authored ]        (§2.5, decided)
           ++ [ core-frequency block, ordered by frequency ]  (particles pulled out, §2.4)
           ++ [ particle/grammar block ]                      (after ~4 lessons, decided)
           ++ [ topic block 1, topic block 2, … ]             (g-* blocks interleaved, §3.2)
           ++ [ leftovers ]
then: a topological repair pass enforces rule 3
```

Rule 3 is a *constraint*, not a sort key. Sorting by it directly would drag
rare single characters to the front of every grade. Instead the frequency and
topic sort runs first, then a repair pass moves each violating single
character to immediately before the earliest compound that needs it. That
preserves as much of the frequency/topic intent as the constraint allows.

## 2. Rule 1 — commonness

### 2.1 The corpus

Recommended source, matching the vendoring pattern already used for stroke
data (pinned commit + SHA-256 gate + `notices/` + generated `SOURCE.md` +
committed deterministic subset):

```
hermitdave/FrequencyWords  content/2018/zh_cn/zh_cn_full.txt
commit  f8a65e6ddc17e0baa2e366a909986798d8dbe55b   (2019-02-15)
sha256  0a34556e278008539273e07bda10baca9e2b9637cff2ff3ca9cd93782571abbd
bytes   8,307,909      766,612 lines, "word count", pre-sorted
licence MIT (code) + CC-BY-SA-4.0 (content)
```

Measured coverage of our 5,398 words: **5,388 (99.81 %)**, with 3,155 distinct
count values among them (largest tie group 12). The `zh_cn_50k.txt` variant
reaches only 96.15 % and drops 汉语, 拼音, 留学生 — use the full list.

Rejected alternatives and why, in short: **SUBTLEX-CH** has no redistribution
licence, no revision pin, and being a 2010 corpus it misses every modern HSK
word (高铁, 二维码, 网购, 外卖, 扫码); **wordfreq** is centibel-bucketed, giving
only 383 distinct values across our words — tie groups of 51 — which destroys
the ordering; **BCC/BLCU** and **Jun Da** carry no licence at all; **Leeds** is
cleanly CC-BY-2.5 but the host is unreachable. Full evaluation is in the
working notes.

### 2.2 The corpus is biased and we must correct for it

This is the important part. OpenSubtitles is film and television dialogue, and
a *pure* frequency sort is pedagogically wrong. Measured, HSK 6 sorted by raw
frequency opens:

```
嘿 中 地方 啦 该 杀 嘛 所 夫人 哇 枪 才能 待 于 求 就算 死亡 结果 成 呆 战争 为何 武器 命令 字幕
```

`字幕` — "subtitles" — at position 25 is the corpus signing its own work. Meanwhile
HSK 1 essentials sink: 汉语 is globally rank 5192, 汉字 5164, 饺子 4663,
米饭 4545, 星期日 4234. Ordering by frequency alone would teach *gun* and
*to kill* before *Chinese language*.

Three mitigations, in order of importance:

- **Grade is the major key.** Frequency only ever orders words *within* one
  HSK grade. 杀 is early in HSK 6, which is harmless; it is never early in the
  game. This alone removes most of the damage.
- **Tiers, not raw ranks.** The sorter groups on a coarse tier and orders by
  rank only inside it, so a small wobble in the underlying count never
  reshuffles a lesson. Global rank bands and their measured distribution:

  | Grade | core (1–500) | common (501–1500) | mid (1501–3500) | tail (3501+) | uncovered |
  |---|---:|---:|---:|---:|---:|
  | HSK 1 | 157 | 78 | 46 | 17 | 2 |
  | HSK 2 | 78 | 66 | 34 | 22 | 0 |
  | HSK 3 | 122 | 152 | 155 | 70 | 1 |
  | HSK 4 | 88 | 327 | 372 | 213 | 0 |
  | HSK 5 | 35 | 271 | 748 | 545 | 1 |
  | HSK 6 | 20 | 106 | 645 | 1021 | 6 |

  The shape is exactly what we want: the "common words first" phase is
  substantial in HSK 1–2 (157 and 78 words) and nearly empty by HSK 6 (20),
  where almost everything is topic-sorted instead.
- **A reviewed override file.** `tools/import-frequency/overrides.json`,
  layered on top, carrying the 10 uncovered words and any reviewed demotion of
  a corpus artifact. Each entry needs a reason, exactly like the existing
  `import-decks/overrides.json`.

### 2.3 Homographs share a count

The list is keyed on Hanzi, so the 62 homograph pairs collide: 好 hǎo (HSK 1)
and 好 hào (HSK 5), 会 (1/3), 还 (1/3), 得 (2/3), 啊 (2/4). They land on
identical counts. The tie-break is therefore mandatory and fixed:

```
sortKey = (tier, topic, -corpusCount, hanzi, stableWordId)
```

Every component is a total order with no hash and no float comparison, so the
result is reproducible on any machine — which is the whole point.

### 2.4 What the top of HSK 1 actually looks like

Sorted by frequency within the grade:

```
的 我 你 了 是 在 他 我们 不 吗 好 什么 有 吧 她 这 知道 说 都 去
很 要 也 他们 和 那 想 人 会 来 对 没有 做 给 可以 你们 呢 到 还 现在
```

and the grade now *ends* with 米饭, 饺子, 小学生, 中学生, 好玩儿, 汉字, 汉语,
面条儿, 不客气, 有的 — a plausible "last lesson of level 1" rather than the
current situation where they may appear anywhere.

One caveat visible in that list: **six of the first 40 are grammatical
particles** — 的, 了, 吗, 吧, 呢, plus 得 shortly after. They are genuinely the
most frequent words in the language, but they make poor *first* flashcards in
this game specifically, because the game asks the player to write the
character and pick its meaning, and "possessive or modifying particle" is not
a meaning a beginner can pick out of eight choices. `partOfSpeech` is already
in the deck data, so a POS-based demotion is cheap to implement. See Q2.

**A prerequisite for any POS-based rule:** the `partOfSpeech` field is not
consistent across grades. HSK 1-5 use English labels (`noun` 110x in HSK 1,
`verb`, `adjective`, `auxiliary`, `suffix`...); **HSK 6 uses Chinese
abbreviations for 1,779 of its 1,798 words** (`名` 688x, `动` 623x, `形` 182x,
`副`, `助`, `后缀`, `连`, `量`). This is not currently a live bug - POS is never
displayed in the UI, and `reviewDeck.ts:48-52` namespaces the pools per deck
(`hsk-6:名`), so cross-grade distractor selection never mixes the two
vocabularies. But it does mean a rule like "demote auxiliaries" would silently
apply to five grades and skip the sixth. The `.acard` extraction should
normalise POS through a reviewed mapping table (`名`->`noun`, `动`->`verb`,
`助`->`auxiliary`, `后缀`->`suffix`, ...), keeping the source string in the
card's `source` block.

Usefully, the deck data already labels the bound morphemes explicitly: 49
single-character cards carry `suffix`, `prefix`, `auxiliary`, `助` or `后缀` -
了 们 吗 吧 呢 的 第 边 (HSK 1), 地 得 着 过 面 (HSK 2), 员 子 老 长 (HSK 3),
之 性 感 者 (HSK 4), 化 品 头 式 族 (HSK 5), 业 则 啦 嘛 所 率 (HSK 6). So the
Q4 exemption list is derivable from data rather than hand-curated.

## 3. Rule 2 — topics

**46 topics in 11 families** after decisions D5 and D6 (the proposal started at
44). Every one of the 5,398 words receives an assignment; there is deliberately
**no `misc` topic**, because a misc bucket is where a taxonomy goes to stop
being maintained. Counts below are as-proposed, before D5/D6 redistribution.

| Family | Topics |
|---|---|
| Function words & grammar (605) | `g-pronouns` 86 · `g-numbers-measure-words` 144 · `g-connectives` 120 · `g-particles-modals` 79 · `g-adverbs` 176 |
| Time & space (368) | `time-calendar` · `time-duration` *(split, D6, 191 total)* · `space-position` 177 |
| People & relationships (361) | `people-identity` 159 · `people-family` 61 · `social-interaction` 74 · `personality-character` 67 |
| Body, home & daily life (752) | `body-health` 143 · `food-drink` 161 · `clothing-appearance` 45 · `home-household` 92 · `money-shopping` · `admin-documents` *(split, D6, 189 total)* · `travel-transport` 122 |
| Natural world (262) | `nature-land-life` 173 · `weather-climate` 89 |
| Learning & work (323) | `education-school` 124 · `work-career` 128 · `business-economy` 71 |
| State & society (168) | `society-politics` 85 · `law-safety-crime` 83 |
| Science, technology & making (347) | `science-research` 61 · `technology-media` 147 · `materials-industry` 139 |
| Culture & leisure (244) | `arts-culture` 145 · `sports-leisure` 99 |
| Mind & communication (545) | `speech-conversation` 146 · `language-writing` 75 · `thinking-cognition` 131 · `emotions-feelings` 121 · `perception-senses` 72 |
| Actions, quantity & abstract (1,423) | `actions-motion` 134 · `actions-physical` ~90 *(D5, was `actions-handling` 196)* · `actions-giving-getting` 68 · `abstract-change-process` 192 · `abstract-influence-control` 72 · `abstract-relations` 212 · `measure-quantity` 117 · `desc-size-shape-colour` 95 · `desc-evaluation` 211 · `desc-manner-state` 126 |

Full display names, one-line scopes, per-grade distributions and worked
examples are in the taxonomy working notes.

### 3.1 Block sizing

The median topic×grade cell is ~18 words — a good lesson block. Two problems at
the extremes:

- **8 cells exceed 60 words** and need a mechanical two-way split.
- **~40 cells hold fewer than 8 words.** The fix is *not* to force every topic
  to appear at every grade. At HSK 1–2 only ~14 topics have real mass, and
  that is fine: the curated seed and the frequency core absorb most of those
  two grades anyway.

### 3.2 Grammatical words are a parallel track

The five `g-*` topics are 605 words (11.2 %). They are **not** themed lessons
and must not be bunched — a lesson made entirely of adverbs is not a lesson.
They are interleaved: roughly one function block per three topic blocks. This
is the same decision already taken for particles in §2.4.

### 3.3 The honest tail

121 words (2.2 %) resist classification and are flagged `low_confidence` in the
draft assignment: 91 domain-free abstract adjectives (充分, 了不起, 一次性, 幽默)
and 30 semantically empty verbs (做, 是, 有, 无, 试, 解决). 88 % are HSK 5–6.
The frequency core absorbs about a third of them before they ever reach a topic
lesson; the abstract adjectives are best taught as antonym pairs inside their
block. A further ~270 words are assignable but arguable.

### 3.4 Distributing `actions-handling` (D5) — what it actually costs

Measured against the 196 words in the topic:

| Destination | words |
|---|---:|
| `home-household` (洗 扫 擦 搬 挂 盖 布置…) | 18 |
| `materials-industry` (挖 钻 拆 堆 塞 夹 喷…) | 13 |
| `food-drink` (切 咬 浇 吞 泼 混合 割…) | 12 |
| `law-safety-crime` (射击 打架 抵抗 捉 捕 拦…) | 11 |
| `body-health` (洗澡 按摩 伸 跪 摸 抱…) | 10 |
| `travel-transport` (刹车 倒车 拐 拖 牵…) | 9 |
| `work-career` (出力 使劲 挣 提交 获取…) | 8 |
| `technology-media` (插座 拨打 扫码 压缩…) | 6 |
| `arts-culture` (排练 描绘 模仿 示范…) | 5 |
| `clothing-appearance` (脱 披…) | 3 |
| **misclassified — leave the topic entirely** (好运, 幸运, 运气, 西装, 压力, 挫折, 切实…) | 11 |
| **residue: no natural domain** | **90** |

So D5 distributes cleanly for about half the topic, and 11 words were never
hand verbs at all and go back where they belong. The remaining **90 are
domain-free manipulation verbs** — 推 push, 拉 pull, 扔 throw, 敲 knock, 抓紧
grip, 摸 touch, 碰 bump, 翻 turn over, 插 insert, 摘 pick. Filing 推 under
"Home & household" would be a worse lie than the block it came from.

The plan is therefore: distribute the 95 that have a real domain, return the 11
misfits, and keep a **smaller residual topic `actions-physical` (~90)** for the
core manipulation verbs. That preserves the intent behind D5 — domain lessons
become scenes — without forcing false assignments, and the residual block still
delivers the 扌-radical teaching moment for the characters that share it.

Net effect on the taxonomy: 44 topics → **46** (`actions-handling` becomes
`actions-physical`; `time` and `money-shopping-admin` each split in two).

**The per-word assignment is a first pass and needs a review sweep before it
ships.** The taxonomy is what is being proposed here; the draft assignment was
produced by rule-based clustering over POS, curated character lists, and
English-gloss regexes, and it visibly misfires in places — 痛 "painful" landed
in `g-adverbs`, 指挥 "to command" in `space-position`, 忍 "to endure" in
`nature-land-life`, 彩虹 "rainbow" in `arts-culture`, 球场 "sports field" in
`law-safety-crime`. Those are cheap to fix once the taxonomy is agreed, and
the `.acard` format is designed so each fix is a one-line diff.

## 4. Rule 3 — components before compounds

### 4.1 What the corpus actually looks like

| | count |
|---|---:|
| Multi-char words whose single-char components are all same-or-earlier grade | 3,134 |
| Multi-char words needing a component whose standalone card is in a **later** grade | 643 |
| Multi-char words containing no character that is a standalone card at all | 1,621 |
| Multi-char words containing a shorter *multi-char* word (不客气 ⊃ 客气) | 112 |

Per grade, the number of compounds actually constrained by a same-grade single
character: HSK 1 · 104, HSK 2 · 49, HSK 3 · 139, HSK 4 · 302, HSK 5 · 394,
HSK 6 · 308.

The most load-bearing characters, by how many compounds depend on them:
子 (73), 人 (63), 不 (58), 大 (52), 一 (45), 出 (43), 生 (42), 动 (41), 学 (40),
面 (37), 心 (37), 发 (37).

### 4.2 The repair pass

Sorting HSK 1 purely by frequency produces **30** rule-3 violations out of its
163 compounds; across all six grades, **506** violations out of 4,317
compounds. Each is repaired by moving the single character to immediately
before the earliest compound that contains it. Because only ~12 % of compounds
are affected and the moves are local, the frequency and topic intent survives
almost intact.

The pass is a stable topological sort: process the frequency/topic order left
to right, and before emitting a compound, emit any not-yet-emitted same-grade
single-character component it needs (those in their own frequency order). This
is deterministic, terminates, and moves each character exactly once.

### 4.3 Where the rule bites, and why some cases need a human

- **Cross-grade (643 words) — resolved by D3, with consequences.** The
  components are hoisted into the earlier grade, so rule 3 holds absolutely.
  Computed to a fixed point (a hoisted word can itself pull down its own
  components), and with the D9 exemption applied, **304 cards change grade**:

  | Grade | official | D3 alone | D3 + D9 exemption | delta |
  |---|---:|---:|---:|---:|
  | HSK 1 | 300 | 368 | **355** | +55 |
  | HSK 2 | 200 | 219 | **220** | +20 |
  | HSK 3 | 500 | 567 | **563** | +63 |
  | HSK 4 | 1,000 | 1,031 | **1,029** | +29 |
  | HSK 5 | 1,600 | 1,523 | **1,537** | −63 |
  | HSK 6 | 1,798 | 1,690 | **1,694** | −104 |
  | total | 5,398 | 5,398 | 5,398 | |

  (Card counts, not distinct Hanzi: 304 cards move but only ~245 distinct
  Hanzi, the difference being homographs that move together. The exemption
  spares 25 cards from hoisting and drops the within-grade component
  constraints from 1,159 to 1,026.)

  Two things follow that need stating plainly. First, the grades no longer
  match the official HSK syllabus word lists — "HSK 1" becomes "the 368 words
  you need to read the HSK 1 vocabulary", which is a defensible and arguably
  better promise, but it is a different promise. If the UI says "HSK 1" it
  should probably say what it now means. Second, 50 words drop three or more
  grades, and the worst are bound morphemes: 漂 "to drift" → HSK 1 (pulled by
  漂亮), 识 "to know" → HSK 1 (认识), 服 → HSK 1 (衣服), 系 → HSK 1 (关系),
  便 → HSK 1 (便宜), 样 → HSK 1. D9 resolves this: the genuinely free words
  among them (漂, 识, 服, 系, 便…) are hoisted normally, and only the 47
  bound cards are exempt.

  Implementation note: because the hoist is a fixed-point computation over the
  dependency graph, it must run *before* the per-grade sort, and the resulting
  grade assignment must be stored in each `.acard` as a `curriculum.grade`
  distinct from the source `level`. Keeping both is what lets the validator
  prove the hoist is the only reason a word left its official grade.
- **Bound morphemes.** `们` is a standalone card in HSK 1, so the repair pass
  would hoist it in front of 我们, 他们, 你们 — teaching a suffix that means
  nothing alone before the pronouns that make it comprehensible. 个 and 些 are
  milder versions of the same. See Q4.
- **Compound-inside-compound (112 words).** Rule 3 as stated mentions single
  characters only, so it is silent on 不客气 ⊃ 客气, 中学生 ⊃ 中学, 大学生 ⊃
  大学, 打电话 ⊃ 电话, 女朋友 ⊃ 朋友. The same pedagogical logic applies. See Q5.
- **1,621 compounds have no in-corpus single-char component at all** (体, 实,
  儿, 机, 物, 作, 工 are common inside compounds but are never standalone
  cards). The rule is simply silent on these, which is fine.

## 5. Determinism guarantees

- The sorter is a pure function of: the `.acard` `curriculum` blocks, the
  pinned frequency subset, `topics.json`, and a declared `rulesVersion`.
- Its output, `cards/curriculum.json`, is **committed**, so a rules change is a
  reviewable reordering diff rather than an invisible behaviour change.
- `cards/curriculum.lock.json` records the digest of every input, and CI
  re-runs the sorter and asserts the committed manifest is reproduced exactly.
- No hash, no RNG, no floating-point comparison anywhere in the sort key.

## 6. Decisions taken

Recorded 2026-09-04. These are settled; the rest of this document assumes them.

**D1 — Curated survival seed, then frequency.** A short hand-authored block
(~15–25 words per grade) is pinned to the front of each grade, then the corpus
frequency order takes over. Rationale: OpenSubtitles under-weights greetings
relative to their value to a beginner — 谢谢 is only position 60 in HSK 1 and
你好 position 98 under pure frequency, which contradicts the "start with 谢谢,
你" intent. The seed costs one small reviewed list per grade and buys exactly
the opening we want.

**D2 — Particles get their own block, after ~4 lessons.** The bound morphemes
are pulled out of the frequency order and placed as one coherent grammar block
once the player has ~40 content words to attach them to. Neither first (six of
the first 40 cards would be particles) nor last (的, the single most common
word in the language, taught in the final lesson).

**D3 — Components are hoisted into the earlier grade.** Rule 3 holds
absolutely, across grades. When a compound needs a component whose standalone
card sits in a later grade, the component moves down to the compound's grade.
*(This was chosen against the recommendation in an earlier draft, which
preferred grade integrity. §4.3 records the measured consequences, which are
material and include a follow-up question.)*

**D4 — Rule 3 extends to nested multi-character words.** 客气 precedes
不客气, 电话 precedes 打电话, 朋友 precedes 女朋友. 112 words affected.

**D5 — `actions-handling` is distributed into domain topics.** Hand verbs join
the domain where the action happens, so a lesson reads as a scene ("in the
kitchen") rather than a verb drill. See §3.4 — this distributes cleanly for
about half the topic and needs a residual block for the rest.

**D6 — Splits.** `time` splits into *Clock & calendar* (concrete, HSK 1–3) and
*Duration, sequence & frequency* (abstract, HSK 5–6). `money-shopping-admin`
splits into *Money & shopping* and *Documents, forms & procedures*. The
oversized topic×grade cells are mechanically split into two numbered parts.

**D7 — Topic blocks are ordered by the mean frequency of their members**, with
a hand-authored per-grade override available where it reads badly.

**D8 — The frequency core wins over topics.** A word taken by the curated seed
or the frequency core is removed from its topic block; every card still
appears exactly once, which is what keeps the manifest verifiable.

**D9 — Bound morphemes are exempt from rule 3** (Q2 option b). 47 cards are
exempt: the 39 single-character cards the source data already marks
`suffix` / `prefix` / `auxiliary` / `助` / `后缀`, plus 8 more whose own example
sentence never uses the character alone — 红 (红色), 黑 (黑色), 白 (白色),
认 (认真), 超 (超过), 同 (一同), 公 (公款), 气 (生气). 业 is in both sets.

Full list: 业 之 了 们 公 则 初 力 化 同 吗 吧 员 呢 品 啊 啦 嘛 地 头 子 家 小
度 式 得 性 感 所 族 气 率 白 的 着 第 等 红 老 者 认 超 边 过 长 面 黑.

The exemption applies to **both** the cross-grade hoist and the within-grade
repair pass, so 我们 no longer waits for 们, and 红色 no longer waits for 红.
Their compounds are taught whole. The exempt cards still exist as cards; they
simply stop being prerequisites. Materialised as a reviewed
`curriculum.boundMorpheme: true` flag rather than a live POS check, so the list
is visible in review.

Everything not on that list is hoisted normally — including 漂, 识, 服, 系 and
便, which an earlier draft wrongly proposed exempting. All five have legitimate
free-standing example sentences in the deck (漂: 一片树叶顺着河水慢慢漂向远处;
系: 他帮孩子系好了安全带), so there is no case for holding them back.

**D10 — Take the frequency corpus dependency.** hermitdave/FrequencyWords
OpenSubtitles-2018 zh_cn, pinned at commit
`f8a65e6ddc17e0baa2e366a909986798d8dbe55b`, SHA-256 gated, vendored under
`tools/import-frequency/` with `notices/` for MIT + CC-BY-SA-4.0 and a
generated `SOURCE.md`, exactly like the stroke data. Share-alike is accepted
knowingly; the repo already ships Arphic Public License data on the same terms.

**D11 — The frequency override file starts minimal.** Two entries at first —
不客气 and 面条儿, the only uncovered HSK 1 words — growing as bad placements
show up in play. D1's curated seed already governs the opening of each grade,
which is where curation earns the most, so the override file does not need to
duplicate it.

## 7. Open questions

None outstanding. The remaining work is execution, in the order set out in
§10 of [`acard_structure.md`](acard_structure.md): extract the `.acard` tree
(recovering HSK 1 from the generated deck.json, since its source package is
corrupt), land `validate:cards`, rewrite the compiler to read `cards/`, prove
the output is byte-identical apart from the fingerprint, then land the topic
vocabulary, the frequency subset and the sorter.

Two things carry known debt into that work:

- **The per-word topic assignment is a first pass** and needs a review sweep
  (§3.3). The taxonomy is agreed; the assignment misfires in places.
- **The D5 redistribution of `actions-handling`** has been sized (§3.4) but not
  performed; 95 words have a clear destination, 11 leave the topic entirely,
  and ~90 stay in the residual `actions-physical` block.
