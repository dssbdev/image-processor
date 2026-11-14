import { describe, expect, it } from 'vitest';
import { ASPECT_RATIOS, GRAVITIES } from '../src/spec.js';
import { aspectToRatio, computeCropRect, fitInside, fromNormRect, toNormRect } from '../src/crop.js';
import { archiveSubdir, expandTemplate, ingestStem, sanitizeFileName, splitName, uniqueStem } from '../src/naming.js';
import { groupBySidecar, mediaKind } from '../src/pairing.js';
import { DEFAULT_EXPORTS, ExportPresetSchema, slugify } from '../src/spec.js';
import { DEFAULT_LOOK_PRESETS, LookPresetSchema } from '../src/looks.js';
import { migrateFolderEdits, isEmptyEdit } from '../src/edits.js';

describe('crop', () => {
  it('every ratio × gravity stays inside the image and has the right ratio', () => {
    const sizes = [
      [4096, 3072],
      [3072, 4096],
      [8192, 6144],
      [1000, 1000],
      [1919, 1081],
    ];
    for (const [w, h] of sizes) {
      for (const aspect of ASPECT_RATIOS) {
        const ratio = aspectToRatio(aspect);
        for (const g of GRAVITIES) {
          const r = computeCropRect(w!, h!, ratio, g);
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.top).toBeGreaterThanOrEqual(0);
          expect(r.left + r.width).toBeLessThanOrEqual(w!);
          expect(r.top + r.height).toBeLessThanOrEqual(h!);
          if (ratio) {
            expect(Math.abs(r.width / r.height - ratio)).toBeLessThan(0.01);
            // maximal: one dimension equals the source
            expect(r.width === w || r.height === h).toBe(true);
          } else {
            expect(r).toEqual({ left: 0, top: 0, width: w, height: h });
          }
        }
      }
    }
  });

  it('gravities land where they say', () => {
    const w = 4000;
    const h = 3000;
    const r = 4 / 5;
    expect(computeCropRect(w, h, r, 'west').left).toBe(0);
    expect(computeCropRect(w, h, r, 'east').left).toBe(w - 2400);
    expect(computeCropRect(w, h, r, 'center').left).toBe(800);
    const tall = computeCropRect(3000, 4000, 16 / 9, 'north');
    expect(tall.top).toBe(0);
    expect(computeCropRect(3000, 4000, 16 / 9, 'south').top).toBe(4000 - tall.height);
  });

  it('focal point centres the window and clamps at the edges', () => {
    const r = computeCropRect(4000, 3000, 4 / 5, 'center', { x: 0.5, y: 0.5 });
    expect(r.left).toBe(800);
    const edge = computeCropRect(4000, 3000, 4 / 5, 'center', { x: 0.02, y: 0.5 });
    expect(edge.left).toBe(0);
    const far = computeCropRect(4000, 3000, 4 / 5, 'center', { x: 0.99, y: 0.5 });
    expect(far.left).toBe(4000 - 2400);
  });

  it('normalized rects survive a round trip at another size', () => {
    const src = computeCropRect(4096, 3072, 0.8, 'center');
    const n = toNormRect(src, 4096, 3072);
    const small = fromNormRect(n, 1600, 1200);
    expect(Math.abs(small.width / small.height - 0.8)).toBeLessThan(0.01);
    expect(small.left + small.width).toBeLessThanOrEqual(1600);
    const back = fromNormRect(n, 4096, 3072);
    expect(back).toEqual(src);
  });

  it('fitInside never enlarges', () => {
    expect(fitInside(4096, 3072, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitInside(1000, 500, 2048)).toEqual({ width: 1000, height: 500 });
    expect(fitInside(1000, 500, 0)).toEqual({ width: 1000, height: 500 });
    expect(fitInside(3072, 4096, 2048)).toEqual({ width: 1536, height: 2048 });
  });
});

describe('naming', () => {
  const d = new Date(2026, 7, 17, 9, 5, 7); // local time, month is 0-based

  it('expands templates and sanitizes', () => {
    expect(expandTemplate('{date}-{time}_{stem}', { stem: 'IMG_0001', capturedAt: d, export: 'ig', seq: 3 })).toBe(
      '20260817-090507_IMG_0001',
    );
    expect(expandTemplate('{export}/{seq}', { stem: 'x', capturedAt: d, export: 'ig', seq: 3 })).toBe('ig_003');
    // {profile} is the old name of {export}; {look} is the look slug
    expect(expandTemplate('{profile}-{look}', { stem: 'x', capturedAt: d, export: 'ig', look: 'teal-orange', seq: 1 })).toBe('ig-teal-orange');
    expect(expandTemplate('{stem}{look}', { stem: 'x', capturedAt: d, export: 'ig', seq: 1 })).toBe('x');
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('trailing dots... ')).toBe('trailing dots');
    expect(sanitizeFileName('')).toBe('file');
  });

  it('splits names and builds archive paths', () => {
    expect(splitName('IMG_0001.DNG')).toEqual({ stem: 'IMG_0001', ext: '.dng' });
    expect(splitName('noext')).toEqual({ stem: 'noext', ext: '' });
    expect(archiveSubdir(d)).toEqual(['2026', '2026-08-17']);
    expect(ingestStem(d)).toBe('20260817-090507');
  });

  it('uniqueStem appends -2, -3', () => {
    const taken = new Set<string>();
    expect(uniqueStem('a', taken)).toBe('a');
    expect(uniqueStem('A', taken)).toBe('A-2');
    expect(uniqueStem('a', taken)).toBe('a-3');
  });
});

describe('pairing', () => {
  it('classifies extensions', () => {
    expect(mediaKind('x.JPG')).toBe('photo');
    expect(mediaKind('x.heic')).toBe('heic');
    expect(mediaKind('x.dng')).toBe('raw');
    expect(mediaKind('x.insv')).toBe('video');
    expect(mediaKind('x.txt')).toBe('other');
  });
  it('groups jpg + dng by stem, case-insensitively', () => {
    const files = [
      { dir: '/c/DCIM', name: 'IMG_0001.jpg' },
      { dir: '/c/DCIM', name: 'IMG_0001.DNG' },
      { dir: '/c/DCIM', name: 'IMG_0002.jpg' },
    ];
    const groups = groupBySidecar(files, (f) => f);
    expect(groups.length).toBe(2);
    expect(groups[0]!.members.length).toBe(2);
  });
});

describe('presets', () => {
  it('default export presets parse and fill defaults', () => {
    for (const p of DEFAULT_EXPORTS) {
      const parsed = ExportPresetSchema.parse(p);
      expect(parsed.naming.length).toBeGreaterThan(0);
      expect(parsed.quality).toBeGreaterThan(0);
    }
    expect(ExportPresetSchema.parse({ slug: 'x', name: 'x' }).longEdge).toBe(2048);
  });
  it('default looks parse', () => {
    for (const l of DEFAULT_LOOK_PRESETS) expect(LookPresetSchema.parse(l).look.exposure).toBeGreaterThanOrEqual(-3);
  });
  it('slugify', () => {
    expect(slugify('Instagram 4:5 — Beach!')).toBe('instagram-4-5-beach');
    expect(slugify('Ção')).toBe('cao');
    expect(slugify('')).toBe('item');
    expect(slugify('', 'look')).toBe('look');
  });
  it('rejects bad input', () => {
    expect(() => ExportPresetSchema.parse({ slug: 'Bad Slug', name: 'x' })).toThrow();
    expect(() => LookPresetSchema.parse({ slug: 'ok', name: 'x', look: { exposure: 9 } })).toThrow();
  });
});

describe('sidecar migration', () => {
  it('v1 profile-based edits become v2 look/adjust/aspect edits', () => {
    const v1 = {
      version: 1,
      edits: {
        'a.jpg': { profile: 'instagram-4x5', lookPreset: 'beach-midday', look: { exposure: 0.3, clarity: 10 }, focal: { x: 0.2, y: 0.4 }, star: true },
        'b.jpg': { profile: 'archive-jpeg' },
        'c.jpg': { look: { vignette: 20 } },
      },
    };
    const m = migrateFolderEdits(v1);
    expect(m.version).toBe(2);
    expect(m.edits['a.jpg']).toEqual({ look: 'beach-midday', adjust: { exposure: 0.3, clarity: 10 }, focal: { x: 0.2, y: 0.4 }, star: true });
    expect(m.edits['b.jpg']).toBeUndefined(); // profile only → nothing per-photo left
    expect(m.edits['c.jpg']).toEqual({ adjust: { vignette: 20 } });
    expect(isEmptyEdit({})).toBe(true);
    expect(isEmptyEdit({ aspect: '4:5' })).toBe(false);
  });
  it('v2 passes through and garbage is tolerated', () => {
    const v2 = { version: 2, edits: { 'x.jpg': { look: 'none', aspect: '4:3' } } };
    expect(migrateFolderEdits(v2).edits['x.jpg']!.aspect).toBe('4:3');
    expect(migrateFolderEdits(null).edits).toEqual({});
    expect(migrateFolderEdits({ version: 1, edits: { 'y.jpg': 'nope' } }).edits).toEqual({});
  });
});
