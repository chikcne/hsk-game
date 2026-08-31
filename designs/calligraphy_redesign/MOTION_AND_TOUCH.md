# Motion and touch handoff

## Motion language

Motion should feel like a sheet unrolling and wet ink settling, not like arcade panels snapping.

| Event | Duration | Curve/treatment |
|---|---:|---|
| menu focus transfer | 440–560 ms | `cubic-bezier(.16,1,.3,1)` |
| menu neighbor settle | 360–440 ms | same curve, lower opacity |
| phrase ink reveal | 280–360 ms | near-linear mask; all characters together |
| correct gray sweep | 100–140 ms | top-to-bottom neutralization |
| solved hold | 60–100 ms | fixed at solved y-position |
| solved fade | 380–520 ms | ease-out opacity, no continued descent |
| key press | 45–70 ms | 1 px down; immediate label feedback |
| key preview release | 80–120 ms | quick fade/scale down |

No motion should alter simulation progress, spawn clocks, response timing, target locks, or answer eligibility.

For `prefers-reduced-motion`, remove menu translation, caret pulse, gray sweep, and key-preview animation. Keep immediate state changes, static outlines, and the solved fade at ≤150 ms.

## Mobile keyboard touch model

Use a restrained mahjong-tile treatment: warm ivory faces, 6–8 px rounded corners, a thin gray-green edge, and shallow inset/highlight shadows. Keep the tiles quiet enough that the Hanzi field remains dominant.

The visual key is not the hit box. Fingers hide the label, so register and preview input above the contact point.

```text
         ┌───────┐
         │   A   │  pressed-key preview
         └───┬───┘
             │
      ┌─────────────┐  hit region extends ~8 px upward
      │      A      │  visible key
      └─────────────┘
           finger
```

Implementation rules:

1. Visible letter keys are roughly 32–36 px wide, but rows and split gaps form continuous hit regions at least 44 px high.
2. Bias hit regions 6–10 px upward. Split the horizontal gap at its midpoint so every point resolves to one nearest key.
3. Show a key preview 42–50 px above the key on `pointerdown`; this keeps the chosen letter visible above the finger.
4. Use Pointer Events and `setPointerCapture`. Allow sliding between adjacent letters before release; commit the key under the final pointer position.
5. Cancel on `pointercancel`, window blur, multi-touch conflict, or a large vertical drag into the phrase field.
6. Add light haptic feedback only where supported and only after an explicit user setting; sound/haptics cannot be required feedback.
7. Use three letter rows in standard QWERTY order: `QWERTYUIOP`, `ASDFGHJKL`, `ZXCVBNM`. There is no Shift key or Space key.
8. The bottom row contains only Backspace at the far left and Submit at the far right. `Backspace` may repeat after a 450 ms hold, then every 70–90 ms; letter keys do not repeat.
9. Submit calls the same function as desktop Enter. It is disabled when no target exists, during composition, pause, feedback lock, or meaning phase.
10. Use `touch-action: none` on the keyboard, not on the whole game, so dialogs and meaning lists can still scroll.
11. Respect the bottom safe-area inset and test at 320×568, 360×640, 390×844, and 430×932.

## Avoiding the native keyboard

For standard touch play, the custom keyboard owns text entry and the real input can use `inputmode="none"`. Browser support varies, so handle `visualViewport` changes defensively. Provide an accessible setting to use the native keyboard instead; this is important for switch control, voice input, hardware keyboards, and users relying on platform text entry.

Do not hide the real input with `display:none` or remove its label. Keep it available to assistive technology and mirror custom-key events through the same React state/reducer path.
