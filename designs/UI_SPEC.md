# UI, visual, responsive, and accessibility specification

## 1. Visual direction

Use a crisp retro arcade interface, not a fuzzy CRT simulation.

- Deep navy star field with sparse cyan/pink stars
- Hard 1–3 px borders, cut pixel corners, segmented progress bars
- Cyan for controls/neutral energy, mint for success, amber for active target/warning, pink for player/enemy accents, red for breach/miss
- Nearest-neighbour scaling for game art
- Subtle horizontal scanlines at low opacity; they must not reduce text contrast
- Short sprite flashes and stepped particles instead of gradients or realistic lighting
- CJK glyphs remain large and legible even if surrounding UI uses a pixel font

Reference palette:

| Token | Hex | Use |
|---|---|---|
| Space | `#070A18` | page/canvas background |
| Deep space | `#050711` | inputs/keycaps |
| Panel | `#101A36` | primary cards/console |
| Raised panel | `#17254A` | choice buttons |
| Border | `#2B3F70` | inactive outlines |
| White | `#F4F0FF` | primary text/Hanzi |
| Muted | `#8391BE` | labels/help |
| Cyan | `#55E6FF` | focus/control |
| Mint | `#87F5C5` | correct/saved/mastered |
| Amber | `#FFC857` | active target/streak |
| Pink | `#FF5CA8` | brand/enemy effects |
| Red | `#FF5B6E` | wrong/landing only |

Bundle fonts locally. Use a Latin pixel display font similar to “Press Start 2P” for short headings/labels, a compact monospace for body/long meanings, and Noto Sans/Serif CJK SC for Hanzi. Do not force English pixel type onto Chinese glyphs.

## 2. Rendering layers

```tsx
<App>
  <RouteScreen>
    <DeckSelect />
    <BattleScreen>
      <PhaserCanvas aria-hidden="true" />
      <BattleHud />
      <CommandPanel>
        <AccessibleTargetHanzi lang="zh-Hans" />
        <PinyinForm /> | <MeaningGrid />
      </CommandPanel>
      <PauseDialog /> | <SettingsDialog />
      <AnnouncementRegion />
    </BattleScreen>
    <SessionSummary />
  </RouteScreen>
  <SaveStatus />
</App>
```

Phaser renders the moving battlefield. React DOM overlays/adjacent panels render every interactive or required piece of answer information. The app remains usable if canvas text cannot be read by assistive technology.

Configure Phaser:

```ts
{
  type: Phaser.AUTO,
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  backgroundColor: "#070A18",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
}
```

Use a 480×210 logical battle arena on desktop references; the React command panel occupies the rest of the viewport. World positions derive from normalized lane/progress, not DOM pixel measurements.

**Mixed-resolution rule:** sprites, panels, particles, and Latin arcade labels may be drawn at logical resolution and nearest-neighbour scaled, but CJK text must not be baked into that low-resolution layer. Render every Hanzi at output/device resolution with an anti-aliased Noto/Fusion CJK font (for example a high-resolution Phaser Text overlay or synchronized DOM/canvas text layer). Enemy Hanzi should retain smooth, high-resolution strokes even while the saucer beneath it remains pixel art. The supplied mockups use this same split-rendering treatment.

## 3. Screen map

```text
Deck Select (nine columns: Next Learn · HSK 1–6 · Re-Learn · Review)
  ├─ Grade click / Enter -> Learn
  │                          └─ Settings -> Settings over Learn
  ├─ Re-Learn column (enabled only with an active session) -> Relearn
  ├─ Review column (enabled only with acquired words) -> Review Battle
  └─ Settings -> Settings -> Deck Select

Learn
  ├─ GRADES -> Deck Select (active session is kept and resumed later)
  ├─ writing complete -> Rating panel (elapsed time + Again/Hard/Good/Easy
  │                       with per-choice interval previews; keys 1–4)
  └─ last member passed -> Learn Summary
                              ├─ LEARN AGAIN -> Learn (new session if any)
                              └─ RETURN TO GRADES -> Deck Select

Relearn (the one cross-grade active session; same card UX as Learn)
  ├─ GRADES -> Deck Select (session preserved; column resumes it)
  ├─ writing complete -> Rating panel on the member's INDEPENDENT card
  └─ last member re-acquired -> Relearn Summary
                              └─ RETURN TO GRADES -> Deck Select

Review Battle
  ├─ Esc/Pause -> Pause
  │                  ├─ Resume -> Battle
  │                  ├─ Settings -> Settings -> Pause/Battle
  │                  └─ End Session -> Summary
  └─ session complete (base plan resolved, no enemies, repairs cleared) -> Summary

Summary (review)
  ├─ selectable struggle rows (errors preselected)
  ├─ START RE-LEARNING (N) -> Relearn (omitted/disabled when nothing to repair
  │                            or a session is already active)
  ├─ START NEW REVIEW -> Review Battle (fresh deterministic plan)
  └─ RETURN TO GRADES -> Deck Select
```

There is no game-over or death screen.

## 4. Deck selection

Reference: [`01-deck-select.png`](01-deck-select.png)

### Content

- Logo: **ZIDUODUO** with the 字多多 seal mark
- Subtitle: **CHOOSE A GRADE TO STUDY**
- Pilot profile and save status
- Six always-enabled deck cards
- Current mastered/logical count and segmented progress
- `DEPLOY`, `CONTINUE`, or `CLEARED` state
- Last-played/next-lesson strip
- Settings gear/button in top-right, keyboard reachable

Deck totals reflect logical imported words: 300, 200, 500, 1,000, 1,600, and 1,798 for the audited current packages.

A `CLEARED` badge means `firstCompletedAt` exists. Still show current graduated counts if a lapse later regressed them.

### Interaction

- Arrow keys cycle the nine columns; Home/End jump to the first/last.
- Number keys 1–6 may directly choose a deck when focus is not in a field.
- Mouse/touch card activates the same action: grade clicks launch Learn Mode, never a battle. The Re-Learn column is visually and semantically disabled (`aria-disabled`, dimmed, unresponsive) while no relearn session is active; the Review column likewise while there are no acquired words, where it shows the acquired count instead of any due count.
- Launching is a user gesture that unlocks the Web Audio context before loading data.
- Loading shows progress for deck JSON and stroke data; it does not show a blank canvas.
- If the grade has nothing to learn (all words introduced, healthy, not due), a paper notice explains "all caught up" with the next due time instead of navigating.

## 4b. Learn screen

Learn Mode presents one card at a time on the Writing Screen and keeps the
paper/ink visual language.

### HUD

Left to right: grade + `LEARN` seal, `N TO GO · LESSON k`, save state, settings, and a `GRADES` exit. The exit keeps the active session; the grade resumes it later.

### Card

The reusable Writing Card (see `src/client/writing/`): pinyin + audio replay button above the meaning, one large tian-zi square, hangman-style phrase progress row. A never-reviewed card (`reps === 0`) mounts with the looping stroke-order demo and a `TAP TO BEGIN` prompt; later appearances mount straight in writing mode with `SHOW DEMO`.

### Rating panel

When writing completes, the panel shows the word, the writing elapsed time (stroke-count feedback included), and four buttons — `AGAIN 忘记 / HARD 困难 / GOOD 良好 / EASY 简单` — each with the interval that choice produces (e.g. `10m`, `1.5h`, `8.0d`), computed from a preview application of the rating. Keys `1–4` select. After the save checkpoint, the next card mounts immediately.

### Learn summary

Session completion (every member passed into review) shows words finished, newly acquired words (entered `acquired_words`), Again/Hard counts, total writing time, save status, and `LEARN AGAIN` / `RETURN TO GRADES`.

### 4c. Relearn screen

Mirrors the Learn screen for the single cross-grade session: HUD shows
`RE-LEARN · N TO GO` with save status and settings; the Writing Card mounts
with the looping demo on a member's first presentation (its independent card
has `reps === 0`), and ratings preview intervals against that independent
card — never the main Learn card. Completion moves the key to the front of
`acquired_words`; finishing everything shows `RE-LEARN COMPLETE` with the
re-acquired words and `RETURN TO GRADES`.

## 5. Battle HUD and arena

References: [`02-battle-pinyin.png`](02-battle-pinyin.png), [`03-battle-meaning.png`](03-battle-meaning.png)

### HUD

Left to right:

- selected HSK;
- score;
- streak (`xN`, amber);
- session progress bar (resolved spawns vs the base plan plus additive retries);
- save state icon/text;
- pause/settings control.

At narrow widths, keep HSK/score/streak visible and move mastery/save into a second compact line. Never cover an enemy with the HUD.

### Enemies

Every descending enemy carries its own Hanzi. The one **soonest to land** must always be visually and semantically identified as the target:

- amber corner box;
- short amber targeting beam/ticks;
- pink active saucer body;
- command panel repeats exactly the same Hanzi;
- assistive status announces it once when target changes.

Non-target enemies use cyan. An enemy in its final 20% may pulse/red-mark as danger, but red must not override the active amber outline. In Review Mode, enemy speed rises with the word's recency pressure (newest words gentlest, maximum by rank 100 of the acquisition log — never FSRS state) and is multiplied by the configured global speed.

Hanzi sizing by display length:

| Length | Treatment |
|---:|---|
| 1–2 | largest centered glyphs |
| 3–4 | medium single line |
| 5–7 | smaller single line if readable, otherwise two balanced lines |
| >7 | fit within max box and mirror full text in command panel; never truncate semantically |

The importer currently contains mostly short vocabulary, but layout must measure actual glyph bounds. Each descending word's character tile expands with those measured bounds: keep at least 12 output pixels of horizontal padding and 8 output pixels of vertical padding around the CJK ink box. Tile borders, bezels, targeting corners, and danger effects must remain outside that padded box—no graphic may cross or crop a character stroke.

### Base

The base communicates impacts and the player turret but has no health bar. Landing flashes the impacted lane and resets streak; no damage meter should imply eventual death.

## 6. Pinyin command panel

Reference: [`02-battle-pinyin.png`](02-battle-pinyin.png)

Desktop layout:

- left target card: “LOCKED TARGET,” large Hanzi, altitude/danger;
- right: label “TYPE PINYIN — NO TONE MARKS”;
- large focused input;
- `ENTER  FIRE`, `ESC  PAUSE` help.

Behavior:

- focus input whenever pinyin phase begins, unless a dialog is open;
- retain what the player typed while normal frames advance;
- Enter on empty/whitespace does nothing;
- do not mark partial prefixes red/green;
- accepted input switches immediately to meaning phase and plays audio;
- rejected input clears/resolves only after capturing the raw form for statistics;
- use `autocomplete="off"`, `autocapitalize="none"`, `spellcheck="false"`, and suitable `inputmode="text"`;
- IME composition Enter must not submit until composition ends.

Display a small `ü = v` hint near the field after the first deck word that needs it, and keep it in Help.

## 7. Meaning command panel

References: [`03-battle-meaning.png`](03-battle-meaning.png), [`07-mobile-meaning.png`](07-mobile-meaning.png)

After pinyin confirmation:

- show “PINYIN CONFIRMED” in mint;
- show Hanzi, toned pinyin, audio/replay indicator;
- show part of speech or parsed sense label when it disambiguates a source homograph;
- show all eight full sanitized meanings with key badges;
- make the entire button clickable/tappable;
- show `R  REPLAY AUDIO`.

Desktop grid is four columns × two rows in key order:

```text
A  S  D  F
H  J  K  L
```

At widths where a 120-character meaning would become unreadable, use two columns × four rows. Text wraps; it never ellipsizes the correct meaning. The command region may become taller, reducing arena height while preserving normalized travel timing.

Keyboard feedback occurs on keydown, but only one selection dispatch is allowed per enemy. Ignore held-key repeats and keyup duplicates.

## 8. Feedback notices

Reference: [`04-miss-feedback.png`](04-miss-feedback.png)

### Miss/landing

Show for about 800 ms without stopping other enemies:

- correct Hanzi;
- toned pinyin;
- full correct meaning;
- optional example sentence on expandable detail;
- `STREAK RESET`;
- compact reinforcement change, e.g. `PRIORITY 70 → 100`;
- “Progress auto-saved” only after acknowledgement; use “Saving…” before that.

Wrong pinyin may additionally show `YOU TYPED: ...`. Wrong meaning highlights the chosen wrong label with an × and the correct one with a check. Do not rely on red/mint alone.

Several notices queue; a compact count such as `+2 MORE BREACHES` prevents overlapping full panels. Logical outcome and next targeting do not wait for the panel.

### Correct

Use a short stepped explosion, `+points`, and streak increment near the target. Do not open a modal card after every success. Newly mastered words may show a mint `MASTERED` ribbon for 500 ms.

### Audio failure

Show `AUDIO UNAVAILABLE — ANSWER STILL COUNTS` with a replay-disabled icon. Never convert it into a miss.

## 9. Pause and settings

Reference: [`06-settings.png`](06-settings.png)

Pause is a modal dialog with Resume, Settings, End Session, and controls/help. Use actual `<dialog>` behavior or equivalent focus trapping and restore focus on close.

Settings content:

1. **Enemy spawn rate** slider, 1.5–5.0 s, showing both `1 every 3.0s` and `20/min`.
2. **Enemy speed** slider, 0.65–1.50×, showing `SLOW`, `STANDARD`, or `FAST`.
3. Read-only targeting rule: **SOONEST ARRIVAL LOCKS UNTIL RESOLVED**.
4. Master volume, mute, reduced motion, and reset defaults may follow below the gameplay controls.
5. Cancel and Apply Settings buttons.

Keyboard:

- Tab/Shift+Tab remain trapped in modal;
- arrows adjust sliders by one step;
- Escape cancels to prior screen;
- Enter activates focused button, not an unrelated pinyin form.

Apply updates the shared global speed factor for every enemy and restarts one spawn interval. Per-word mastery speed factors remain intact. The paused scene behind settings must not visibly move.

## 10. Session summary

Reference: [`05-session-summary.png`](05-session-summary.png)

Displayed only after End Session or explicit completion transition, never because the player “died.”

Review summary includes:

- session score, accuracy, best streak;
- base-plan size, resolved spawns, and additive retry count;
- unique words served;
- ranked most-missed words with wrong/miss counts, a New/Recent/Old recency chip (captured at session start), and average recall time;
- selectable struggle rows (errors preselected) feeding `START RE-LEARNING (N)` — omitted/disabled for a perfect round or while a relearn session is already active;
- `START NEW REVIEW` (fresh deterministic plan) and `RETURN TO GRADES`;
- authoritative save state.

Learn/Relearn summaries keep their own completion stats (words finished, newly/re-acquired words, rating counts, writing time).

If save has not succeeded, replace the green status with Retry, Export Progress JSON, and Cancel navigation. Do not claim `ALL PROGRESS SAVED` optimistically.

## 11. Responsive layouts

### Desktop, ≥ 1024 CSS px wide

- Arena and HUD occupy approximately top 70–74%.
- Command panel spans bottom 26–30%.
- Meaning choices use 4×2 unless text measurement requires 2×4.
- Maximum content width may be 1440 px with centered outer space.

### Tablet, 600–1023 px

- Compact two-line HUD.
- Arena approximately 55–62% height.
- Target metadata becomes a top strip inside command panel.
- Meaning grid 2×4.

### Mobile, < 600 px

- Portrait layout like [`07-mobile-meaning.png`](07-mobile-meaning.png).
- HUD has HSK, score, streak; mastery moves to pause/secondary line.
- Arena takes upper half during meaning and shrinks while the software keyboard is open for pinyin.
- Meaning choices use 2×4 with minimum 44×44 CSS px touch targets.
- Key letters stay visible even though tapping is expected.
- Pinyin phase uses a sticky command card above the software keyboard.
- Respect `visualViewport` changes so input is not hidden by the keyboard.

At 360×640, long meanings may make the choice region scroll internally, but the active target header and all eight choices remain reachable. Enemy descent continues while the player scrolls, matching keyboard pressure; settings can slow speed for accessibility.

## 12. Accessibility contract

### Semantic duplication

Canvas is `aria-hidden`. DOM provides:

- active Hanzi with `lang="zh-Hans"`;
- current phase/instruction;
- input label;
- all meaning buttons and shortcut keys;
- score/streak/mastery text;
- save status;
- correction feedback.

Use a polite live region for target/phase changes and an assertive but throttled region for landing. Do not announce continuous altitude or each animation frame.

### Keyboard and focus

- Complete game loop works with keyboard only.
- Focus is always visible in cyan/white, not removed by pixel styling.
- Dialogs trap/restore focus.
- Shortcuts do not fire inside unrelated focused controls.
- Browser repeat does not cause multiple answers.
- Offer a Help panel listing Enter, ASDFHJKL, R, Esc, and `v` for `ü`.

### Color and motion

- All normal text meets WCAG AA contrast.
- Correct/wrong include icon and text, not color alone.
- `prefers-reduced-motion` defaults reduced motion on first run; explicit saved setting can override.
- Reduced motion removes screen shake, rapid flashes, scanline animation, and long breach dives; it retains static outline/status changes.
- No effect flashes more than three times per second.

### Audio

- Master volume and mute are persistent.
- Audio has a visible replay control and failure text.
- No gameplay-critical information exists only in sound.

## 13. Pixel asset requirements

An implementation agent should create a small original sprite atlas rather than sourcing unlicensed arcade assets:

- three-frame saucer idle;
- active amber targeting corners/beam;
- danger frame;
- four-frame explosion;
- three-frame breach/impact;
- turret/base tiles;
- small particles/stars;
- save/audio/settings icons.

Sprites should align to a low-resolution grid, use the palette above, and be tested with both one- and seven-character Hanzi overlays. Keep Hanzi as rendered text over the saucer so deck content does not require thousands of sprites.

## 14. Visual acceptance checklist

- [ ] Multiple mastery-scaled enemies are visible in normal play.
- [ ] The locked enemy predicted to land soonest at selection time is unmistakably amber-highlighted.
- [ ] Command-panel Hanzi always matches that highlighted enemy.
- [ ] No life/health/game-over UI exists.
- [ ] Pinyin and meaning phases are visually distinct without moving the battlefield unexpectedly.
- [ ] Eight key labels appear in every meaning layout.
- [ ] Toned pinyin and audio state appear after pinyin succeeds.
- [ ] Settings expose spawn rate and one global speed.
- [ ] Save state is visible and truthful.
- [ ] Desktop and mobile match the supplied PNGs in hierarchy and retro character.
