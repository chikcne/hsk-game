# Ziduoduo (字多多)

A local-first arcade vocabulary game built from the six HSK Anki packages in `decks/`. Descending Hanzi get faster as their words are mastered and are drawn in PRC stroke order; answer the locked word predicted to land soonest with pinyin, then choose its English meaning by pressing that choice's highlighted first letter.

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

Progress is written atomically to the gitignored `saves/default.json`. If the local API is unavailable, the browser keeps an emergency retry copy and clearly marks the HUD `OFFLINE`.

## Controls

- **Enter** — submit pinyin
- **Highlighted first letter** — select a meaning (every choice starts with a different letter)
- **Replay Audio button** — replay word audio
- **Esc** — pause or resume
- **1–6** — choose an HSK grade

Regular grades use an adjustable 20-word rolling pool: graduating any one word into long-term review introduces the next new word without waiting for the rest of the pool. Spawns follow a target mix — 50% due review/relearning words, 30% words in their learning steps, 20% brand-new words — with empty buckets redistributing their share. Words advance through spaced learning steps (due after 3, 10, then 30 words) before graduating, and are graded continuously: Again (misses, landings, or autocompleted pinyin), Hard (slow correct), Good, or Easy, with pinyin latency normalized per character. When nothing is due, ungraded practice keeps the battlefield alive without touching schedules. The recall window begins when the word becomes the selected target, regardless of its altitude; a target that reaches the ground waits until that full window expires. Grading uses pinyin response time only—meaning-selection time still affects arcade score, but not learning progress.

The grade screen also includes a long-term review mode across mastered words from all grades. Review schedules by wall-clock due dates with stability/difficulty growth (a lapse drops a card into 2/6/18-word relearning steps before it returns to review), keeps a separate recall score (pinyin milliseconds per character), and its end-of-round report ranks the words with the most struggles and misses. Review never changes regular-grade step progress.

Settings control the base spawn interval, global word speed, level size, volume, and reduced motion. Spaced-repetition behavior is fixed by design: steps, grades, and stability growth are constants, not knobs. During battle, a smoothed 0.70–1.50× performance multiplier increases pressure after fast correct answers and eases it after slow answers or misses; word mastery only nudges each word's descent speed within a narrow 0.90–1.10× band, and an empty battlefield refills within 0.5 seconds. There are no lives or game-over screen.

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
