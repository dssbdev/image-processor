import { z } from 'zod';

/**
 * The three independent axes of the app (v1.2):
 *   Look   — how the picture looks (sliders). Saved presets live in the Looks library; a photo stores the
 *            preset slug plus per-photo slider adjustments.
 *   Crop   — which part of the picture (aspect ratio + position). Never resizes, never touches quality.
 *   Export — how the file is written (size, format, quality, metadata, destination, naming). Chosen when
 *            you export, saved as presets.
 * A photo's persistent state (sidecar) is look + adjustments + crop; the export preset is chosen at export time.
 */

/** Aspect ratios offered in the UI. 'original' keeps the source ratio (no crop). */
export const ASPECT_RATIOS = ['original', '1:1', '4:5', '5:4', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const ASPECT_LABELS: Record<AspectRatio, string> = {
  original: 'Original (no crop)',
  '1:1': '1:1 · square',
  '4:5': '4:5 · portrait (Instagram)',
  '5:4': '5:4 · landscape',
  '4:3': '4:3 · landscape',
  '3:4': '3:4 · portrait',
  '3:2': '3:2 · landscape',
  '2:3': '2:3 · portrait',
  '16:9': '16:9 · wide',
  '9:16': '9:16 · story / reel',
};

/**
 * Where the crop window sits inside the source when the photo has no focal point of its own.
 * Geometric gravities are pure math; 'attention' and 'entropy' are sharp's smart-crop strategies,
 * resolved once per image on the server and then frozen into a rectangle so preview == batch.
 */
export const GRAVITIES = ['attention', 'entropy', 'center', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const;
export type Gravity = (typeof GRAVITIES)[number];

export const GRAVITY_LABELS: Record<Gravity, string> = {
  attention: 'Auto · subject (attention)',
  entropy: 'Auto · detail (entropy)',
  center: 'Centre',
  north: 'Top',
  south: 'Bottom',
  east: 'Right',
  west: 'Left',
  northeast: 'Top right',
  northwest: 'Top left',
  southeast: 'Bottom right',
  southwest: 'Bottom left',
};

export const OUTPUT_FORMATS = ['jpeg', 'webp', 'png'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const METADATA_POLICIES = ['strip', 'keep-no-gps', 'keep'] as const;
export type MetadataPolicy = (typeof METADATA_POLICIES)[number];
export const METADATA_LABELS: Record<MetadataPolicy, string> = {
  'keep-no-gps': 'Keep EXIF, remove GPS',
  keep: 'Keep everything (incl. GPS)',
  strip: 'Strip all metadata',
};

/**
 * Look sliders. All integers except exposure (EV, one decimal). 0 everywhere == identity.
 * Groups: tone (exposure, contrast, highlights, shadows, fade), colour (saturation, vibrance, warmth, tint,
 * split toning), effects (clarity, vignette, sharpen).
 */
export const LookSchema = z.object({
  /** Exposure compensation in EV, applied in linear light. */
  exposure: z.number().min(-3).max(3).default(0),
  /** -100..100. Positive = S-curve, negative = flatten toward mid-grey. */
  contrast: z.number().min(-100).max(100).default(0),
  /** -100..100. Negative pulls bright regions down (recover sky), positive brightens them. */
  highlights: z.number().min(-100).max(100).default(0),
  /** -100..100. Positive lifts dark regions (recover a backlit face). */
  shadows: z.number().min(-100).max(100).default(0),
  /** 0..100. Matte / faded blacks: lifts the black point (film look). */
  fade: z.number().min(0).max(100).default(0),
  /** -100..100. -100 = greyscale, +100 = double saturation (LCH). */
  saturation: z.number().min(-100).max(100).default(0),
  /** -100..100. Saturates muted colours more than already-saturated ones (skin stays sane). */
  vibrance: z.number().min(-100).max(100).default(0),
  /** -100..100. Positive = warmer (more red, less blue) in linear light. */
  warmth: z.number().min(-100).max(100).default(0),
  /** -100..100. Negative = green, positive = magenta. */
  tint: z.number().min(-100).max(100).default(0),
  /** Split toning: hue (0..360) and amount (0..100) added to shadows and to highlights. */
  splitShadowHue: z.number().min(0).max(360).default(200),
  splitShadowAmount: z.number().min(0).max(100).default(0),
  splitHighlightHue: z.number().min(0).max(360).default(40),
  splitHighlightAmount: z.number().min(0).max(100).default(0),
  /** -100..100. Local contrast (mid-frequency): positive = punchier detail, negative = softer, dreamy. */
  clarity: z.number().min(-100).max(100).default(0),
  /** 0..100. Darkened corners; 0 = none. */
  vignette: z.number().min(0).max(100).default(0),
  /** 0..100. Output sharpening at final size; 0 = none. */
  sharpen: z.number().min(0).max(100).default(0),
});
export type Look = z.infer<typeof LookSchema>;
export type LookKey = keyof Look;

/** UI metadata for every look control, in display order. */
export const LOOK_CONTROLS: { key: LookKey; label: string; group: 'tone' | 'colour' | 'effects'; min: number; max: number; step: number; unit?: string; help: string }[] = [
  { key: 'exposure', label: 'Exposure', group: 'tone', min: -3, max: 3, step: 0.1, unit: 'EV', help: 'Overall brightness. +0.3 to +0.7 for backlit beach shots.' },
  { key: 'contrast', label: 'Contrast', group: 'tone', min: -100, max: 100, step: 1, help: 'Positive = punchier S-curve, negative = flatter, softer.' },
  { key: 'highlights', label: 'Highlights', group: 'tone', min: -100, max: 100, step: 1, help: 'Negative pulls bright areas (sky, sand) down; positive brightens them.' },
  { key: 'shadows', label: 'Shadows', group: 'tone', min: -100, max: 100, step: 1, help: 'Positive lifts dark areas (a face against the sky); negative deepens them.' },
  { key: 'fade', label: 'Fade', group: 'tone', min: 0, max: 100, step: 1, help: 'Matte blacks — the film / vintage look. Lifts the darkest tones.' },
  { key: 'saturation', label: 'Saturation', group: 'colour', min: -100, max: 100, step: 1, help: 'Colour intensity for everything. -100 = black and white.' },
  { key: 'vibrance', label: 'Vibrance', group: 'colour', min: -100, max: 100, step: 1, help: 'Boosts muted colours more than strong ones; gentler on skin than saturation.' },
  { key: 'warmth', label: 'Warmth', group: 'colour', min: -100, max: 100, step: 1, help: 'Positive = warmer (more red, less blue); negative = cooler.' },
  { key: 'tint', label: 'Tint', group: 'colour', min: -100, max: 100, step: 1, help: 'Negative = greener, positive = more magenta.' },
  { key: 'splitShadowHue', label: 'Shadow tone hue', group: 'colour', min: 0, max: 360, step: 1, unit: '°', help: 'Colour pushed into the shadows (teal ≈ 190, warm ≈ 30).' },
  { key: 'splitShadowAmount', label: 'Shadow tone amount', group: 'colour', min: 0, max: 100, step: 1, help: 'How much of that colour goes into the shadows.' },
  { key: 'splitHighlightHue', label: 'Highlight tone hue', group: 'colour', min: 0, max: 360, step: 1, unit: '°', help: 'Colour pushed into the highlights (orange ≈ 35).' },
  { key: 'splitHighlightAmount', label: 'Highlight tone amount', group: 'colour', min: 0, max: 100, step: 1, help: 'How much of that colour goes into the highlights.' },
  { key: 'clarity', label: 'Clarity', group: 'effects', min: -100, max: 100, step: 1, help: 'Local contrast: positive = crisper texture, negative = soft glow.' },
  { key: 'vignette', label: 'Vignette', group: 'effects', min: 0, max: 100, step: 1, help: 'Darkens the corners to pull the eye to the centre.' },
  { key: 'sharpen', label: 'Sharpen', group: 'effects', min: 0, max: 100, step: 1, help: 'Output sharpening at the final size. 20–40 is plenty for Instagram.' },
];

/** Overlay partial overrides on a base look (per-photo adjustments on top of a look preset). */
export function mergeLook(base: Look, overrides?: Partial<Look> | null): Look {
  if (!overrides) return base;
  const out: Look = { ...base };
  for (const k of Object.keys(overrides) as LookKey[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, number>)[k] = v;
  }
  return out;
}

export const IDENTITY_LOOK: Look = LookSchema.parse({});

export function isIdentityLook(look: Look): boolean {
  return LOOK_CONTROLS.every((c) => {
    if (c.key === 'splitShadowHue' || c.key === 'splitHighlightHue') return true; // hues alone do nothing
    return look[c.key] === 0;
  });
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string, fallback = 'item'): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || fallback;
}

/* ------------------------------------------------------------------------------------------------ */
/* Export                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** How files are written. Saved as presets in <config>/exports/, chosen at export time. */
export const ExportSettingsSchema = z.object({
  /** Long edge in pixels after crop. 0 = keep the source size (never enlarge in any case). */
  longEdge: z.number().int().min(0).max(16384).default(2048),
  format: z.enum(OUTPUT_FORMATS).default('jpeg'),
  quality: z.number().int().min(1).max(100).default(90),
  metadata: z.enum(METADATA_POLICIES).default('keep-no-gps'),
  /** Absolute folder. Empty = <exportRoot>/<preset slug>. */
  destination: z.string().default(''),
  /**
   * File name template without extension. Tokens: {stem} {date} {time} {export} {look} {seq}.
   * {date} = YYYYMMDD and {time} = HHMMSS from the capture time (file mtime if none).
   */
  naming: z.string().min(1).default('{date}-{time}_{stem}'),
});

export const ExportPresetSchema = ExportSettingsSchema.extend({
  slug: z.string().regex(SLUG_RE, 'lowercase letters, digits and dashes only'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;
export type ExportPresetInput = z.input<typeof ExportPresetSchema>;

/** Export presets seeded on first run. Meant to be edited. */
export const DEFAULT_EXPORTS: ExportPresetInput[] = [
  {
    slug: 'instagram',
    name: 'Instagram',
    description: '2048 px long edge (Instagram re-encodes anyway), JPEG q90, EXIF kept but GPS removed.',
    longEdge: 2048,
    format: 'jpeg',
    quality: 90,
    metadata: 'keep-no-gps',
    naming: '{date}-{time}_{stem}',
  },
  {
    slug: 'full-quality',
    name: 'Full quality',
    description: 'Original pixel size, JPEG q95 4:4:4, all metadata kept. Cropping only removes pixels, it never resizes.',
    longEdge: 0,
    format: 'jpeg',
    quality: 95,
    metadata: 'keep',
    naming: '{stem}',
  },
  {
    slug: 'web',
    name: 'Web / chat',
    description: '1600 px WebP q85 for messaging, blogs and previews. GPS removed.',
    longEdge: 1600,
    format: 'webp',
    quality: 85,
    metadata: 'keep-no-gps',
    naming: '{date}-{time}_{stem}',
  },
];
