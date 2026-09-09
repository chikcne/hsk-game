# Ziduoduo (字多多)

A local-first vocabulary game built from the six HSK Anki packages. **Battle Mode is the main game mode**: an endless, cross-grade arcade battle against descending words. Every enemy is drawn live from your vocabulary's mastery categories — answer the pinyin, choose the meaning, and climb from brand-new words toward mastery. The Writing/Learn workflow (FSRS self-ratings with stroke-order writing) remains implemented internally but is disabled in the UI; the Re-Learn workflow is hidden.

## Run

```bash
npm install
npm run import:decks   # one-time; compiles the source APKGs and local audio
npm run dev            # http://100.65.64.80:5757
```

Battle Mode requires the generated deck data (`npm run import:decks`) and a reachable save server — there is no bundled demo fallback and no offline progress.

Production:

```bash
npm run build
npm start              # http://100.65.64.80:5757
```

## Saves

Progress lives in a server-side SQLite database at the gitignored `saves/default.sql`: a `vocab` table (one row per encountered card — global curriculum position, card id, mastery 0..100, time added, time mastered) and a separate settings key/value table. The browser talks to it exclusively through four endpoints:

- `GET /api/saves/default` → `{ settings, vocab, battleConfig }`
- `POST /api/saves/default/battle/open` → seeds curriculum positions 1..5 on first launch → `{ vocab, addedRows }`
- `POST /api/saves/default/vocab/:cardId/outcome` body `{ cleanCorrect }` → `{ row, addedRows }`
- `PUT /api/saves/default/settings` body `{ settings }` → settings

Each resolved battle encounter persists through the outcome endpoint immediately (per-card serialized, never blocking the animation); the returned authoritative row and any refill rows merge back into the in-memory vocabulary. There are no migrations or save compatibility paths — saves start fresh.

All battle tuning parameters (learning slots, category boundaries, mastery delta, Hill curve, asymptotic shares) live in `config/battle.yaml`, strictly validated at server startup and served to the client as `battleConfig`.

## Battle Mode

The first title-screen column (focused by default) starts the battle; it is enabled from a completely fresh save — launching it seeds curriculum positions 1..5 at mastery 0 on the server.

**Live endless draws.** There is no finite session plan and no forced repair queue. Every spawn is chosen at that moment from the vocabulary:

- the **pool** is every vocab row with mastery > 50 plus exactly the five lowest-position rows with mastery ≤ 50;
- categories are **low** (0..50), **developing** (51..99), and **mastered** (100);
- with `n` = count of rows above 50, the Hill ratio `r = n^1.3 / (n^1.3 + 5^1.3)` sets the shares: low draws `1 − 0.9·r`, the remaining `0.9·r` splits developing:mastered as .50:.40, renormalizing over categories that are empty (n = 0 is 100% low; n ≈ 1 is ~10% mature; n ≈ 7 is ~55% mature);
- the draw is uniform within the selected category and never picks a word that is already active or preparing.

**Mastery.** A clean correct answer (typed/selected pinyin, correct meaning, no reveal) gives **+10**; a wrong pinyin, wrong meaning, reveal, or landing gives **−10**, clamped to 0..100. When a learning-slot word graduates past 50, the server appends the next unseen curriculum entry (strictly in order) until five low rows remain. `time_mastered` is recorded the first time a word reaches 100 and never cleared. Current mastery/100 is the enemy's pressure input — fresh words descend gently, mastered words fall fast.

**Sessions never auto-complete.** A battle runs until you end it from the pause dialog; the summary keeps score, accuracy, best streak, words served, and a most-reinforcement-needed ranking with mastery-category chips.

A **miss** is a wrong pinyin, a wrong meaning, a word reaching the ground, or a pinyin autocomplete/reveal — even if the meaning is then answered correctly. A miss opens the blocking correction panel (word, pinyin, meaning, what you typed) exactly as before.

## Title screen navigation

Three columns: **Battle** (first, focused), **Writing** (disabled), **Glossary**. Arrow keys cycle, Home/End jump; the disabled Writing column is focusable (so its state is discoverable) but refuses activation.

## Glossary

The glossary loads the whole corpus as a mahjong table: vocabulary words are revealed tiles colored by mastery (with their global encounter number), everything else stays concealed. The drawer shows pinyin, definition, audio, and mastery.

## Settings

Battle pacing (base spawn rate, global word speed), the pinyin answer style per orientation (Typing/Selection for desktop and mobile), master volume, and reduced motion are adjustable. The obsolete Learn/session-length controls are hidden. During battle a smoothed 0.70–1.50× performance multiplier increases pressure after fast correct answers and eases it after misses; answers are auto-graded for arcade score only.

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

Generated deck/audio assets in `public/game-data/` and player progress in `saves/` are intentionally not committed. The trimmed, licensed stroke bundles in `public/stroke-data/` are committed so production works without a generation step.
