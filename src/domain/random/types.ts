export type RandomState = [number, number, number, number];

/** A deterministic random stream whose complete state can be serialized. */
export interface RandomSource {
  nextUint32(): number;
  /** Returns a value in the half-open interval [0, 1). */
  nextUnit(): number;
  state(): RandomState;
}
