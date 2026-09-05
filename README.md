# Ziduoduo (字多多)

A local-first vocabulary game built from the six HSK Anki packages in `decks/`. Clicking an HSK grade launches **Learn Mode**: every currently due word of the grade plus a fresh batch of new curriculum words, presented one card at a time with pinyin, meaning, and audio while you write each character in PRC stroke order. Long-term memory runs on FSRS (via `ts-fsrs`) with **one card per word** and four explicit self-ratings — Again, Hard, Good, Easy — each showing the interval it will produce before you commit. Graduated words feed the cross-grade **Review arcade** and the independent **Re-Learn workflow**.

## Run

```bash
npm install
npm run import:decks   # one-time; compiles the source APKGs and local audio
npm run dev            # http://100.65.64.80:5757
```

The client includes a small bundled training deck so it remains playable while generated deck data is unavailable. Imported data takes precedence automatically.

Production:

```bash
npm run build
npm start              # http://100.65.64.80:5757
```

Progress is written atomically to the gitignored `saves/default.json` after every rating. If the local API is unavailable, the browser keeps an emergency retry copy and clearly marks the save state `OFFLINE`.

## Learn Mode

Each Learn session is created (or resumed exactly) when you click a grade:

1. it contains **every currently due introduced word** of that grade plus **up to "new cards per session" brand-new curriculum words** (a 5–20 settings slider), drawn only from the current authored 20-card lesson;
2. every card shows pinyin and meaning, auto-plays its audio (replayable), and is completed by guided, forgiving stroke-order writing; on a word's very first presentation, each character loops its stroke-order demo until you start writing it, while later appearances offer **Show Demo** instead;
3. after writing, the card shows the writing elapsed time and the four ratings with live next-interval previews; FSRS applies the chosen rating to the word's single card;
4. a word leaves the session when its card reaches the FSRS review state — a lapsed repair recurs via **learn-ahead** (the earliest due remaining card is always served, even if not yet due) — and the session ends only when every word has passed. Words enter the ordered `acquired_words` table exactly once, the moment their card first reaches review.

Leaving mid-session keeps the session; clicking the grade resumes it.

## Controls (Learn Mode)

- **Tap / Enter** on the writing square — start writing (after a demo)
- **1–4** or the buttons — rate Again / Hard / Good / Easy
- **Replay audio button (♪)** — replay word audio

## Review Mode

The rightmost title-screen column opens the cross-grade Review arcade. It is enabled at **20 acquired words** (the column shows the acquired count, never a due count) and battles draw **solely from the ordered `acquired_words` log** — never from FSRS due dates or retrievability, and battle answers never mutate any main Learn card.

Each session gets a **deterministic, nonpersisted base plan** built once at session start from the persisted RNG. At 100+ acquired words, it uses exactly `settings.reviewSessionLength` spawns (integer slider, 200–500, default 200):

- ranks 0–19 in the acquisition log (**New**, the 20 newest words) are served **exactly twice**;
- ranks 20–99 (**Recent**) exactly once;
- every remaining slot draws uniformly at random from rank 100+ (**Old**), with Recent then New as fallbacks. Quota and filler entries are shuffled together, so tiers interleave instead of arriving in blocks.

For 20–99 acquired words, the New/Recent boundaries, recency pressure, and base session length all scale by `acquiredWords.length / 100`. For example, 50 acquired words produce 10 New + 40 Recent words and a default 100-spawn battle. Recency drives difficulty instead of FSRS: New words are gentlest, rising linearly to near-maximum pressure at the end of a smaller pool or maximum by rank 100 in a full pool. The global spawn-rate and word-speed settings and the live performance multiplier still apply on top.

A **miss** is a wrong pinyin, a wrong meaning, a word reaching the ground, or a pinyin autocomplete/reveal — even if the meaning is then answered correctly. A missed word enters a delayed repair queue and re-enters the stream after 10 further base spawns; it remains an obligation until one later encounter is **clean** (typed pinyin, correct meaning, no reveal). Base occurrences can clear a repair. If obligations survive the base plan, retries are **additive beyond the slider target** and forced, so the session always ends: every base spawn resolved, no enemies left, all repairs cleared. The session is **not resumable** — leaving ends it (progress and RNG advances are checkpointed throughout).

The summary ranks the most-missed words with wrong/miss counts and New/Recent/Old chips. Struggle rows are selectable (errors preselected) and **START RE-LEARNING (N)** hands the selection to the Re-Learn workflow; a perfect round simply omits it. **START NEW REVIEW** rebuilds a fresh plan; **RETURN TO GRADES** exits.

## Re-Learn

Struggling acquired words can be sent to the single cross-grade **Re-Learn session** (重学). It persists in the save, holds each selected word's **fresh, independent FSRS card** inside the session (ratings never copy back to the main Learn cards), and uses the same Learn/Writing UX: pinyin + meaning, immediate writing with an optional **Show Demo** control (never an automatic demo), elapsed writing time, four ratings with interval previews, and earliest-due learn-ahead. Progress saves after every rating, so exiting preserves exact state. Each word finishes the moment its independent card reaches the FSRS review state — its key is then **removed and prepended to `acquired_words`** (moved to newest/front) — and completing the session clears it. The title screen's dedicated Re-Learn column (between the grades and Review) resumes the active session and is visually and semantically disabled when none exists.

## Title screen navigation

Nine columns: **Next Learn**, the six HSK grades (keyboard **1–6**), **Re-Learn**, **Review**. Arrow keys cycle, Home/End jump; disabled columns are focusable (so their state is discoverable) but refuse activation.

## Settings

Learn Mode's **new cards per session (5–20)**, Review Mode's **session length (base spawns, 200–500)**, base spawn rate and global word speed, volume, and reduced motion are adjustable. Learn follows the committed frequency-led curriculum in `cards/curriculum.json`; there is no per-profile shuffle, and lowering the setting simply splits one fixed lesson across multiple sessions. All memory parameters (FSRS weights, retention target, learning steps) are fixed constants in `src/domain/memory` so scheduling cannot drift from the science. During Review, a smoothed 0.70–1.50× performance multiplier increases pressure after fast correct answers and eases it after misses; answers are auto-graded for arcade score only.

## Stroke-order data

All visible Chinese text is rendered as inline SVG from local Make Me a Hanzi outlines. Animated gameplay glyphs use the pinned `hanzi-writer` dependency; static UI labels use a lightweight declarative renderer and the small `ui.json` bundle. Dynamic vocabulary loads only its deck-scoped subset from `public/stroke-data/`, and missing data displays a vector placeholder rather than requesting a CJK font. English and pinyin use a bundled Latin-only WOFF2 subset of AR PL UKai, with the operating system's UI sans-serif stack as fallback. The browser never requests character data or fonts from GitHub or a CDN.

The subsets are deterministic derivatives of Make Me a Hanzi `graphics.txt` at commit `618dbab8a8ddefb958763c8b4afbaa741a4460de` (required SHA-256 `a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee`). To regenerate after compiling the decks:

```bash
curl -L https://raw.githubusercontent.com/skishore/makemeahanzi/618dbab8a8ddefb958763c8b4afbaa741a4460de/graphics.txt -o /tmp/graphics.txt
npm run import:strokes -- --source /tmp/graphics.txt
```

The extractor validates paths and medians, blocks missing HSK characters, applies the reviewed source-linked corrections in `tools/import-strokes/overrides.json`, and records bundle checksums in `public/stroke-data/manifest.json`. Provenance and licenses are in `public/stroke-data/SOURCE.md`, `COPYING`, `ARPHICPL.txt`, and `HANZI_WRITER_LICENSE.txt`. The stroke graphics credit Shaunak Kishore's Make Me a Hanzi and Arphic PL KaitiM GB / Arphic PL UKai.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Generated deck/audio assets in `public/game-data/` and player progress in `saves/` are intentionally not committed. The trimmed, licensed stroke bundles in `public/stroke-data/` are committed so production and the demo fallback work without a generation step.

Save schema v5 is a fresh start: older or corrupt saves fail validation and simply start over on the next save.
