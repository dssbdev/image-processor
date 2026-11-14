/** Number helpers shared by the tone math, the crop geometry and the UI. */

/** Clamp to [min, max]; when the range is empty (max < min) the result is `min`. */
export function clamp(v: number, min: number, max: number): number {
  if (max < min) return min;
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
