import { clamp } from './math.js';
import type { AspectRatio, Gravity } from './spec.js';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Crop window as fractions of the source (0..1). Resolution-independent so preview and batch share it. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 'original' → null (no crop); '4:5' → 0.8 (width / height). */
export function aspectToRatio(aspect: AspectRatio): number | null {
  if (aspect === 'original') return null;
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return null;
  return w / h;
}

/** True for gravities that need pixel analysis (resolved by the server), false for pure geometry. */
export function isSmartGravity(g: Gravity): g is 'attention' | 'entropy' {
  return g === 'attention' || g === 'entropy';
}

/**
 * Largest window of the requested ratio that fits inside width×height, positioned by gravity
 * (or by an explicit focal point in 0..1 coordinates, which wins over gravity).
 * Smart gravities fall back to centre here; the server replaces them with a resolved focal point.
 */
export function computeCropRect(
  width: number,
  height: number,
  ratio: number | null,
  gravity: Gravity,
  focal?: { x: number; y: number } | null,
): Rect {
  if (!ratio || width <= 0 || height <= 0) return { left: 0, top: 0, width, height };
  let w: number;
  let h: number;
  if (width / height > ratio) {
    h = height;
    w = Math.round(h * ratio);
  } else {
    w = width;
    h = Math.round(w / ratio);
  }
  w = Math.min(w, width);
  h = Math.min(h, height);
  const freeX = width - w;
  const freeY = height - h;

  let fx = 0.5;
  let fy = 0.5;
  if (focal) {
    fx = focal.x;
    fy = focal.y;
  } else {
    switch (gravity) {
      case 'north':
        fy = 0;
        break;
      case 'south':
        fy = 1;
        break;
      case 'east':
        fx = 1;
        break;
      case 'west':
        fx = 0;
        break;
      case 'northeast':
        fx = 1;
        fy = 0;
        break;
      case 'northwest':
        fx = 0;
        fy = 0;
        break;
      case 'southeast':
        fx = 1;
        fy = 1;
        break;
      case 'southwest':
        fx = 0;
        fy = 1;
        break;
      default:
        break; // center, attention, entropy → 0.5
    }
  }
  // A focal point means "keep this point in the middle of the window when possible".
  const left = focal
    ? clamp(Math.round(fx * width - w / 2), 0, freeX)
    : Math.round(fx * freeX);
  const top = focal
    ? clamp(Math.round(fy * height - h / 2), 0, freeY)
    : Math.round(fy * freeY);
  return { left, top, width: w, height: h };
}

export function toNormRect(r: Rect, width: number, height: number): NormRect {
  return { x: r.left / width, y: r.top / height, w: r.width / width, h: r.height / height };
}

/** Back to pixels for an image of the given size; guaranteed to stay inside the image and be ≥ 1px. */
export function fromNormRect(n: NormRect, width: number, height: number): Rect {
  let w = Math.round(n.w * width);
  let h = Math.round(n.h * height);
  w = clamp(w, 1, width);
  h = clamp(h, 1, height);
  const left = clamp(Math.round(n.x * width), 0, width - w);
  const top = clamp(Math.round(n.y * height), 0, height - h);
  return { left, top, width: w, height: h };
}

/** Size after fitting inside `longEdge` (0 = no resize). Never enlarges. */
export function fitInside(width: number, height: number, longEdge: number): { width: number; height: number } {
  if (!longEdge || longEdge <= 0) return { width, height };
  const long = Math.max(width, height);
  if (long <= longEdge) return { width, height };
  const s = longEdge / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
