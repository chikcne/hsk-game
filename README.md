# Hanzi Defender

A local-first arcade vocabulary game built from the six HSK Anki packages in `decks/`. Descending Hanzi share one speed; answer the closest invader with pinyin, then choose its English meaning by pressing that choice's highlighted first letter.

## Run

```bash
npm install
npm run import:decks   # one-time; compiles the source APKGs and local audio
npm run dev            # http://100.65.64.80:5173
```

The client includes a small bundled training deck so it remains playable while generated deck data is unavailable. Imported data takes precedence automatically.

Production:

```bash
npm run build
npm start              # http://100.65.64.80:8787
```

Progress is written atomically to the gitignored `saves/default.json`. If the local API is unavailable, the browser keeps an emergency retry copy and clearly marks the HUD `OFFLINE`.

## Controls

- **Enter** — submit pinyin
- **Highlighted first letter** — select a meaning (every choice starts with a different letter)
- **Replay Audio button** — replay word audio
- **Esc** — pause or resume
- **1–6** — choose an HSK sector

Regular sectors are split into adjustable 20-word levels. Each level also checks every previously mastered word from that sector once; a slow pinyin response (over five seconds by default), wrong answer, or landing adds that word to the current level's repair pool. Mastery and repeat timing use pinyin response time only—meaning-selection time still affects arcade score, but not learning progress.

The sector screen also includes an Anki-style review mode across mastered words from all sectors. Review keeps a separate recall score (pinyin milliseconds per character), ease, and interval, and its end-of-round report ranks the words with the most struggles and misses. Review recall never changes regular-sector mastery.

Settings control the spawn interval, global enemy speed, level size, struggle threshold, response-time interval formula, mistake interval, mastery gains/losses, Anki review intervals/ease, volume, and reduced motion. Defaults schedule a ten-second correct pinyin response ten phrases later and a wrong answer or landing five phrases later. There are no lives or game-over screen.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Generated assets in `public/game-data/` and player progress in `saves/` are intentionally not committed.
