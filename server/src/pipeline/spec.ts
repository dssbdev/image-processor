import { z } from 'zod';
import { aspectToRatio, type NormRect } from '../../../shared/src/crop.js';
import { FocalSchema, NormRectSchema } from '../../../shared/src/edits.js';
import { ASPECT_RATIOS, GRAVITIES, IDENTITY_LOOK, LookSchema, mergeLook, type Look } from '../../../shared/src/spec.js';
import { getSettings } from '../config.js';
import { lookStore } from '../store/looks.js';
import { resolveCrop } from './crop.js';

/**
 * What a client says about one photo: its look, adjustments and crop (the sidecar state, basically).
 * The preview and the export routes both accept exactly this, so they cannot drift apart.
 */
export const ItemSpecSchema = z.object({
  /** Look preset slug (''/'none' = identity) or an unsaved look object (editor state). */
  look: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  /** Slider adjustments on top of the look. */
  adjust: z.record(z.string(), z.number()).nullish(),
  aspect: z.enum(ASPECT_RATIOS).nullish(),
  gravity: z.enum(GRAVITIES).nullish(),
  /** Focal point (0..1) the crop window should centre on; ignored when `crop` is given. */
  focal: FocalSchema.nullish(),
  crop: NormRectSchema.nullish(),
});
export type ItemSpec = z.infer<typeof ItemSpecSchema>;

const NO_LOOK = new Set(['', 'none', 'identity']);

/** Resolve a look reference + adjustments to the concrete Look the pipeline applies. Unknown slugs → 404. */
export async function resolveLook(ref: ItemSpec['look'], adjust?: ItemSpec['adjust'], cache?: Map<string, Look>): Promise<Look> {
  return mergeLook(await baseLook(ref, cache), adjust ?? undefined);
}

async function baseLook(ref: ItemSpec['look'], cache?: Map<string, Look>): Promise<Look> {
  if (ref && typeof ref === 'object') return LookSchema.parse(ref);
  if (typeof ref !== 'string' || NO_LOOK.has(ref)) return IDENTITY_LOOK;
  const cached = cache?.get(ref);
  if (cached) return cached;
  const { look } = await lookStore.require(ref);
  cache?.set(ref, look);
  return look;
}

/** Resolve the crop window (explicit rect wins, then focal, then gravity/auto) and the ratio it targets. */
export async function resolveItemCrop(file: string, spec: ItemSpec): Promise<{ crop: NormRect | null; ratio: number | null }> {
  const aspect = spec.aspect ?? 'original';
  const ratio = aspectToRatio(aspect);
  if (!ratio) return { crop: null, ratio: null };
  if (spec.crop) return { crop: spec.crop, ratio };
  const gravity = spec.gravity ?? getSettings().defaultGravity;
  return { crop: await resolveCrop(file, aspect, gravity, spec.focal ?? null), ratio };
}
