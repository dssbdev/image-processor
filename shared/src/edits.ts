import { z } from 'zod';
import { ASPECT_RATIOS, IDENTITY_LOOK, LOOK_CONTROLS, mergeLook, type Look } from './spec.js';
import type { LookPreset } from './looks.js';

/**
 * Per-photo state, stored as a sidecar JSON in the photo's folder (`.image-processor.json`), keyed by
 * file name so the folder can move. Two independent things live here:
 *   look — which look preset the photo uses (slug) + slider adjustments on top of it (`adjust`);
 *   crop — the aspect ratio (`aspect`) and where the window sits (`focal`, or an explicit `crop` rect).
 * Export settings are NOT per photo; they are chosen when you export.
 */
export const FocalSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const NormRectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/**
 * Partial look for adjustments: every control optional and *without* defaults (LookSchema.partial() would
 * still fill in zeros, which would turn "nudge exposure" into "reset everything else").
 */
export const LookOverridesSchema = z.object(
  Object.fromEntries(LOOK_CONTROLS.map((c) => [c.key, z.number().min(c.min).max(c.max).optional()])) as Record<
    keyof Look,
    z.ZodOptional<z.ZodNumber>
  >,
);

export const ImageEditSchema = z.object({
  /** Look preset slug. undefined = no preset (identity look, plus `adjust` if any). */
  look: z.string().optional(),
  /** Slider adjustments on top of the look preset. Only the keys present are overridden. */
  adjust: LookOverridesSchema.optional(),
  /** Crop ratio for this photo. undefined = no crop (original). */
  aspect: z.enum(ASPECT_RATIOS).optional(),
  /** Crop centre (0..1 of the oriented source). */
  focal: FocalSchema.optional(),
  /** Explicit crop window; wins over focal. */
  crop: NormRectSchema.optional(),
  star: z.boolean().optional(),
  /** Marks a photo as done in the current step-through session. */
  done: z.boolean().optional(),
  updatedAt: z.string().optional(),
});
export type ImageEdit = z.infer<typeof ImageEditSchema>;

/**
 * Patch shape for the API: any field may be `null` to remove it; inside `adjust`, a control set to `null`
 * removes just that override. Objects merge, they don't replace.
 */
export const LookOverridesPatchSchema = z.object(
  Object.fromEntries(LOOK_CONTROLS.map((c) => [c.key, z.number().min(c.min).max(c.max).nullable().optional()])) as Record<
    keyof Look,
    z.ZodOptional<z.ZodNullable<z.ZodNumber>>
  >,
);
export const ImageEditPatchSchema = z.object({
  look: z.string().nullable().optional(),
  adjust: LookOverridesPatchSchema.nullable().optional(),
  aspect: z.enum(ASPECT_RATIOS).nullable().optional(),
  focal: FocalSchema.nullable().optional(),
  crop: NormRectSchema.nullable().optional(),
  star: z.boolean().nullable().optional(),
  done: z.boolean().nullable().optional(),
});
export type ImageEditPatch = z.infer<typeof ImageEditPatchSchema>;

export const FOLDER_EDITS_VERSION = 2;

export const FolderEditsSchema = z.object({
  version: z.literal(FOLDER_EDITS_VERSION).default(FOLDER_EDITS_VERSION),
  edits: z.record(z.string(), ImageEditSchema).default({}),
});
export type FolderEdits = z.infer<typeof FolderEditsSchema>;

/**
 * v1 sidecars (profile-based) → v2. `lookPreset` becomes `look`, `look` (overrides) becomes `adjust`,
 * `profile` is dropped (export settings are no longer per photo). Anything unknown is ignored.
 */
export function migrateFolderEdits(raw: unknown): FolderEdits {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { version?: unknown; edits?: unknown };
  if (obj.version === FOLDER_EDITS_VERSION) return FolderEditsSchema.parse(obj);
  const edits: Record<string, ImageEdit> = {};
  const src = (obj.edits && typeof obj.edits === 'object' ? obj.edits : {}) as Record<string, Record<string, unknown>>;
  for (const [name, e] of Object.entries(src)) {
    if (!e || typeof e !== 'object') continue;
    const candidate: Record<string, unknown> = {
      look: typeof e.lookPreset === 'string' ? e.lookPreset : typeof e.look === 'string' ? e.look : undefined,
      adjust: e.adjust && typeof e.adjust === 'object' ? e.adjust : e.look && typeof e.look === 'object' ? e.look : undefined,
      aspect: e.aspect,
      focal: e.focal,
      crop: e.crop,
      star: e.star,
      done: e.done,
      updatedAt: e.updatedAt,
    };
    for (const k of Object.keys(candidate)) if (candidate[k] === undefined) delete candidate[k];
    const parsed = ImageEditSchema.safeParse(candidate);
    if (parsed.success && !isEmptyEdit(parsed.data)) edits[name] = parsed.data;
  }
  return { version: FOLDER_EDITS_VERSION, edits };
}

/** The look a photo actually renders with: preset (or identity) + adjustments. */
export function effectiveLook(edit: ImageEdit | null | undefined, preset: LookPreset | Look | null | undefined): Look {
  const base: Look = preset ? ('look' in preset && typeof (preset as LookPreset).look === 'object' ? (preset as LookPreset).look : (preset as Look)) : IDENTITY_LOOK;
  return mergeLook(base, edit?.adjust);
}

/** True when the edit carries nothing worth keeping (used to prune sidecars). */
export function isEmptyEdit(e: ImageEdit): boolean {
  return (
    !e.look &&
    !e.aspect &&
    !e.focal &&
    !e.crop &&
    !e.star &&
    !e.done &&
    (!e.adjust || Object.keys(e.adjust).length === 0)
  );
}
