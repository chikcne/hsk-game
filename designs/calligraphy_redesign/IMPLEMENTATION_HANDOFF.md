# Implementation handoff

## 1. Non-negotiable behavior

This redesign is a presentation-layer replacement. Preserve:

- regular HSK and cross-sector review modes;
- deterministic scheduling, cooldowns, mastery, pressure, score, streak, and saves;
- pinyin normalization and submission rules;
- the meaning-choice phase and audio replay;
- pause, settings, wrong-answer review, session summary, and all accessibility announcements;
- one logical outcome per phrase and no game-over state.

The mockup shows the pinyin phase. The meaning phase still follows accepted pinyin; restyle its existing eight choices as a paper slip below the columns on desktop and as a scroll-safe 2 × 4 paper grid replacing the custom keyboard on mobile.

## 2. Visual system

| Token | Value | Use |
|---|---|---|
| paper | `#E8DEC7` | primary field |
| paper light | `#F2EAD7` | raised sheets/key previews |
| paper deep | `#D5C6A7` | keyboard bed/subtle depth |
| ink | `#211D18` | Hanzi and primary text |
| ink soft | `#5D564A` | labels and secondary text |
| ghost | `#AA9F88` | unwritten strokes/inactive metadata |
| indigo | `#234E61` | rules, focus, neutral progress |
| cinnabar | `#A94332` | active target, seals, warning |
| jade | `#476D61` | saved/correct state |

Use a locally bundled, licensed Chinese serif or restrained calligraphy face for large Hanzi. Keep UI labels in the bundled Noto Sans SC. Do not use novelty brush lettering for small English text. Paper fibers must remain subtle enough that they do not cross glyph strokes at high contrast.

## 3. Menu

### Structure

```tsx
<CalligraphyMenu>
  <MenuMasthead />
  <VerticalMenuRail>
    <NextMissionColumn />
    <HskColumn level={1} /> … <HskColumn level={6} />
    <ReviewColumn />
  </VerticalMenuRail>
  <SaveStatus />
  <SettingsButton />
</CalligraphyMenu>
```

The order is explicit and does **not** follow traditional right-to-left reading: next mission is leftmost, HSK 1–6 proceed left-to-right, review is rightmost. Keep the settings button top-right.

Each entire column is one button. Use `writing-mode: vertical-rl` only for the visible label; do not vertically rotate a horizontal button with transforms. Retain number shortcuts 1–6, arrows, Enter, touch, focus states, and truthful mastered totals.

### Fluid navigation

- Hover/focus/selection: selected column rises 7 px over 440–560 ms with an ease-out curve.
- Neighbors settle 7 px downward and reduce to about 58% opacity.
- Selection should move continuously from the prior column; avoid hard card swaps or page flashes.
- Click/tap deploy remains a user gesture so audio unlock behavior is preserved.
- Reduced motion: no translation; use the light paper wash plus cinnabar focus rule.

On mobile all eight columns remain visible. Their visual width may be narrow, but each button's interactive width must be at least 44 CSS px. If a 320 px viewport cannot provide that without collision, make the rail horizontally scrollable with snap points and pin next mission/review affordances at the edges; do not shrink touch targets below 44 px.

## 4. Gameplay field

### React/Phaser ownership

Keep simulation and encounter state in `src/client/state/useBattle.ts`. Replace the enemy art in `src/client/game/BattleScene.ts` with lane rules and high-resolution synchronized Hanzi, or move the entire word layer into DOM while Phaser owns only timing/effects. `src/client/app/App.tsx` remains responsible for semantic answer UI, HUD, dialogs, and live regions.

Recommended shape:

```tsx
<BattleScreen>
  <CalligraphyHud />
  <ColumnField aria-hidden="true" columns={isMobile ? 6 : 12}>
    <PhraseVisual state="writing | falling | solved | fading" />
  </ColumnField>
  <AccessibleTargetStatus />
  <PinyinComposer />
  <MeaningSlip />
  <MobileKeyboard />
</BattleScreen>
```

Canvas remains `aria-hidden`. Repeat target Hanzi, phase, instructions, controls, and feedback in semantic DOM exactly as the current accessibility contract requires.

### Column assignment

Columns are visual only and never affect targeting or travel time.

```ts
columnCount = viewportWidth < 600 ? 6 : 12
spawnColumn = columnCount - 1 - (spawnOrdinal % columnCount)
y = lerp(fieldTop, fieldBottom, enemy.progress)
```

This yields rightmost-to-leftmost spawning and then wraps to the right. Do **not** search for an empty column: wrapping is what allows multiple phrases in a column during overflow. Existing target selection remains predicted-soonest-arrival, not column order or lowest vertical position.

A desktop/mobile breakpoint may reassign visible columns because this assignment is cosmetic. Never respawn, remove, resolve, retarget, or alter a cooldown when the viewport changes.

### Phrase lifecycle

1. **Writing:** render every Hanzi in a phrase as a vertical stack at the top of its assigned column. Animate all phrase characters simultaneously. Until real stroke-order paths exist, use a 280–360 ms ink-mask reveal over a faint complete glyph.
2. **Falling:** bind y-position to existing normalized `enemy.progress`. The cosmetic writing reveal must not pause simulation or response clocks.
3. **Solved:** when the logical phrase resolves correctly, snapshot its current visual position. Sweep ink to warm gray in 100–140 ms, freeze the snapshot, then fade it over 380–520 ms.
4. **Miss/landing:** use cinnabar correction marginalia and the existing blocking/non-blocking rules. Do not reuse the solved gray fade for a miss.
5. **Overflow:** phrases sharing a column retain independent y positions. Apply only a 2–4 px horizontal alternating offset if glyphs overlap exactly; no gameplay collision behavior is introduced.

After a hit, remove the logical enemy immediately as today. The fading remnant is an effect clone with no ID eligible for targeting or outcomes.

### Responsive geometry

| | Desktop | Mobile |
|---|---:|---:|
| Breakpoint | `≥ 600 px` | `< 600 px` |
| Columns | 12 | 6 |
| Safe side padding | 24–64 px | 7–12 px |
| Column field | flexible majority of height | begins directly below compact HUD |
| Pinyin display | centered below field | centered between field and keyboard |
| Keyboard | physical keyboard | custom QWERTY, about 246 px tall |

Use `100dvh`, `env(safe-area-inset-top)`, and `env(safe-area-inset-bottom)`. The mock status bar is illustrative only; production should reserve the real safe area rather than render a fake OS bar.

## 5. Invisible pinyin input

Keep a real, labeled input for editing, composition events, form submission, and assistive technology. Remove its visible box, not the input semantics. Mirror its value into a centered text run with a cinnabar caret. Preserve:

- `autocomplete="off"`, `autocapitalize="none"`, `spellcheck="false"`;
- IME composition handling;
- blank Enter no-op;
- no incremental correctness coloring;
- focus restoration after target/phase changes;
- `v` for `ü` hint.

Desktop uses the physical keyboard. Mobile routes custom-key events through the same pinyin state and submit action as the real form; it must not create a second answer path.

## 6. Existing files to change later

```text
src/client/app/App.tsx             # menu composition, HUD, answer/meaning DOM
src/client/game/BattleScene.ts     # remove arcade enemy art; expose column visuals
src/client/game/GameCanvas.tsx     # synchronized phrase visuals if canvas remains
src/client/styles/main.css         # replace arcade tokens/layout with this system
src/client/state/useBattle.ts      # ideally unchanged; only expose view data if needed
public/fonts/                      # add licensed CJK serif/calligraphy font
```

Do not implement the design by changing domain code under `src/domain/`.

## 7. Acceptance checklist

- [ ] Menu order is next mission, HSK 1–6, review, left-to-right.
- [ ] Settings remains top-right and keyboard reachable.
- [ ] Desktop has exactly 12 visual columns; mobile has exactly 6.
- [ ] Spawn cursor wraps right-to-left and permits occupied columns.
- [ ] A phrase's characters write simultaneously and stack vertically.
- [ ] Falling position remains bound to normalized progress.
- [ ] Correct phrase freezes, grays, and fades without remaining targetable.
- [ ] Typed pinyin has no visible input rectangle.
- [ ] Mobile custom keyboard does not obscure the active field or answer.
- [ ] Meaning, review, settings, pause, saves, audio, feedback, and summary still work.
- [ ] Reduced motion and semantic DOM behavior remain intact.
