import { z } from 'zod';
import { LookSchema, SLUG_RE, type Look } from './spec.js';

/**
 * The Looks library: named slider sets that change how a picture looks and nothing else (no crop, no size,
 * no format). A photo stores the slug of the look it uses plus its own slider adjustments. Seeded with
 * scenario looks (what to shoot where) and style looks (the popular grades), all expressed with our own
 * sliders — approximations of the styles, not copies of anyone's preset files. There is also 'none'.
 */
export const LookPresetSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(80),
  group: z.enum(['scenario', 'style', 'custom']).default('custom'),
  description: z.string().max(400).default(''),
  look: LookSchema.prefault({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type LookPreset = z.infer<typeof LookPresetSchema>;
export type LookPresetInput = z.input<typeof LookPresetSchema>;

const P = (slug: string, name: string, group: 'scenario' | 'style', description: string, look: Partial<Look>): LookPresetInput => ({
  slug,
  name,
  group,
  description,
  look,
});

export const DEFAULT_LOOK_PRESETS: LookPresetInput[] = [
  // ---- scenarios: where you are, what the light does, what needs fixing ----
  P('beach-midday', 'Beach · midday', 'scenario', 'Bright sand and sky fool the meter and the face goes dark. Protect highlights, lift the face, a little warmth and life.', {
    exposure: 0.2, contrast: 8, highlights: -30, shadows: 22, vibrance: 15, saturation: 4, warmth: 6, clarity: 8, sharpen: 30,
  }),
  P('beach-golden-hour', 'Beach · golden hour', 'scenario', 'Warm low sun: keep the glow, do not blow the highlights, warm the shadows a touch.', {
    exposure: 0.1, contrast: 6, highlights: -18, shadows: 12, vibrance: 12, saturation: 6, warmth: 22, splitShadowHue: 30, splitShadowAmount: 12, splitHighlightHue: 40, splitHighlightAmount: 20, vignette: 10, sharpen: 28,
  }),
  P('ocean-water', 'Ocean · in the water', 'scenario', 'Bright sky over dark water: pull highlights, add texture to water, keep blues honest.', {
    contrast: 10, highlights: -26, shadows: 10, vibrance: 15, saturation: 10, warmth: -4, clarity: 18, sharpen: 32,
  }),
  P('nature-day', 'Nature · daylight', 'scenario', 'Greens and skies: local contrast for texture, vibrance not saturation, protect the sky.', {
    contrast: 12, highlights: -20, shadows: 10, vibrance: 25, saturation: 4, clarity: 20, sharpen: 34,
  }),
  P('nature-overcast', 'Nature · overcast', 'scenario', 'Flat grey light: brighten, add contrast and warmth back, wake the colours up.', {
    exposure: 0.3, contrast: 12, highlights: -6, shadows: 8, vibrance: 22, warmth: 10, clarity: 12, sharpen: 32,
  }),
  P('urban-day', 'Urban · daytime', 'scenario', 'Streets and buildings: crisp, slightly desaturated, cooler, a hint of matte.', {
    contrast: 18, highlights: -12, shadows: 6, fade: 8, saturation: -10, vibrance: 10, warmth: -5, clarity: 30, vignette: 14, sharpen: 36,
  }),
  P('night-city', 'Night · city', 'scenario', 'Neon and street lights: tame the highlights, lift the shadows, cool shadows / amber lights, contrast for depth.', {
    exposure: 0.1, contrast: 15, highlights: -40, shadows: 15, vibrance: 15, saturation: 8, warmth: -8, splitShadowHue: 220, splitShadowAmount: 20, splitHighlightHue: 40, splitHighlightAmount: 15, clarity: 15, vignette: 20, sharpen: 24,
  }),
  P('night-nature', 'Night · nature / stars', 'scenario', 'Moon, stars, campfire: brighten and open the shadows, cool cast, texture in the sky, keep noise from being sharpened.', {
    exposure: 0.35, contrast: 12, highlights: -20, shadows: 26, vibrance: 8, saturation: 4, warmth: -14, clarity: 22, vignette: 16, sharpen: 18,
  }),
  P('cycling-pov', 'Cycling · POV', 'scenario', 'Road and trail from a mounted action camera: punchy, textured, sharp, small vignette to centre the eye.', {
    contrast: 12, highlights: -14, shadows: 8, vibrance: 15, saturation: 4, clarity: 20, vignette: 8, sharpen: 40,
  }),
  P('portrait-soft', 'Portrait · soft', 'scenario', 'Posed shots of people: gentle contrast, lifted shadows, warm, no clarity on skin, light sharpening.', {
    exposure: 0.15, contrast: 4, highlights: -12, shadows: 14, vibrance: 8, warmth: 8, clarity: -8, vignette: 10, sharpen: 22,
  }),

  // ---- styles: the grades everyone recognises ----
  P('clean-neutral', 'Clean & neutral', 'style', 'True to life with editorial polish: crisp whites, controlled colour, a touch brighter.', {
    exposure: 0.15, contrast: 6, highlights: -10, shadows: 8, vibrance: 8, sharpen: 25,
  }),
  P('bright-airy', 'Bright & airy', 'style', 'Light, lifted shadows, low contrast, soft glow, slightly warm — the lifestyle / wedding look.', {
    exposure: 0.5, contrast: -15, highlights: -10, shadows: 30, fade: 8, saturation: -5, vibrance: 8, warmth: 6, clarity: -10, sharpen: 20,
  }),
  P('teal-orange', 'Teal & orange', 'style', 'The blockbuster grade: teal shadows, orange highlights, contrast, restrained saturation.', {
    contrast: 12, highlights: -8, shadows: 6, saturation: -5, vibrance: 15, splitShadowHue: 190, splitShadowAmount: 35, splitHighlightHue: 30, splitHighlightAmount: 30, fade: 5, sharpen: 28,
  }),
  P('matte-film', 'Matte film', 'style', 'Faded blacks, soft contrast, muted colour, a whisper of green in the shadows — the film emulation feel.', {
    contrast: -10, highlights: -10, shadows: 10, fade: 35, saturation: -12, warmth: 5, splitShadowHue: 120, splitShadowAmount: 10, vignette: 12, sharpen: 20,
  }),
  P('moody-dark', 'Moody & dark', 'style', 'Darker, contrast for depth, soft (not crushed) blacks, warm shadows, muted greens and blues.', {
    exposure: -0.3, contrast: 18, highlights: -25, shadows: -5, fade: 12, saturation: -20, vibrance: 5, warmth: 8, splitShadowHue: 25, splitShadowAmount: 15, vignette: 25, sharpen: 24,
  }),
  P('golden-hour', 'Golden hour', 'style', 'Warm sunlight without blown highlights: soft halos, glow on backlit scenes.', {
    contrast: 4, highlights: -18, shadows: 10, vibrance: 10, saturation: 6, warmth: 25, splitShadowHue: 30, splitShadowAmount: 12, splitHighlightHue: 42, splitHighlightAmount: 24, clarity: -4, vignette: 10, sharpen: 24,
  }),
  P('vintage-retro', 'Vintage / retro', 'style', 'Classic warmth, gentle fading, magenta tint, heavier vignette — the disposable-camera feel.', {
    contrast: -5, highlights: -10, shadows: 6, fade: 25, saturation: -8, vibrance: 5, warmth: 18, tint: 8, vignette: 30, sharpen: 18,
  }),
  P('vivid-travel', 'Vivid travel', 'style', 'Rich, punchy colour and crisp detail — the scroll-stopping travel feed.', {
    contrast: 12, highlights: -15, shadows: 8, saturation: 18, vibrance: 20, clarity: 15, sharpen: 35,
  }),
  P('clean-bw', 'Clean black & white', 'style', 'Luminance-preserving monochrome with contrast and texture.', {
    contrast: 20, highlights: -10, shadows: 10, saturation: -100, clarity: 20, sharpen: 30,
  }),
  P('bw-matte', 'Black & white · matte', 'style', 'Soft, faded monochrome for quiet frames.', {
    contrast: 5, highlights: -8, shadows: 14, fade: 30, saturation: -100, clarity: 6, vignette: 18, sharpen: 22,
  }),
];
