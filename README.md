# Ziduoduo (字多多)

A local-first arcade vocabulary game built from the six HSK Anki packages in `decks/`. Descending Hanzi get faster as their words become familiar and are drawn in PRC stroke order; answer the locked word predicted to land soonest with pinyin, then choose its English meaning by pressing that choice's highlighted first letter. Long-term memory runs on FSRS (via `ts-fsrs`) with separate pinyin and meaning states per word, combined with hard arcade spacing cooldowns.

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

Regular grades use an adjustable 20-word rolling pool: mastering any one word introduces the next new word without waiting for the rest of the pool. During ordinary learning, practiced but not-yet-mastered words receive 55% of spawns and completely new words receive 45%; mistakes remain in the higher-priority repair pool. The recall window begins when the word becomes the selected target, regardless of its altitude; a target that reaches the ground waits until that full window expires. Mastery and repeat timing use pinyin response time only—meaning-selection time still affects arcade score, but not learning progress.

The grade screen also includes a cross-grade review mode for words that have graduated (both pinyin and meaning memory through their learning steps) from any grade. Review rounds are finite: they contain exactly the cards whose FSRS due date has passed — relearning repairs first, then the graduated cards closest to being forgotten — and end when nothing is due. Their end-of-round report ranks the words with the most struggles and misses.

Settings control the base spawn interval, global word speed, level size, volume, and reduced motion. All memory parameters (FSRS weights, retention target, latency rating thresholds) are fixed constants in `src/domain/memory` so scheduling cannot drift from the science. The interval after each spawn scales linearly from 160% of the base for a brand-new word, through 100% at mid familiarity, to 40% for well-known words, derived from FSRS state. During battle, a smoothed 0.70–1.50× performance multiplier increases pressure after fast correct answers and eases it after slow answers or misses; an empty battlefield refills within 0.5 seconds. Answers are auto-graded: wrong or revealed pinyin is Again, effortful-but-correct recall is Hard, normal recall is Good, and fast recall is Easy (never on a first exposure). There are no lives or game-over screen.

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
