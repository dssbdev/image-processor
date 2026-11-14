import type { RenderItem } from '../../../shared/src/api.js';
import type { ImageEdit } from '../../../shared/src/edits.js';
import { aspectToRatio } from '../../../shared/src/crop.js';
import { ASPECT_LABELS, ASPECT_RATIOS, GRAVITIES, GRAVITY_LABELS, LOOK_CONTROLS, type AspectRatio, type Gravity, type Look, type LookKey } from '../../../shared/src/spec.js';
import type { PreviewSpec } from '../components/PreviewPane.js';
import type { SelectOption } from '../components/ui.js';

/** What a photo's sidecar state means for the pipeline (preview and export use the very same fields). */
export function specForEdit(edit: ImageEdit | undefined | null, gravity?: Gravity): PreviewSpec {
  return {
    look: edit?.look ?? '',
    adjust: edit?.adjust ?? null,
    aspect: edit?.aspect ?? 'original',
    gravity: gravity ?? null,
    focal: edit?.focal ?? null,
    crop: edit?.crop ?? null,
  };
}

export function renderItemFor(path: string, edit: ImageEdit | undefined | null, gravity?: Gravity): RenderItem {
  const item: RenderItem = { path };
  if (edit?.look) item.look = edit.look;
  if (edit?.adjust && Object.keys(edit.adjust).length) item.adjust = edit.adjust as Record<string, number>;
  if (edit?.aspect && edit.aspect !== 'original') item.aspect = edit.aspect;
  if (gravity) item.gravity = gravity;
  if (edit?.focal) item.focal = edit.focal;
  if (edit?.crop) item.crop = edit.crop;
  return item;
}

const ASPECT_ORDER: { a: AspectRatio; group?: string }[] = [
  { a: 'original' },
  { a: '4:5', group: 'Instagram' },
  { a: '1:1', group: 'Instagram' },
  { a: '9:16', group: 'Instagram' },
  { a: '4:3', group: 'Other ratios' },
  { a: '3:4', group: 'Other ratios' },
  { a: '3:2', group: 'Other ratios' },
  { a: '2:3', group: 'Other ratios' },
  { a: '5:4', group: 'Other ratios' },
  { a: '16:9', group: 'Other ratios' },
];
export const ASPECT_OPTIONS: SelectOption<AspectRatio>[] = ASPECT_ORDER.filter((x) => (ASPECT_RATIOS as readonly string[]).includes(x.a)).map((x) => ({
  value: x.a,
  label: ASPECT_LABELS[x.a],
  group: x.group,
}));

export const GRAVITY_OPTIONS: SelectOption<Gravity>[] = GRAVITIES.map((g) => ({
  value: g,
  label: GRAVITY_LABELS[g],
  group: g === 'attention' || g === 'entropy' ? 'Automatic' : 'Fixed',
}));

/** Where an automatic crop window goes, in words: "on the subject", "against the top right". */
export function autoPlacement(gravity: Gravity): string {
  if (gravity === 'attention') return 'on the subject';
  if (gravity === 'entropy') return 'on the most detailed area';
  return `against the ${GRAVITY_LABELS[gravity].toLowerCase()}`;
}

/** How an import checks its copies, in words (size is always compared). */
export const VERIFY_WORDS = { photos: 'photos and RAW by content hash, videos by size', all: 'everything by content hash', none: 'by size only' } as const;

/** Short label for a chip: "4:5" / "1:1" / "" for original. */
export function aspectShort(a?: AspectRatio | null): string {
  return !a || a === 'original' ? '' : a;
}

/** What a crop ratio keeps of a W × H photo: the window size and the share of the pixels (cropping never resizes). */
export function cropKeep(width: number, height: number, aspect?: AspectRatio | null): { w: number; h: number; pct: number } | null {
  const ratio = aspect ? aspectToRatio(aspect) : null;
  if (!ratio || width <= 0 || height <= 0) return null;
  const w = width / height > ratio ? Math.round(height * ratio) : width;
  const h = width / height > ratio ? height : Math.round(width / ratio);
  return { w, h, pct: Math.round(((w * h) / (width * height)) * 100) };
}

/** One control as the sentences print it: "Exposure +0.3 EV", "Fade 20", "Shadow tone hue 190°". */
export function controlText(key: LookKey, v: number): string {
  const c = LOOK_CONTROLS.find((x) => x.key === key);
  if (!c) return `${key} ${v}`;
  const num = c.step < 1 ? v.toFixed(1) : String(Math.round(v));
  const signed = c.min < 0 && v > 0 ? `+${num}` : num;
  return `${c.label} ${signed}${c.unit === '°' ? '°' : c.unit ? ` ${c.unit}` : ''}`;
}

/** The controls where `values` differs from `base`, in control order. */
export function changedControls(values: Look, base: Look): LookKey[] {
  return LOOK_CONTROLS.filter((c) => values[c.key] !== base[c.key]).map((c) => c.key);
}

/** A look in plain words ("warmer, more contrast, faded blacks"), from its slider values. Hues alone say nothing. */
export function lookWords(look: Partial<Look>): string[] {
  const v = (k: LookKey) => look[k] ?? 0;
  const out: string[] = [];
  if (v('exposure') >= 0.2) out.push('brighter');
  else if (v('exposure') <= -0.2) out.push('darker');
  if (v('contrast') >= 10) out.push('more contrast');
  else if (v('contrast') <= -10) out.push('softer contrast');
  if (v('saturation') <= -90) out.push('black and white');
  else if (v('saturation') + v('vibrance') / 2 >= 10) out.push('richer colour');
  else if (v('saturation') + v('vibrance') / 2 <= -10) out.push('muted colour');
  if (v('warmth') >= 8) out.push('warmer');
  else if (v('warmth') <= -8) out.push('cooler');
  if (v('fade') >= 10) out.push('faded blacks');
  if (v('splitShadowAmount') >= 10 || v('splitHighlightAmount') >= 10) out.push('split-toned');
  if (v('clarity') >= 10) out.push('crisper');
  else if (v('clarity') <= -10) out.push('soft glow');
  if (v('vignette') >= 10) out.push('vignette');
  return out;
}
