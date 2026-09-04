import type { ComponentMemory } from "../../shared/schemas";
import { reviewCardMemory } from "../memory";
import type { LearnRating } from "./types";

/** Preview: the card state a rating WILL produce, without applying it. Used
 * to display each rating button's next interval before the player chooses. */
export function previewLearnCard(card: ComponentMemory, rating: LearnRating, now: string | number | Date): ComponentMemory {
  return reviewCardMemory(card, rating, now);
}

/** Humanized future duration for interval previews: under an hour in whole
 * minutes, under a day in fractional hours, otherwise in days. */
export function formatLearnInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "NOW";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
  const days = minutes / (24 * 60);
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}
