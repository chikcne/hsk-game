# Hanzi Defender

A local-first arcade vocabulary game built from the six HSK Anki packages in `decks/`. Descending Hanzi share one speed; answer the closest invader with pinyin, then choose its English meaning using **A S D F H J K L**.

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
- **A S D F H J K L** — select a meaning
- **R** — replay word audio
- **Esc** — pause or resume
- **1–6** — choose an HSK sector

Settings control the spawn interval, one global enemy speed, volume, and reduced motion. There are no lives or game-over screen; misses reset the streak and increase that word's reinforcement priority.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Generated assets in `public/game-data/` and player progress in `saves/` are intentionally not committed.
