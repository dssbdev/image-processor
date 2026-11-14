import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { cachePath, getSettings } from '../config.js';
import { openSource, type DecodedSource } from '../decoders/index.js';
import { writeFileAtomic } from '../fs/util.js';
import { renderImage, type RenderSpec } from '../pipeline/render.js';
import { IDENTITY_LOOK } from '../../../shared/src/spec.js';

/**
 * Thumbnails (grid) and proxies (previews) are derived once per (path, size, mtime) and kept in the cache
 * dir. Both are sRGB-baked, oriented JPEGs, so anything downstream can treat them as plain photos.
 * A HEIC decode is the expensive part, so one decode produces both derivatives.
 */

const IDENTITY_SPEC: RenderSpec = { look: IDENTITY_LOOK, longEdge: 0, format: 'jpeg', quality: 92 };

/** Sizes the gallery may ask a thumbnail in; requests are rounded up to one of these so the cache stays small. */
const THUMB_BUCKETS = [160, 240, 320, 480, 640, 800, 1024];

const inflight = new Map<string, Promise<void>>();
let limiter: ReturnType<typeof pLimit> | null = null;
function limit() {
  if (!limiter) limiter = pLimit(Math.max(1, getSettings().concurrency));
  return limiter;
}

/** Run `build` for `key` at most once at a time: concurrent callers share the same promise. */
async function once(key: string, build: () => Promise<void>): Promise<void> {
  let job = inflight.get(key);
  if (!job) {
    job = limit()(build).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  await job;
}

/** Render `src` (no look, no crop) to a JPEG no larger than `maxEdge` and write it to `target`. */
async function writeResized(src: DecodedSource, target: string, maxEdge: number, quality: number): Promise<void> {
  const { data } = await renderImage(src, IDENTITY_SPEC, { maxEdge, encode: { format: 'jpeg', quality } });
  await writeFileAtomic(target, data);
}

export function cacheKey(file: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${file}|${size}|${Math.round(mtimeMs)}`).digest('hex');
}

export interface DerivativePaths {
  key: string;
  thumb: string;
  proxy: string;
}

export async function derivativePaths(file: string): Promise<DerivativePaths> {
  const st = await stat(file);
  const key = cacheKey(file, st.size, st.mtimeMs);
  return {
    key,
    thumb: path.join(cachePath('thumbs'), `${key}.jpg`),
    proxy: path.join(cachePath('proxies'), `${key}.jpg`),
  };
}

/** Ensure both derivatives exist; returns their paths. Safe to call concurrently for the same file. */
export async function ensureDerivatives(file: string): Promise<DerivativePaths> {
  const p = await derivativePaths(file);
  if (existsSync(p.thumb) && existsSync(p.proxy)) return p;
  await once(p.key, () => buildDerivatives(file, p));
  return p;
}

async function buildDerivatives(file: string, p: DerivativePaths): Promise<void> {
  const settings = getSettings();
  await Promise.all([mkdir(path.dirname(p.thumb), { recursive: true }), mkdir(path.dirname(p.proxy), { recursive: true })]);
  if (!existsSync(p.proxy)) await writeResized(await openSource(file), p.proxy, settings.previewMaxEdge, 92);
  // Thumb from the freshly written proxy is cheaper than a second full decode.
  if (!existsSync(p.thumb)) await writeResized(await openSource(p.proxy), p.thumb, settings.thumbSize, 80);
}

/** Thumbnail at an arbitrary size (rounded up to a bucket), derived from the proxy. The gallery zoom slider uses this. */
export async function ensureThumbSize(file: string, size: number): Promise<string> {
  const bucket = THUMB_BUCKETS.find((b) => b >= size) ?? THUMB_BUCKETS[THUMB_BUCKETS.length - 1]!;
  const p = await ensureDerivatives(file);
  if (bucket === getSettings().thumbSize) return p.thumb;
  const target = path.join(cachePath('thumbs'), `${p.key}-${bucket}.jpg`);
  if (!existsSync(target)) {
    await once(`${p.key}-${bucket}`, async () => {
      if (!existsSync(target)) await writeResized(await openSource(p.proxy), target, bucket, 82);
    });
  }
  return target;
}

/** Open the proxy of a file as a DecodedSource (oriented, sRGB, ≤ previewMaxEdge). */
export async function openProxy(file: string): Promise<{ src: DecodedSource; paths: DerivativePaths }> {
  const paths = await ensureDerivatives(file);
  const src = await openSource(paths.proxy);
  return { src, paths };
}
