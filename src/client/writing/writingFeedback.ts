/** Pure hint and feedback copy for the Writing Screen. Selection depends only
 * on quiz events (stroke number, miss counts, direction) so it can be unit
 * tested without a renderer. */

export type WritingFeedbackTone = "good" | "info" | "gentle";
export type WritingFeedback = { tone: WritingFeedbackTone; message: string };

/** Feedback after a rejected stroke attempt. Escalates to a highlighted-stroke
 * hint after the second miss on the same stroke. */
export function mistakeFeedback(info: {
  strokeNum: number;
  totalStrokes: number;
  mistakesOnStroke: number;
  isBackwards: boolean;
}): WritingFeedback {
  const strokeNumber = info.strokeNum + 1;
  if (info.isBackwards && info.mistakesOnStroke <= 1) {
    return { tone: "gentle", message: `Good shape, other direction — redraw stroke ${strokeNumber} the other way.` };
  }
  if (info.mistakesOnStroke <= 1) {
    return { tone: "info", message: `Not quite — try stroke ${strokeNumber} of ${info.totalStrokes} again.` };
  }
  if (info.mistakesOnStroke === 2) {
    return { tone: "gentle", message: `Stroke ${strokeNumber} is now highlighted — trace it in order.` };
  }
  return { tone: "gentle", message: `Take your time — trace the highlighted stroke ${strokeNumber}.` };
}

export function correctStrokeFeedback(info: { strokesRemaining: number }): WritingFeedback {
  if (info.strokesRemaining === 0) return { tone: "good", message: "Character complete." };
  const unit = info.strokesRemaining === 1 ? "stroke" : "strokes";
  return { tone: "good", message: `Good — ${info.strokesRemaining} ${unit} to go.` };
}

export function nextStrokeFeedback(info: { strokeNum: number; totalStrokes: number }): WritingFeedback {
  return { tone: "info", message: `Draw stroke ${Math.min(info.strokeNum + 1, Math.max(0, info.totalStrokes))} of ${info.totalStrokes}.` };
}

export function demoPromptFeedback(): WritingFeedback {
  return { tone: "info", message: "Watch the stroke order. Tap the square or press Enter, then write it yourself." };
}

export function missingDataFeedback(character: string): WritingFeedback {
  return { tone: "gentle", message: `No stroke data for ${character} — finishing it for you.` };
}

/** Announced when word playback fails (for example an autoplay policy block
 * before the first gesture); the replay button stays the retry affordance. */
export function audioFailureFeedback(): WritingFeedback {
  return { tone: "gentle", message: "Word audio did not play — the replay button will try again." };
}
