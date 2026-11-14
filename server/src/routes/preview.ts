import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openProxy } from '../cache/derivatives.js';
import { renderImage } from '../pipeline/render.js';
import { ItemSpecSchema, resolveItemCrop, resolveLook } from '../pipeline/spec.js';
import { IDENTITY_LOOK } from '../../../shared/src/spec.js';
import type { NormRect } from '../../../shared/src/crop.js';
import { imagePath } from './core.js';

const Body = ItemSpecSchema.extend({
  path: z.string().min(1),
  maxEdge: z.number().int().min(200).max(4000).default(1400),
  /** 'after' = full look; 'before' = same crop + resize, identity look. */
  mode: z.enum(['before', 'after']).default('after'),
});

/** Previews are always a fast JPEG, whatever the export will be. */
const PREVIEW_ENCODE = { format: 'jpeg', quality: 88 } as const;

interface Rendered {
  data: Buffer;
  crop: NormRect | null;
  width: number;
  height: number;
  source: { width: number; height: number };
}

/** Least-recently-used cache of rendered previews: a Map keeps insertion order, so its first key is the oldest. */
const LRU_MAX = 120;
const lru = new Map<string, Rendered>();

async function cached(key: string, render: () => Promise<Rendered>): Promise<Rendered> {
  const entry = lru.get(key) ?? (await render());
  lru.delete(key);
  lru.set(key, entry);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value!);
  return entry;
}

/**
 * POST /api/preview — render the file's proxy through a look + crop. Same code path as the export, smaller
 * output. Response: image/jpeg with X-Crop (normalized rect JSON or "null"), X-Size ("w×h") and X-Source-Size.
 */
export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/preview', async (req, reply) => {
    const body = Body.parse(req.body);
    const file = imagePath(body.path);
    const look = body.mode === 'before' ? IDENTITY_LOOK : await resolveLook(body.look, body.adjust);
    const { src, paths } = await openProxy(file);
    const { crop, ratio } = await resolveItemCrop(file, body);

    const key = createHash('sha1').update(JSON.stringify([paths.key, look, ratio, body.maxEdge, crop])).digest('hex');
    const preview = await cached(key, async () => {
      const r = await renderImage(src, { look, crop, ratio, longEdge: 0, ...PREVIEW_ENCODE }, { maxEdge: body.maxEdge, encode: PREVIEW_ENCODE });
      return { data: r.data, crop, width: r.width, height: r.height, source: { width: src.width, height: src.height } };
    });

    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Crop', JSON.stringify(preview.crop))
      .header('X-Size', `${preview.width}x${preview.height}`)
      .header('X-Source-Size', `${preview.source.width}x${preview.source.height}`)
      .header('Access-Control-Expose-Headers', 'X-Crop, X-Size, X-Source-Size')
      .type('image/jpeg')
      .send(preview.data);
  });
}
