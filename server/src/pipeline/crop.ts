import sharp from 'sharp';
import { aspectToRatio, computeCropRect, isSmartGravity, toNormRect, type NormRect } from '../../../shared/src/crop.js';
import { clamp01 } from '../../../shared/src/math.js';
import type { AspectRatio, Gravity } from '../../../shared/src/spec.js';
import { openProxy } from '../cache/derivatives.js';

const cache = new Map<string, NormRect>();
const MAX_CACHE = 2000;

function remember(key: string, rect: NormRect): NormRect {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, rect);
  return rect;
}

/**
 * Resolve the crop window for an original file, an aspect and a position, as a normalized rect that preview
 * and batch both apply with `fromNormRect`. Everything is computed on the file's proxy (oriented, sRGB,
 * ≤ previewMaxEdge): geometric gravities are pure math on its ratio, attention/entropy run sharp's
 * strategy once on a small probe. Cached per (proxy key, aspect, gravity), so preview == batch by construction.
 */
export async function resolveCrop(
  originalFile: string,
  aspect: AspectRatio | undefined,
  gravity: Gravity,
  focal?: { x: number; y: number } | null,
): Promise<NormRect | null> {
  const ratio = aspectToRatio(aspect ?? 'original');
  if (!ratio) return null;
  const { src, paths } = await openProxy(originalFile);
  /** Pure geometry: the window for a gravity, or centred on a focal point. */
  const geometric = (g: Gravity, point?: { x: number; y: number } | null) => toNormRect(computeCropRect(src.width, src.height, ratio, g, point), src.width, src.height);
  if (focal || !isSmartGravity(gravity)) return geometric(gravity, focal);
  const key = `${paths.key}|${aspect}|${gravity}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // Probe box: target ratio, long edge 480 — enough for the strategy to see the subject, cheap to compute.
  const long = 480;
  const probeW = ratio >= 1 ? long : Math.max(1, Math.round(long * ratio));
  const probeH = ratio >= 1 ? Math.max(1, Math.round(long / ratio)) : long;
  const strategy = gravity === 'attention' ? sharp.strategy.attention : sharp.strategy.entropy;
  const { info } = await src
    .pipeline()
    .resize(probeW, probeH, { fit: 'cover', position: strategy })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const scale = Math.max(probeW / src.width, probeH / src.height);
  const resizedW = src.width * scale;
  const resizedH = src.height * scale;
  const offL = -(info.cropOffsetLeft ?? 0);
  const offT = -(info.cropOffsetTop ?? 0);
  const rect: NormRect = {
    x: clamp01(offL / resizedW),
    y: clamp01(offT / resizedH),
    w: clamp01(probeW / resizedW),
    h: clamp01(probeH / resizedH),
  };
  // Guard: if sharp returned something degenerate, fall back to a centred crop.
  return remember(key, rect.w <= 0.01 || rect.h <= 0.01 ? geometric('center') : rect);
}
