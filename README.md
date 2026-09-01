# Hanzi Defender

A local-first arcade vocabulary game built from the six HSK Anki packages in `decks/`. Descending Hanzi get faster as their words are mastered and are drawn in PRC stroke order; answer the locked invader predicted to land soonest with pinyin, then choose its English meaning by pressing that choice's highlighted first letter.

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
- **1–6** — choose an HSK sector

Regular sectors use an adjustable 20-word rolling pool: mastering any one word introduces the next new word without waiting for the rest of the pool. During ordinary learning, practiced but not-yet-mastered words receive 55% of spawns and completely new words receive 45%; mistakes remain in the higher-priority repair pool. The recall window begins when the word becomes the selected target, regardless of its altitude; a target that reaches the ground waits until that full window expires. Mastery and repeat timing use pinyin response time only—meaning-selection time still affects arcade score, but not learning progress.

The sector screen also includes an Anki-style review mode across mastered words from all sectors. Review keeps a separate recall score (pinyin milliseconds per character), ease, and interval, and its end-of-round report ranks the words with the most struggles and misses. Review recall never changes regular-sector mastery.

Settings control the base spawn interval, global enemy speed, level size, struggle threshold, response-time interval formula, mistake interval, mastery gains/losses, Anki review intervals/ease, volume, and reduced motion. The interval after each spawn scales linearly from 160% of the base for a 0%-mastery word, through 100% at 50% mastery, to 40% at full mastery. During battle, a smoothed 0.70–1.50× performance multiplier increases pressure after fast correct answers and eases it after slow answers or misses; an empty battlefield refills within 0.5 seconds. Defaults schedule a ten-second correct pinyin response ten phrases later and a wrong answer or landing five phrases later. There are no lives or game-over screen.

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
