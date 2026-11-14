import { describe, expect, it } from 'vitest';
import { IDENTITY_LOOK, LookSchema, isIdentityLook } from '../src/spec.js';
import {
  applyClarityToRgb8,
  applyLookToRgb8,
  buildLinearToneLuts,
  buildToneLuts,
  buildVignetteMask,
  clarityParams,
  linearToSrgb,
  P3_TO_SRGB,
  saturationMultiplier,
  sharpenParams,
  srgbToLinear,
  toneEncoded,
  toneFromLinear,
  vignetteFactor,
  warmthGains,
} from '../src/look.js';

const look = (patch: Partial<typeof IDENTITY_LOOK>) => LookSchema.parse({ ...IDENTITY_LOOK, ...patch });

describe('sRGB transfer', () => {
  it('round-trips', () => {
    for (let i = 0; i <= 255; i++) {
      const v = i / 255;
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });
  it('pins black and white', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBe(1);
  });
});

describe('tone LUTs', () => {
  it('identity look produces identity tables', () => {
    const luts = buildToneLuts(IDENTITY_LOOK);
    expect(luts.identity).toBe(true);
    for (let i = 0; i < 256; i++) {
      expect(luts.r[i]).toBe(i);
      expect(luts.g[i]).toBe(i);
      expect(luts.b[i]).toBe(i);
    }
  });

  it('every slider keeps the curve monotonic and pinned at black', () => {
    const cases = [
      look({ exposure: 1.5 }),
      look({ exposure: -2 }),
      look({ contrast: 100 }),
      look({ contrast: -100 }),
      look({ highlights: -100 }),
      look({ highlights: 100 }),
      look({ shadows: 100 }),
      look({ shadows: -100 }),
      look({ warmth: 100 }),
      look({ warmth: -100 }),
      look({ exposure: 0.7, contrast: 40, highlights: -60, shadows: 50, warmth: 30 }),
    ];
    for (const l of cases) {
      const { r, g, b } = buildToneLuts(l);
      for (const lut of [r, g, b]) {
        // negative contrast flattens toward mid-grey and is allowed to lift black; everything else pins it
        if (l.contrast >= 0) expect(lut[0]).toBe(0);
        for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
      }
    }
  });

  it('+1 EV doubles linear light for mid-tones', () => {
    const l = look({ exposure: 1 });
    const mid = 0.18; // linear
    const out = toneFromLinear(mid, 1, l);
    expect(srgbToLinear(out)).toBeCloseTo(0.36, 3);
  });

  it('shadows lift dark values and leave white alone', () => {
    const l = look({ shadows: 100 });
    expect(toneEncoded(0.25, l)).toBeGreaterThan(0.25);
    expect(toneEncoded(1, l)).toBe(1);
    expect(toneEncoded(0, l)).toBe(0);
  });

  it('negative highlights pull bright values down and leave black alone', () => {
    const l = look({ highlights: -100 });
    expect(toneEncoded(0.75, l)).toBeLessThan(0.75);
    expect(toneEncoded(0, l)).toBe(0);
    expect(toneEncoded(1, l)).toBe(1);
  });

  it('positive contrast keeps mid-grey and spreads the ends', () => {
    const l = look({ contrast: 100 });
    expect(toneEncoded(0.5, l)).toBeCloseTo(0.5, 6);
    expect(toneEncoded(0.25, l)).toBeLessThan(0.25);
    expect(toneEncoded(0.75, l)).toBeGreaterThan(0.75);
  });

  it('negative contrast pulls toward mid-grey', () => {
    const l = look({ contrast: -100 });
    expect(toneEncoded(0.1, l)).toBeGreaterThan(0.1);
    expect(toneEncoded(0.9, l)).toBeLessThan(0.9);
    expect(toneEncoded(0.5, l)).toBeCloseTo(0.5, 6);
  });

  it('warmth raises red and lowers blue', () => {
    const [r, g, b] = warmthGains(100);
    expect(r).toBeGreaterThan(1);
    expect(g).toBe(1);
    expect(b).toBeLessThan(1);
    const luts = buildToneLuts(look({ warmth: 100 }));
    expect(luts.r[128]!).toBeGreaterThan(128);
    expect(luts.g[128]!).toBe(128);
    expect(luts.b[128]!).toBeLessThan(128);
  });
});

describe('applyLookToRgb8', () => {
  it('is a no-op for the identity look', () => {
    const data = new Uint8Array([10, 20, 30, 200, 100, 50]);
    applyLookToRgb8(data, IDENTITY_LOOK);
    expect([...data]).toEqual([10, 20, 30, 200, 100, 50]);
  });

  it('matches the LUT for the fast path', () => {
    const l = look({ exposure: 0.5, contrast: 20 });
    const luts = buildToneLuts(l);
    const data = new Uint8Array([10, 20, 30, 200, 100, 50]);
    applyLookToRgb8(data, l);
    expect([...data]).toEqual([luts.r[10], luts.g[20], luts.b[30], luts.r[200], luts.g[100], luts.b[50]]);
  });

  it('matrix path with identity matrix ≈ fast path', () => {
    const l = look({ exposure: 0.3, shadows: 30, highlights: -20 });
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const a = new Uint8Array(256 * 3);
    const b = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = i;
      b[i * 3] = b[i * 3 + 1] = b[i * 3 + 2] = i;
    }
    applyLookToRgb8(a, l);
    applyLookToRgb8(b, l, identity);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(1);
  });

  it('P3 → sRGB makes a P3 red more saturated (clips), keeps grey neutral', () => {
    const grey = new Uint8Array([128, 128, 128]);
    applyLookToRgb8(grey, IDENTITY_LOOK, P3_TO_SRGB);
    expect(Math.abs(grey[0]! - 128)).toBeLessThanOrEqual(1);
    expect(grey[0]).toBe(grey[1]);
    expect(grey[1]).toBe(grey[2]);
    const red = new Uint8Array([200, 60, 60]);
    applyLookToRgb8(red, IDENTITY_LOOK, P3_TO_SRGB);
    expect(red[0]!).toBeGreaterThan(200);
    expect(red[1]!).toBeLessThan(60);
  });

  it('linear LUT is monotonic', () => {
    const { r } = buildLinearToneLuts(look({ exposure: -1, contrast: 50 }));
    for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
  });
});

describe('new controls', () => {
  it('fade lifts black, leaves white', () => {
    const l = look({ fade: 100 });
    expect(toneEncoded(0, l)).toBeGreaterThan(0.1);
    expect(toneEncoded(1, l)).toBe(1);
    const luts = buildToneLuts(look({ fade: 50 }));
    expect(luts.r[0]!).toBeGreaterThan(10);
  });
  it('tint pushes green vs magenta', () => {
    const [rG, gG, bG] = warmthGains(0, 100);
    expect(gG).toBeLessThan(1);
    expect(rG).toBeGreaterThan(1);
    expect(bG).toBeGreaterThan(1);
    const [rM, gM] = warmthGains(0, -100);
    expect(gM).toBeGreaterThan(1);
    expect(rM).toBeLessThan(1);
  });
  it('vibrance saturates a muted colour more than a strong one, keeps grey grey', () => {
    const muted = new Uint8Array([140, 128, 120]);
    const strong = new Uint8Array([250, 30, 30]);
    const grey = new Uint8Array([100, 100, 100]);
    const l = look({ vibrance: 100 });
    const m0 = muted[0]! - muted[2]!;
    const s0 = strong[0]! - strong[1]!;
    applyLookToRgb8(muted, l);
    applyLookToRgb8(strong, l);
    applyLookToRgb8(grey, l);
    expect(muted[0]! - muted[2]!).toBeGreaterThan(m0);
    // relative gain on the strong colour is small
    expect((strong[0]! - strong[1]!) / s0).toBeLessThan((muted[0]! - muted[2]!) / m0);
    expect([...grey]).toEqual([100, 100, 100]);
  });
  it('split toning tints shadows and highlights toward their hues', () => {
    const l = look({ splitShadowHue: 200, splitShadowAmount: 100, splitHighlightHue: 30, splitHighlightAmount: 100 });
    const dark = new Uint8Array([40, 40, 40]);
    const bright = new Uint8Array([220, 220, 220]);
    applyLookToRgb8(dark, l);
    applyLookToRgb8(bright, l);
    expect(dark[2]!).toBeGreaterThan(dark[0]!); // shadows → blue-ish (hue 200)
    expect(bright[0]!).toBeGreaterThan(bright[2]!); // highlights → orange-ish (hue 30)
  });
  it('clarity params are resolution-independent (same small blur for any size) and signed', () => {
    expect(clarityParams(0, 1000, 1000)).toBeNull();
    const a = clarityParams(50, 8000, 6000)!;
    const b = clarityParams(50, 1600, 1200)!;
    expect(a.smallWidth).toBe(400);
    expect(a.smallHeight).toBe(300);
    expect(a.sigma).toBeCloseTo(b.sigma, 6);
    expect(a.sigma).toBeGreaterThanOrEqual(1);
    expect(a.amount).toBeGreaterThan(0);
    expect(clarityParams(-40, 1000, 800)!.amount).toBeLessThan(0);
    // sigma never exceeds what a small image can hold: even a huge value stays modest
    expect(clarityParams(100, 20000, 20000)!.sigma).toBeLessThan(10);
  });
  it('clarity adds detail around the midtones and softens toward the blur when negative', () => {
    const orig = new Uint8Array([100, 100, 100, 150, 150, 150]);
    const blur = new Uint8Array([120, 120, 120, 120, 120, 120]);
    const a = Uint8Array.from(orig);
    applyClarityToRgb8(a, blur, 1);
    expect(a[0]!).toBeLessThan(100); // darker than blur → pushed darker
    expect(a[3]!).toBeGreaterThan(150); // brighter than blur → pushed brighter
    const b = Uint8Array.from(orig);
    applyClarityToRgb8(b, blur, -0.5);
    expect(b[0]).toBe(110);
    expect(b[3]).toBe(135);
    const c = Uint8Array.from(orig);
    applyClarityToRgb8(c, blur, 0);
    expect(Array.from(c)).toEqual(Array.from(orig));
  });
  it('identity detection ignores the split hues', () => {
    expect(isIdentityLook(look({ splitShadowHue: 90 }))).toBe(true);
    expect(isIdentityLook(look({ fade: 1 }))).toBe(false);
  });
});

describe('helpers', () => {
  it('saturation multiplier', () => {
    expect(saturationMultiplier(0)).toBe(1);
    expect(saturationMultiplier(-100)).toBe(0);
    expect(saturationMultiplier(100)).toBe(2);
  });
  it('sharpen params', () => {
    expect(sharpenParams(0)).toBeNull();
    const p = sharpenParams(100)!;
    expect(p.sigma).toBeGreaterThan(sharpenParams(10)!.sigma);
  });
  it('vignette factor is 1 at centre and < 1 at corner', () => {
    expect(vignetteFactor(0, 100)).toBe(1);
    expect(vignetteFactor(1, 100)).toBeCloseTo(0.4, 6);
    expect(vignetteFactor(1, 0)).toBe(1);
    const mask = buildVignetteMask(50, 64);
    expect(mask[32 * 64 + 32]).toBe(255);
    expect(mask[0]!).toBeLessThan(255);
  });
});
