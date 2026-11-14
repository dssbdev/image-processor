import { clamp01 } from './math.js';
import type { Look } from './spec.js';

/**
 * Pure tone / colour math for the look stage. No sharp here — everything is numbers in and numbers out,
 * so it is unit-testable and could run in a browser later.
 *
 * Model:
 *   1. per-channel gain in linear light (warmth)          — R up / B down for warm, the reverse for cool
 *   2. exposure in linear light                            — × 2^EV
 *   3. encode to sRGB
 *   4. shadows, highlights, contrast on the encoded value  — perceptual, like every consumer editor
 *   5. clamp
 * Saturation, vignette and sharpen are handled by sharp (LCH modulate, multiply overlay, unsharp mask)
 * and are not part of the LUT.
 */

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const SHADOW_STRENGTH = 0.25; // max lift at the peak of the shadow weight, slider = +100
const HIGHLIGHT_STRENGTH = 0.25; // max pull at the peak of the highlight weight, slider = -100
const WARMTH_GAIN = 0.12; // ±12 % on R and B in linear light at slider = ±100
const TINT_GAIN = 0.08; // ±8 % on G (and half the opposite on R/B) at slider = ±100
const CONTRAST_FLATTEN = 0.5; // slider = -100 compresses toward mid-grey by 50 %
const FADE_MAX = 0.18; // slider = 100 lifts black to 18 % (matte film territory)
const VIBRANCE_STRENGTH = 0.9;
const SPLIT_STRENGTH = 0.35; // max blend toward the toning colour at amount = 100

/** Weight peaking at x = 1/3 (value 1). Zero at both ends so black and white are pinned. */
export function shadowWeight(x: number): number {
  return 6.75 * x * (1 - x) * (1 - x);
}

/** Weight peaking at x = 2/3 (value 1). Zero at both ends. */
export function highlightWeight(x: number): number {
  return 6.75 * x * x * (1 - x);
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/**
 * Apply the encoded-domain part of the curve: shadows → highlights → contrast.
 * `x` is an sRGB-encoded value in [0,1]. Returns [0,1].
 */
export function toneEncoded(x: number, look: Look): number {
  let y = clamp01(x);
  const s = look.shadows / 100;
  const h = look.highlights / 100;
  const c = look.contrast / 100;
  const f = (look.fade ?? 0) / 100;
  if (s !== 0) y = clamp01(y + SHADOW_STRENGTH * s * shadowWeight(y));
  if (h !== 0) y = clamp01(y + HIGHLIGHT_STRENGTH * h * highlightWeight(y));
  if (c > 0) y = y + c * (smoothstep(y) - y);
  else if (c < 0) y = y + -c * CONTRAST_FLATTEN * (0.5 - y);
  // Fade: lift the black point, easing out so mid-tones and highlights barely move.
  if (f > 0) {
    const lift = FADE_MAX * f;
    y = lift + (1 - lift) * y;
  }
  return clamp01(y);
}

/** Per-channel linear-light gains for warmth (R↔B) and tint (G vs R+B): [r, g, b]. */
export function warmthGains(warmth: number, tint = 0): [number, number, number] {
  const w = warmth / 100;
  const t = tint / 100;
  return [(1 + WARMTH_GAIN * w) * (1 + (TINT_GAIN / 2) * t), 1 - TINT_GAIN * t, (1 - WARMTH_GAIN * w) * (1 + (TINT_GAIN / 2) * t)];
}

/**
 * Full curve for one channel: linear-light input in [0, ∞) → encoded output in [0,1].
 * `gain` is the warmth gain for this channel; exposure comes from `look`.
 */
export function toneFromLinear(lin: number, gain: number, look: Look): number {
  const exposed = lin * gain * Math.pow(2, look.exposure);
  return toneEncoded(linearToSrgb(exposed), look);
}

export interface ToneLuts {
  /** 256-entry lookup per channel for 8-bit sRGB input. */
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  /** True when every table is the identity (nothing to do). */
  identity: boolean;
}

/**
 * Build the per-channel 8-bit tables. Input index = encoded 8-bit value, output = encoded 8-bit value.
 * Used by the fast path (no colour matrix). Cost: 3 × 256 evaluations, negligible.
 */
export function buildToneLuts(look: Look): ToneLuts {
  const gains = warmthGains(look.warmth, look.tint ?? 0);
  const luts = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)] as const;
  let identity = true;
  for (let ch = 0; ch < 3; ch++) {
    const gain = gains[ch]!;
    const lut = luts[ch]!;
    for (let i = 0; i < 256; i++) {
      const y = toneFromLinear(srgbToLinear(i / 255), gain, look);
      const v = Math.round(y * 255);
      lut[i] = v;
      if (v !== i) identity = false;
    }
  }
  return { r: luts[0], g: luts[1], b: luts[2], identity };
}

export const LINEAR_LUT_SIZE = 4096;

export interface LinearToneLuts {
  /** Index = round(linear × 4095) with linear clamped to [0,1]; value = encoded 8-bit output. */
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

/**
 * Tables indexed by *linear* light, for the matrix path (Display P3 → sRGB happens in linear light,
 * so the tone curve has to be evaluated after the matrix, on a linear value).
 */
export function buildLinearToneLuts(look: Look): LinearToneLuts {
  const gains = warmthGains(look.warmth, look.tint ?? 0);
  const make = (gain: number) => {
    const lut = new Uint8Array(LINEAR_LUT_SIZE);
    for (let k = 0; k < LINEAR_LUT_SIZE; k++) {
      lut[k] = Math.round(toneFromLinear(k / (LINEAR_LUT_SIZE - 1), gain, look) * 255);
    }
    return lut;
  };
  return { r: make(gains[0]), g: make(gains[1]), b: make(gains[2]) };
}

/** 256-entry float table: encoded 8-bit → linear light. */
export function buildDecodeLut(): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
}

/**
 * Display P3 (D65) → sRGB (D65), linear light, row-major. Same transfer curve on both sides,
 * so the matrix is the whole conversion. Values that leave [0,1] are clamped (out of sRGB gamut).
 */
export const P3_TO_SRGB: readonly number[] = [
  1.2249401, -0.2249404, 0.0,
  -0.0420569, 1.0420571, 0.0,
  -0.0196376, -0.0786361, 1.0982735,
];

export type ColorMatrix = readonly number[]; // 9 numbers, row-major 3×3

/**
 * Apply the look to an interleaved RGB (3 channels, 8-bit) buffer in place.
 * Fast path when no matrix; matrix path decodes to linear, multiplies, then uses linear-indexed tables.
 */
export function applyLookToRgb8(data: Uint8Array | Uint8ClampedArray, look: Look, matrix?: ColorMatrix): void {
  applyToneStage(data, look, matrix);
  if (needsColorPass(look)) applyColorPass(data, look);
}

function applyToneStage(data: Uint8Array | Uint8ClampedArray, look: Look, matrix?: ColorMatrix): void {
  const n = data.length - (data.length % 3);
  if (!matrix) {
    const { r, g, b, identity } = buildToneLuts(look);
    if (identity) return;
    for (let i = 0; i < n; i += 3) {
      data[i] = r[data[i]!]!;
      data[i + 1] = g[data[i + 1]!]!;
      data[i + 2] = b[data[i + 2]!]!;
    }
    return;
  }
  const dec = buildDecodeLut();
  const { r, g, b } = buildLinearToneLuts(look);
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix as [
    number, number, number, number, number, number, number, number, number,
  ];
  const scale = LINEAR_LUT_SIZE - 1;
  for (let i = 0; i < n; i += 3) {
    const lr = dec[data[i]!]!;
    const lg = dec[data[i + 1]!]!;
    const lb = dec[data[i + 2]!]!;
    let nr = m00 * lr + m01 * lg + m02 * lb;
    let ng = m10 * lr + m11 * lg + m12 * lb;
    let nb = m20 * lr + m21 * lg + m22 * lb;
    nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
    ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
    nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;
    data[i] = r[Math.round(nr * scale)]!;
    data[i + 1] = g[Math.round(ng * scale)]!;
    data[i + 2] = b[Math.round(nb * scale)]!;
  }
}

/** Hue (degrees) → RGB in [0,1] at full saturation, mid lightness. */
export function hueToRgb(hue: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [1, x, 0];
  else if (h < 2) [r, g, b] = [x, 1, 0];
  else if (h < 3) [r, g, b] = [0, 1, x];
  else if (h < 4) [r, g, b] = [0, x, 1];
  else if (h < 5) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  return [r, g, b];
}

/** True when the per-pixel colour pass (vibrance / split toning) has anything to do. */
export function needsColorPass(look: Look): boolean {
  return (look.vibrance ?? 0) !== 0 || (look.splitShadowAmount ?? 0) > 0 || (look.splitHighlightAmount ?? 0) > 0;
}

/**
 * Vibrance and split toning, in place, on encoded 8-bit RGB. Runs after the tone LUT.
 * Vibrance: scale chroma around the pixel's luma by (1 + v·(1 − sat)) so muted colours move most.
 * Split toning: blend toward the shadow colour weighted by (1−luma)² and toward the highlight colour by luma².
 */
export function applyColorPass(data: Uint8Array | Uint8ClampedArray, look: Look): void {
  const v = (look.vibrance ?? 0) / 100;
  const sa = ((look.splitShadowAmount ?? 0) / 100) * SPLIT_STRENGTH;
  const ha = ((look.splitHighlightAmount ?? 0) / 100) * SPLIT_STRENGTH;
  if (v === 0 && sa === 0 && ha === 0) return;
  const [sr, sg, sb] = hueToRgb(look.splitShadowHue ?? 0);
  const [hr, hg, hb] = hueToRgb(look.splitHighlightHue ?? 0);
  const n = data.length - (data.length % 3);
  for (let i = 0; i < n; i += 3) {
    let r = data[i]! / 255;
    let g = data[i + 1]! / 255;
    let b = data[i + 2]! / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (v !== 0) {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      const k = v > 0 ? 1 + VIBRANCE_STRENGTH * v * (1 - sat) : 1 + VIBRANCE_STRENGTH * v * (0.5 + 0.5 * sat);
      r = luma + (r - luma) * k;
      g = luma + (g - luma) * k;
      b = luma + (b - luma) * k;
    }
    if (sa > 0) {
      const w = sa * (1 - luma) * (1 - luma);
      r += (sr - r) * w * (0.5 + 0.5 * (1 - luma));
      g += (sg - g) * w * (0.5 + 0.5 * (1 - luma));
      b += (sb - b) * w * (0.5 + 0.5 * (1 - luma));
    }
    if (ha > 0) {
      const w = ha * luma * luma;
      r += (hr - r) * w * (0.5 + 0.5 * luma);
      g += (hg - g) * w * (0.5 + 0.5 * luma);
      b += (hb - b) * w * (0.5 + 0.5 * luma);
    }
    data[i] = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
    data[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : Math.round(g * 255);
    data[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : Math.round(b * 255);
  }
}

/**
 * Clarity = local (mid-frequency) contrast. Implemented as a very-large-radius unsharp mask: the "blur" is
 * the image downscaled to a small size (long edge CLARITY_BLUR_EDGE), gaussian-blurred there, and scaled back
 * up (cheap at any resolution, and blur radius scales with the image so a 1600 px preview and a 48 MP export
 * look the same). Positive: add the detail (orig − blur), weighted toward the midtones so highlights do not
 * clip and blacks do not crush. Negative: blend toward the blur (soft glow). Returns null at 0.
 */
export const CLARITY_BLUR_EDGE = 400;

export interface ClarityParams {
  /** Signed strength: >0 local contrast (0..1.2), <0 soften mix (−0.6..0). */
  amount: number;
  /** Size of the small blur image. */
  smallWidth: number;
  smallHeight: number;
  /** Gaussian sigma in the small image (≥ 1). */
  sigma: number;
}

export function clarityParams(clarity: number, width: number, height: number): ClarityParams | null {
  if (!clarity || width <= 0 || height <= 0) return null;
  const c = Math.max(-1, Math.min(1, clarity / 100));
  const long = Math.max(width, height);
  const scale = Math.min(1, CLARITY_BLUR_EDGE / long);
  const smallWidth = Math.max(1, Math.round(width * scale));
  const smallHeight = Math.max(1, Math.round(height * scale));
  const sigma = Math.max(1, Math.min(smallWidth, smallHeight) * 0.012);
  return { amount: c > 0 ? 1.2 * c : 0.6 * c, smallWidth, smallHeight, sigma };
}

/**
 * Apply clarity in place. `blur` is the blurred copy at the same size as `data` (RGB 8-bit, interleaved).
 * Positive amount: out = orig + amount · (orig − blur) · midtoneWeight; negative: out = mix(orig, blur, −amount).
 */
export function applyClarityToRgb8(data: Uint8Array | Uint8ClampedArray, blur: Uint8Array | Uint8ClampedArray, amount: number): void {
  const n = Math.min(data.length, blur.length) - 2;
  if (amount > 0) {
    for (let i = 0; i <= n; i += 3) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // Luma of the original, 0..1; weight peaks at mid-grey (1) and falls to 0.35 at black/white.
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const w = amount * (0.35 + 0.65 * 4 * l * (1 - l));
      const nr = r + (r - blur[i]!) * w;
      const ng = g + (g - blur[i + 1]!) * w;
      const nb = b + (b - blur[i + 2]!) * w;
      data[i] = nr <= 0 ? 0 : nr >= 255 ? 255 : Math.round(nr);
      data[i + 1] = ng <= 0 ? 0 : ng >= 255 ? 255 : Math.round(ng);
      data[i + 2] = nb <= 0 ? 0 : nb >= 255 ? 255 : Math.round(nb);
    }
  } else if (amount < 0) {
    const m = Math.min(1, -amount);
    const k = 1 - m;
    for (let i = 0; i <= n; i += 3) {
      data[i] = Math.round(data[i]! * k + blur[i]! * m);
      data[i + 1] = Math.round(data[i + 1]! * k + blur[i + 1]! * m);
      data[i + 2] = Math.round(data[i + 2]! * k + blur[i + 2]! * m);
    }
  }
}

/** Saturation slider (-100..100) → sharp `modulate({ saturation })` multiplier. */
export function saturationMultiplier(saturation: number): number {
  return Math.max(0, 1 + saturation / 100);
}

/** Sharpen slider (0..100) → sharp `sharpen()` parameters tuned for output sharpening. */
export function sharpenParams(sharpen: number): { sigma: number; m1: number; m2: number } | null {
  if (sharpen <= 0) return null;
  const a = Math.min(1, sharpen / 100);
  return { sigma: 0.5 + 0.7 * a, m1: 0.2 + 0.8 * a, m2: 0.8 + 2.2 * a };
}

/**
 * Vignette mask factor for a pixel at normalized radius d (0 = centre, 1 = corner) and slider v (0..100).
 * 1 = untouched. Falls off smoothly from 40 % of the way to the corner. Corner darkening at v=100 is 60 %.
 */
export function vignetteFactor(d: number, vignette: number): number {
  const v = Math.max(0, Math.min(1, vignette / 100));
  if (v === 0) return 1;
  const t = clamp01((d - 0.4) / 0.6);
  return 1 - 0.6 * v * smoothstep(t);
}

/**
 * Build a small greyscale mask (size×size, 1 channel, 8-bit) that sharp scales to the output size and
 * multiplies in. Elliptical: distance is normalized per axis so corners are the far end on any ratio.
 */
export function buildVignetteMask(vignette: number, size = 256): Uint8Array {
  const mask = new Uint8Array(size * size);
  const half = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    const dy = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2; // corner → 1
      mask[y * size + x] = Math.round(vignetteFactor(d, vignette) * 255);
    }
  }
  return mask;
}
