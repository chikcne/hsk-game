# Calligraphy visual redesign mockups

A paper-and-ink visual direction for the existing Hanzi Defender mechanics. The concept borrows the **material mood** of old practice books and the **textual motion** of fluid menu systems without reproducing either reference.

## Open the mockups

- [`index.html`](index.html) — gallery of all four reference captures
- [`menu.html`](menu.html) — responsive menu prototype
- [`gameplay.html`](gameplay.html) — responsive pinyin-phase gameplay prototype
- [`desktop-menu.png`](desktop-menu.png) — 1440 × 900 reference capture
- [`mobile-menu.png`](mobile-menu.png) — 390 × 844 reference capture
- [`desktop-gameplay.png`](desktop-gameplay.png) — 1440 × 900 reference capture
- [`mobile-gameplay.png`](mobile-gameplay.png) — 390 × 844 reference capture

Resize either HTML file across the 600 px breakpoint to compare desktop and mobile. The menu columns are interactive; the mobile keyboard accepts taps in the prototype.

## Concept at a glance

```text
MENU — explicit left-to-right order
┌──────────┬──────┬──────┬──────┬──────┬──────┬──────┬────────┐
│ NEXT     │ HSK1 │ HSK2 │ HSK3 │ HSK4 │ HSK5 │ HSK6 │ REVIEW │
│ MISSION  │      │      │      │      │      │      │        │
└──────────┴──────┴──────┴──────┴──────┴──────┴──────┴────────┘

GAMEPLAY — spawn cursor travels right-to-left
┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ 12 columns on desktop                               ← SPAWN │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
                     typed pinyin

Mobile uses the rightmost six-column composition plus the custom keyboard.
```

## Files

- [`shared.css`](shared.css) — paper texture, palette, fonts, shared controls
- [`menu.css`](menu.css) — vertical menu composition and responsive behavior
- [`gameplay.css`](gameplay.css) — column field, phrase states, answer area, keyboard
- [`prototype.js`](prototype.js) — mockup-only interactions
- [`IMPLEMENTATION_HANDOFF.md`](IMPLEMENTATION_HANDOFF.md) — mapping to the React/Phaser app
- [`MOTION_AND_TOUCH.md`](MOTION_AND_TOUCH.md) — motion timings, reduced motion, and touch keyboard behavior

These are design artifacts, not production components. Keep the game domain, scheduler, score, mastery, save, and encounter reducers unchanged during implementation.
