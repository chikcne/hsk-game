# Stroke-order word rendering plan

## Status and recommendation

**Feasibility: high.** This can be implemented entirely in the presentation/data-loading layer without changing scheduling, saves, scoring, targeting, or encounter timing.

**Recommendation: render gameplay characters as animated SVG stroke paths from Make Me a Hanzi. Keep UKai for static UI text and as an error fallback, but do not use the font itself as the animation source.**

A normal font supplies one final glyph outline. It does not expose where one stroke ends, which stroke comes next, or the direction in which a stroke is written. UKai therefore cannot produce correct stroke order by itself. Attempting to reveal UKai with gradients or masks can only create a geometric wipe—the current “fill down” effect—not handwriting.

Make Me a Hanzi provides exactly the missing information:

- a separate filled SVG path for every stroke;
- strokes already listed in PRC stroke order;
- a median polyline for revealing each stroke from its start to its end;
- a shared 1024 × 1024 coordinate system.

The data is derived partly from **Arphic PL UKai**, as well as Arphic PL KaitiM GB, so it is stylistically compatible with the bundled font. It is not guaranteed to be pixel-identical to the particular UKai glyph chosen by the browser. To avoid a visible shape jump, an animated gameplay character should remain the Make Me a Hanzi SVG after completion rather than being swapped back to font text.

## Current implementation

The current field is already well positioned for this change:

- `src/client/game/GameCanvas.tsx` renders each phrase in React DOM and splits `displayHanzi` into one vertical `<span>` per Unicode character.
- `src/client/styles/main.css` applies `background-clip: text` and animates a top-to-bottom gradient for 340 ms. This is the source of the “fill down” behavior.
- Phrase position remains driven by `enemy.progress`; columns are a cosmetic projection of `spawnOrdinal`.
- `src/client/state/useBattle.ts` owns simulation and outcomes and does not need stroke state.
- The visual field is `aria-hidden`; `src/client/app/App.tsx` already repeats the target in semantic DOM for assistive technology.
- A correct phrase is removed logically and recreated as a short-lived gray remnant. That remnant will need a static completed SVG so it does not replay its writing animation.
- `src/client/game/BattleScene.ts` is currently a no-op effects scene. There is no reason to move stroke rendering into Phaser.

This means the work is a replacement of each visual character span, not a gameplay-system rewrite.

## Dataset audit

Audit performed against current Make Me a Hanzi head [`bddc96d41bef78427ed0e034e9f7e31d71fd1b92`](https://github.com/skishore/makemeahanzi/tree/bddc96d41bef78427ed0e034e9f7e31d71fd1b92). Its `graphics.txt` is byte-identical to the last data-changing commit, [`618dbab8a8ddefb958763c8b4afbaa741a4460de`](https://github.com/skishore/makemeahanzi/tree/618dbab8a8ddefb958763c8b4afbaa741a4460de), which is the revision this plan recommends pinning:

| Item | Result |
|---|---:|
| Make Me a Hanzi characters in `graphics.txt` | 9,574 |
| Current generated HSK logical words | 5,398 |
| Unique characters across all six current decks | 1,940 |
| Unique current characters covered | 1,940 (100%) |
| Average strokes per covered character | 8.94 |
| Largest current character | 23 strokes (`罐`) |
| Largest current word by total stroke count | 47 strokes (`酸甜苦辣`) |
| HSK-only compact stroke data, uncompressed | about 4.85 MB |
| Same data, gzip estimate | about 1.98 MB |
| Same data, Brotli estimate | about 1.56 MB |

The current words are one to four characters long. All current characters are in the source dataset, so there is no coverage blocker. The importer must still fail on a missing CJK character after either deck data or the pinned Make Me a Hanzi revision changes.

Coverage does not prove that every source entry is pedagogically perfect. Make Me a Hanzi is a semi-automatically generated, manually reviewed PRC-order dataset with known open quality reports. Current HSK content overlaps reports for `肠` ([issue #95](https://github.com/skishore/makemeahanzi/issues/95)) and `滚` ([issue #72](https://github.com/skishore/makemeahanzi/issues/72)); median-quality reports also mention current characters such as `愿` and `割` ([issue #90](https://github.com/skishore/makemeahanzi/issues/90)). Before calling the result authoritative, review those entries against a current PRC stroke-order reference and keep a small source-linked override or exception list. The implementation can faithfully animate the dataset; it cannot automatically detect an incorrect source order.

Approximate uncompressed data if bundles are emitted per deck:

| Bundle | Unique characters | Size |
|---|---:|---:|
| HSK 1 | 248 | 0.50 MB |
| HSK 2 | 200 | 0.43 MB |
| HSK 3 | 480 | 1.09 MB |
| HSK 4 | 803 | 1.87 MB |
| HSK 5 | 1,130 | 2.72 MB |
| HSK 6 | 1,342 | 3.30 MB |

Per-deck bundles duplicate characters on disk, but they keep the normal battle load small and are still modest beside the existing fonts and audio. Review mode can load and merge all six cached bundles while its existing loading screen is visible.

## Rendering decision

### Recommended implementation

Use [`hanzi-writer`](https://github.com/chanind/hanzi-writer) with its SVG renderer and a local `charDataLoader` backed by the trimmed Make Me a Hanzi data.

Why:

- it already converts the stroke outlines and medians into a convincing within-stroke reveal;
- it handles stroke length, direction, clipping, and stroke sequencing;
- it accepts the `strokes`/`medians` schema directly;
- it supports animation pause/resume, color updates, static outlines, and completion callbacks;
- its code is MIT licensed and small compared with the data and existing fonts;
- it avoids maintaining a second, subtle implementation of the “median brush clipped to the filled stroke outline” algorithm.

Do **not** install or ship the full `hanzi-writer-data` package. It is roughly 32 MB unpacked and would include thousands of unused characters. Extract the current HSK subset from the requested Make Me a Hanzi repository instead.

Do **not** ship Make Me a Hanzi’s pre-generated `svgs/` directory. The current upstream directory is roughly 174 MB, embeds fixed colors/timings, and is awkward to coordinate, pause, recolor, and render as solved remnants. Generate inline SVG through Hanzi Writer from the local compact data.

### Proof-of-concept fallback

If Hanzi Writer proves too costly for ephemeral React components at the 32-enemy safety ceiling, use a small declarative SVG renderer with the same data:

1. draw each stroke outline faintly as the guide;
2. place the stroke outline in a `clipPath`;
3. convert its median points to an SVG polyline path;
4. animate that path’s dash offset with a broad round brush while clipping it to the outline;
5. replace the partial brush with the complete outline when the stroke finishes;
6. repeat in array order.

This is feasible, but the upstream README explicitly describes median animation as tricky. It should be the fallback, not the first implementation.

## Intended visual behavior

### One phrase spawn

1. The phrase container mounts at its existing column and progress position.
2. Every character receives its own square inline SVG.
3. Characters in the phrase begin together, preserving the existing design and keeping four-character words from taking several seconds.
4. Within each character, strokes animate strictly in the dataset’s listed PRC order and direction.
5. Earlier strokes remain fully inked while the next stroke is drawn.
6. On completion, the complete Make Me a Hanzi paths remain visible; there is no swap to UKai text.
7. The phrase continues descending throughout. Animation callbacks never pause, resolve, select, or otherwise affect an enemy.

Starting phrase characters together is the recommended gameplay compromise. It preserves correct order inside every character while keeping the visual cue short enough for a pressure game. A later option could write the characters top-to-bottom in sequence, but the current worst word has 47 total strokes and would require either a long reveal or strokes too fast to perceive.

### Timing

The present 340 ms wipe is too short to communicate the order of a 15–23-stroke character. Start the proof of concept around:

- `strokeAnimationSpeed`: 3–5× Hanzi Writer’s normal speed;
- `delayBetweenStrokes`: 15–25 ms;
- practical character duration: approximately 0.5–1.5 seconds, based on stroke count and length;
- all characters in a word animating concurrently.

Tune against `一`, `口`, `女`, `必`, `谢`, `罐`, and `酸甜苦辣`. The acceptance criterion is that stroke order is perceivable without delaying gameplay, not that every character has the same total duration.

A faint complete guide may remain underneath the ink so the player is never disadvantaged while the target’s first strokes are appearing. It should use the **same SVG outlines**, not UKai text, and remain subtle enough that the moving ink is dominant.

### State changes

- **Target:** update the writer’s stroke color to the existing cinnabar token without recreating the writer or replaying the animation.
- **Non-target:** use the existing ink token.
- **Danger/new-word markers:** retain the existing phrase-level decorations.
- **Correct remnant:** render the completed SVG immediately, then run the existing gray sweep/fade. Never replay writing on the remnant mount.
- **Miss/landing:** retain current correction behavior; do not wait for an SVG animation callback.
- **Pause/hidden page:** pause and resume active writer animations alongside visual movement where practical. This remains cosmetic.
- **Reduced motion:** render the completed SVG immediately, with no stroke animation. Keep the short solved fade already specified for reduced motion.
- **Unexpected missing/failed data:** render a static UKai character, report a development diagnostic, and keep gameplay functional. A production bundle should never reach this fallback because coverage validation is blocking.

## Data pipeline

### Source pinning

Use only [`graphics.txt`](https://github.com/skishore/makemeahanzi/blob/618dbab8a8ddefb958763c8b4afbaa741a4460de/graphics.txt). `dictionary.txt` is unnecessary and has a different LGPL license.

Pin the last data-changing revision rather than a moving branch or a later documentation-only commit:

```text
repository: https://github.com/skishore/makemeahanzi
commit: 618dbab8a8ddefb958763c8b4afbaa741a4460de
graphics.txt SHA-256: a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee
```

The browser must never fetch GitHub, a CDN, or Hanzi Writer’s default data endpoint at runtime.

### Extractor

Add a deterministic build-time command, separate from gameplay code, which:

1. reads the six generated `public/game-data/hsk-*/deck.json` files;
2. includes every character used by the bundled demo deck;
3. iterates strings by Unicode code point (`[...text]` or `codePointAt`), not UTF-16 `charCodeAt`;
4. streams the newline-delimited `graphics.txt` rather than loading the 30 MB source as browser data;
5. retains only `strokes` and `medians` for required characters;
6. validates non-empty arrays, equal stroke/median counts, finite coordinates, at least two points per median, and valid SVG path data—do not require integer coordinates because a small number of upstream medians contain valid fractional points;
7. applies only source-linked, reviewed corrections from `tools/import-strokes/overrides.json` and reports every one;
8. treats missing CJK data as a blocking error;
9. permits explicitly allowed non-Hanzi punctuation to use static text fallback;
10. sorts output deterministically by Unicode code point;
11. emits source commit, source checksum, schema version, character count, applied overrides, and output checksum in a manifest.

Suggested compact runtime schema:

```ts
type StrokeCharacterData = {
  strokes: string[];
  medians: [number, number][][];
};

type StrokeBundle = {
  schemaVersion: 1;
  sourceCommit: string;
  sourceSha256: string;
  characters: Record<string, StrokeCharacterData>;
};
```

Do not add stroke paths to `RuntimeWord`. The same character occurs in many words and decks; embedding paths per word would inflate deck JSON and unnecessarily change deck fingerprints and save reconciliation.

### Output and loading

Recommended output:

```text
public/stroke-data/
  hsk-1.json
  hsk-2.json
  hsk-3.json
  hsk-4.json
  hsk-5.json
  hsk-6.json
  manifest.json
  COPYING
  ARPHICPL.txt
  SOURCE.md
```

The per-deck extractor should union in the demo characters so the existing `createDemoDeck` fallback is still visually complete.

Load the selected deck JSON and matching stroke bundle in parallel before changing from the loading screen to battle. Cache bundle promises and parsed character maps at module scope. Review mode may load all six bundles in parallel and merge by character. This prevents a first-spawn font flash and ensures stroke loading never starts a gameplay clock late.

Do not import the JSON into the JavaScript entry bundle; keep it as a separately fetched static asset so menu startup does not parse data for a battle that may not be entered.

## React integration shape

Suggested component boundary:

```tsx
<PhraseVisual enemy={enemy} state="writing | falling | solved">
  {[...enemy.word.displayHanzi].map((character, index) => (
    <StrokeOrderCharacter
      key={`${enemy.id}-${index}`}
      character={character}
      data={strokeData.get(character)}
      animate={!remnant && !reducedMotion}
      paused={paused}
      color={target ? "cinnabar" : "ink"}
    />
  ))}
</PhraseVisual>
```

Implementation rules:

- Create each Hanzi Writer instance only when `(enemy.id, characterIndex)` mounts.
- Use a synchronous local `charDataLoader`; battle entry has already loaded the bundle.
- Memoize the wrapper so the parent’s frequent `enemy.progress` updates do not recreate writers or restart animations.
- Keep movement transforms on the phrase container. The SVG itself should not receive per-frame React changes.
- Update target color through the existing writer instance rather than remounting it.
- Size each writer to a square matching the current one-character line box so the vertical word layout remains unchanged.
- Pass an explicit `animate={false}` for solved remnants.
- Remove/clear the writer host on unmount and ensure late completion callbacks are no-ops.
- Keep the entire field `aria-hidden`; the existing semantic target status remains the accessible source of truth.
- Use the same character data for the faint guide and final ink. Do not overlay font glyphs beneath SVG paths.

## Files expected to change during implementation

```text
package.json                              # pinned Hanzi Writer dependency and data command
package-lock.json
README.md                                 # data-generation and attribution notes

tools/import-strokes/cli.ts              # pinned-source extractor entry point
tools/import-strokes/extract.ts          # selection, validation, deterministic output
tools/import-strokes/types.ts
tools/import-strokes/overrides.json      # reviewed, source-linked corrections only

public/stroke-data/*                      # generated local subsets and notices

src/client/data/strokeData.ts             # fetch/cache/merge/fallback behavior
src/client/game/StrokeOrderCharacter.tsx  # Hanzi Writer lifecycle wrapper
src/client/game/GameCanvas.tsx            # replace character spans, static remnants
src/client/app/App.tsx                    # load stroke bundle before battle, pass pause/data
src/client/styles/main.css                # remove ink-write wipe; size SVG hosts and states

tests/import-strokes/*.test.ts            # extraction, validation, coverage, determinism
tests/client/stroke-rendering.test.tsx    # lifecycle/reduced-motion/fallback if DOM setup is added
```

`src/client/state/useBattle.ts`, `src/domain/**`, save schemas, and server routes should remain unchanged. Fastify already serves files under `public`/`dist`; no new runtime API should be necessary.

## Licensing and attribution

Make Me a Hanzi’s `graphics.txt` is derived from Arphic PL KaitiM GB and Arphic PL UKai and is distributed under the Arphic Public License. The repository already carries `public/fonts/ARPHICPL.txt` for UKai, but the generated stroke dataset should also carry its own source notice so it is clear that the JSON/SVG data is covered.

Implementation should:

- copy the upstream `COPYING` notice and the English Arphic Public License beside the generated data;
- record the repository URL, exact commit, source checksum, extraction date, and a prominent description of how the emitted data was trimmed/reformatted or corrected;
- keep the derivative data and extraction process available under the Arphic Public License without additional restrictions;
- cite “Kishore, Shaunak (2018), Make Me a Hanzi (commit 618dbab)” and credit Arphic PL KaitiM GB and Arphic PL UKai;
- retain the existing UKai font license;
- retain Hanzi Writer’s MIT license/notice if that dependency is used;
- avoid `dictionary.txt`, since no dictionary fields are needed.

This is an engineering reading of the upstream notices, not legal advice.

## Delivery phases

### Phase 0 — visual/performance spike

- Render several representative characters from a hardcoded local sample.
- Confirm Hanzi Writer accepts the pinned raw `strokes`/`medians` format.
- Compare SVG shape with the current UKai visual direction.
- Validate target recoloring, static completion, reduced motion, and cleanup.
- Stress 32 four-character phrases, with only newly spawned phrases animating.

**Exit:** animation is visibly stroke-ordered, no font/SVG jump occurs, and movement remains smooth on a representative mobile device.

### Phase 1 — deterministic data extraction

- Add the pinned extractor and source verification.
- Emit deck-scoped compact bundles and manifest.
- Add coverage and malformed-data tests.
- Review known source-quality reports that overlap the HSK set and document any overrides/exceptions.
- Add licensing/attribution files.

**Exit:** every current CJK character is covered and repeated runs are byte-for-byte identical.

### Phase 2 — battle asset loading

- Add fetch/cache/merge logic.
- Load deck and stroke data in parallel before battle.
- Cover regular, review, and bundled-demo paths.
- Add explicit runtime fallback for asset failure.

**Exit:** the first enemy never begins as UKai and later changes to SVG.

### Phase 3 — phrase integration

- Replace character spans in `GameCanvas`.
- Preserve column placement, y-progress, target/new/danger markers, and overlap offsets.
- Make solved remnants static and preserve their current fade.
- Ensure per-frame parent updates do not replay writing.

**Exit:** only visual character rendering changes; domain tests and deterministic scheduling remain unchanged.

### Phase 4 — polish and verification

- Tune speed, guide opacity, padding, and stroke color.
- Verify pause/visibility and reduced-motion behavior.
- Test one- through four-character words at desktop/mobile sizes.
- Run maximum-enemy and rapid-resolve stress cases.
- Add a small visual regression set for difficult strokes and long words.

## Acceptance criteria

- [ ] Every current HSK character has validated local stroke data.
- [ ] Known upstream quality reports overlapping the HSK set have a documented review decision or source-linked override.
- [ ] Each visible character draws strokes in the reviewed Make Me a Hanzi PRC order and direction.
- [ ] Characters in one phrase animate concurrently; strokes within a character do not.
- [ ] Completed characters remain SVG paths and do not swap to UKai.
- [ ] No runtime request goes to GitHub or a third-party CDN.
- [ ] The first spawn waits for battle assets, not for an individual character request.
- [ ] Writing does not change spawn clocks, descent, target locks, response clocks, score, mastery, or saves.
- [ ] Progress rerenders and target-color changes do not restart animation.
- [ ] Correct-answer remnants show a completed SVG and fade without replaying.
- [ ] Missing-data fallback cannot crash or block an encounter.
- [ ] Reduced motion shows the completed character immediately.
- [ ] Existing semantic target text and live announcements remain intact.
- [ ] 32 active phrases remain usable on a representative mobile device.
- [ ] Source commit, checksums, modification notice, and licenses ship with the data.

## Effort and principal risks

A reasonable estimate is **4–7 engineering days**, including the extractor, integration, tests, and mobile tuning. No save migration or domain rewrite is expected.

Main risks:

1. **Transient-renderer lifecycle/performance.** Mitigate with one writer instance per mounted character, memoization, static remnants, and the Phase 0 safety-ceiling stress test.
2. **Shape mismatch if font and SVG are mixed.** Avoid mixing them; keep SVG through the final gameplay frame and use UKai only as fallback/static UI.
3. **Animation too fast to teach or too slow for play.** Animate phrase characters concurrently and tune by stroke length/count.
4. **Future source/deck drift.** Pin the commit/checksum and make CJK coverage a blocking extractor check.
5. **Source correctness is not guaranteed merely by coverage.** Review known reports, visually test difficult characters, and keep corrections explicit and source-linked.
6. **Licensing omissions in generated data.** Ship notices beside the derivative bundle, describe modifications prominently, and document provenance in its manifest.

Overall, this is a practical and well-contained enhancement. The existing UKai remains useful for the rest of the calligraphy UI, but SVG paths from Make Me a Hanzi are the correct source for gameplay stroke-order animation.
