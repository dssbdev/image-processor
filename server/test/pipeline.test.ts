import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// The server reads IMAGE_PROCESSOR_DATA at import time, so set it before importing anything from it.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ip-data-'));
process.env.IMAGE_PROCESSOR_DATA = dataDir;

const { loadSettings, getSettings } = await import('../src/config.js');
const { openSource } = await import('../src/decoders/index.js');
const { renderImage } = await import('../src/pipeline/render.js');
const { resolveCrop } = await import('../src/pipeline/crop.js');
const { ensureDerivatives } = await import('../src/cache/derivatives.js');
const { copyMetadata, exiftool, shutdownExiftool, readSourceMeta, wallClock } = await import('../src/meta/exif.js');
const { planImport } = await import('../src/ingest/plan.js');
const { startImportJob } = await import('../src/ingest/run.js');
const { startRenderJob } = await import('../src/jobs/render.js');
const { jobs } = await import('../src/jobs/queue.js');
const { shutdownHeic } = await import('../src/decoders/heic.js');
const { ExportPresetSchema, LookSchema, IDENTITY_LOOK } = await import('../../shared/src/spec.js');
const { aspectToRatio } = await import('../../shared/src/crop.js');
const { exportStore } = await import('../src/store/exports.js');
const { resolveLook } = await import('../src/pipeline/spec.js');
const { detectRawEngine, developRawToBuffer, shutdownLibRaw } = await import('../src/decoders/raw.js');
const { saveSettings } = await import('../src/config.js');
const { ExifDateTime } = await import('exiftool-vendored');
const { lookStore } = await import('../src/store/looks.js');
const { readFolderEdits, patchFolderEdits, transferEdits } = await import('../src/store/edits.js');
const { writeLinearDng, writeBayerDng } = await import('./helpers/dng.js');

const work = await mkdtemp(path.join(os.tmpdir(), 'ip-work-'));
const HEIC_SAMPLE = process.env.HEIC_SAMPLE ?? '/tmp/sample1.heic';

async function makeScene(file: string, w = 1200, h = 800, orientation?: number): Promise<void> {
  // grey field, bright sky band on top, red square (the "subject") off-centre bottom-right
  const sky = await sharp({ create: { width: w, height: Math.round(h * 0.35), channels: 3, background: '#dfe9f3' } }).png().toBuffer();
  const subject = await sharp({ create: { width: 160, height: 160, channels: 3, background: '#e03020' } }).png().toBuffer();
  let img = sharp({ create: { width: w, height: h, channels: 3, background: '#7a8a70' } }).composite([
    { input: sky, left: 0, top: 0 },
    { input: subject, left: Math.round(w * 0.72), top: Math.round(h * 0.6) },
  ]);
  img = img.jpeg({ quality: 92 });
  if (orientation) img = img.withMetadata({ orientation });
  await img.toFile(file);
}

const look = (patch: Partial<typeof IDENTITY_LOOK> = {}) => LookSchema.parse({ ...IDENTITY_LOOK, ...patch });
/** Build a RenderSpec quickly: identity look, no crop, given export bits. */
const spec = (over: Partial<Parameters<typeof renderImage>[1]> = {}) => ({ look: IDENTITY_LOOK, longEdge: 0, format: 'jpeg' as const, quality: 90, ...over });

async function waitJob(id: string, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    const j = jobs.get(id)!;
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') return j;
    if (Date.now() - start > timeoutMs) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await loadSettings();
});

afterAll(async () => {
  await Promise.allSettled([shutdownExiftool(), shutdownHeic(), shutdownLibRaw()]);
});

describe('exif helpers', () => {
  it('wallClock keeps camera wall time', () => {
    const edt = ExifDateTime.fromEXIF('2026:08:17 10:05:07+02:00')!;
    const d = wallClock(edt)!;
    expect(d.getHours()).toBe(10);
    expect(d.getDate()).toBe(17);
    expect(wallClock('2026:08:17 10:05:07')!.getMinutes()).toBe(5);
    expect(wallClock('garbage')).toBeNull();
  });
});

describe('render pipeline', () => {
  const jpg = path.join(work, 'scene.jpg');
  const rotated = path.join(work, 'rotated.jpg');

  beforeAll(async () => {
    await makeScene(jpg);
    await makeScene(rotated, 1200, 800, 6);
    await exiftool.write(
      jpg,
      {
        DateTimeOriginal: '2026:08:17 10:05:07',
        Make: 'TestCam',
        Model: 'Model One',
        GPSLatitude: 51.4779,
        GPSLatitudeRef: 'N',
        GPSLongitude: 0.0015,
        GPSLongitudeRef: 'W',
      },
      { writeArgs: ['-overwrite_original'] },
    );
  });

  it('reads capture time and GPS presence', async () => {
    const m = await readSourceMeta(jpg);
    expect(m.dateSource).toBe('exif');
    expect(m.capturedAt.getFullYear()).toBe(2026);
    expect(m.capturedAt.getHours()).toBe(10);
    expect(m.hasGps).toBe(true);
    expect(m.model).toBe('Model One');
  });

  it('opens with orientation applied', async () => {
    const a = await openSource(jpg);
    expect([a.width, a.height]).toEqual([1200, 800]);
    const b = await openSource(rotated);
    expect([b.width, b.height]).toEqual([800, 1200]);
  });

  it('identity look at full size reproduces the source', async () => {
    const src = await openSource(jpg);
    const r = await renderImage(src, spec({ format: 'png' }));
    expect([r.width, r.height]).toEqual([1200, 800]);
    const before = await sharp(jpg).raw().toBuffer();
    const after = await sharp(r.data).raw().toBuffer();
    let maxDiff = 0;
    for (let i = 0; i < before.length; i += 97) maxDiff = Math.max(maxDiff, Math.abs(before[i]! - after[i]!));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it('crop + resize + look produce the requested geometry and brighter shadows', async () => {
    const src = await openSource(jpg);
    const l = look({ exposure: 0.5, shadows: 40, vignette: 30, sharpen: 40, saturation: 20, warmth: 20 });
    const crop = await resolveCrop(jpg, '4:5', 'center');
    expect(crop).not.toBeNull();
    const p = spec({ look: l, crop, ratio: aspectToRatio('4:5'), longEdge: 500 });
    const r = await renderImage(src, p);
    expect(r.height).toBe(500);
    expect(Math.abs(r.width / r.height - 0.8)).toBeLessThan(0.01);
    const stats = await sharp(r.data).stats();
    // grey field (#7a8a70 ≈ 122,138,112) got exposure +0.5 and warmth: red channel mean should be higher than green-ish base
    expect(stats.channels[0]!.mean).toBeGreaterThan(122);
    // vignette: the corner is darker than the same corner rendered without vignette; the centre is unchanged
    const noVig = await renderImage(src, { ...p, look: { ...l, vignette: 0 } });
    const a = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(noVig.data).raw().toBuffer({ resolveWithObject: true });
    const px = (buf: Buffer, w: number, x: number, y: number) => buf[(y * w + x) * 3 + 1]!; // green channel
    expect(px(a.data, a.info.width, 2, 2)).toBeLessThan(px(b.data, b.info.width, 2, 2) - 10);
    const cx = Math.floor(a.info.width / 2);
    const cy = Math.floor(a.info.height / 2);
    expect(Math.abs(px(a.data, a.info.width, cx, cy) - px(b.data, b.info.width, cx, cy))).toBeLessThanOrEqual(2);
  });

  it('attention crop finds the red subject and is stable across sizes', async () => {
    const crop = (await resolveCrop(jpg, '1:1', 'attention'))!;
    // subject sits at x ≈ 0.72..0.85; the 1:1 window (w = 800/1200 = 0.667) must include it
    expect(crop.x + crop.w).toBeGreaterThan(0.86);
    const src = await openSource(jpg);
    const p = spec({ crop, ratio: 1, longEdge: 400 });
    const small = await renderImage(src, p, { maxEdge: 200 });
    const big = await renderImage(src, p);
    expect(small.width).toBe(200);
    expect(big.width).toBe(400);
    // same crop → both should contain red pixels
    for (const r of [small, big]) {
      const s = await sharp(r.data).stats();
      expect(s.channels[0]!.max).toBeGreaterThan(200);
    }
  });

  it('metadata policy: keep-no-gps keeps date, drops GPS, resets orientation', async () => {
    const src = await openSource(rotated);
    await exiftool.write(
      rotated,
      { DateTimeOriginal: '2026:08:17 11:00:00', GPSLatitude: 51.4779, GPSLatitudeRef: 'N', GPSLongitude: 0.0015, GPSLongitudeRef: 'W' },
      { writeArgs: ['-overwrite_original'] },
    );
    const r = await renderImage(src, spec({ longEdge: 300 }));
    const out = path.join(work, 'out-nogps.jpg');
    await writeFile(out, r.data);
    await copyMetadata(rotated, out, 'keep-no-gps');
    const tags = await exiftool.read(out);
    expect(String(tags.DateTimeOriginal)).toContain('2026');
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.GPSPosition).toBeUndefined();
    expect(tags.Orientation === undefined || tags.Orientation === 1).toBe(true);
    const md = await sharp(out).metadata();
    expect([md.width, md.height]).toEqual([200, 300]);
    // 'keep' keeps GPS
    const out2 = path.join(work, 'out-keep.jpg');
    await writeFile(out2, r.data);
    await copyMetadata(rotated, out2, 'keep');
    const tags2 = await exiftool.read(out2);
    expect(tags2.GPSLatitude).toBeDefined();
  });

  it('derivatives are cached and reused', async () => {
    const d1 = await ensureDerivatives(jpg);
    expect(existsSync(d1.thumb)).toBe(true);
    expect(existsSync(d1.proxy)).toBe(true);
    const t = await sharp(d1.thumb).metadata();
    expect(Math.max(t.width!, t.height!)).toBe(getSettings().thumbSize);
    const d2 = await ensureDerivatives(jpg);
    expect(d2.thumb).toBe(d1.thumb);
  });

  it.skipIf(!existsSync(HEIC_SAMPLE))('decodes HEIC through the worker pool', async () => {
    const heic = path.join(work, 'sample.heic');
    await copyFile(HEIC_SAMPLE, heic);
    const src = await openSource(heic);
    expect(src.kind).toBe('heic');
    expect(src.width).toBeGreaterThan(0);
    const r = await renderImage(src, spec({ longEdge: 400 }));
    expect(Math.max(r.width, r.height)).toBe(400);
    const d = await ensureDerivatives(heic);
    expect(existsSync(d.thumb)).toBe(true);
  });

  it('export job writes files with unique names, crops per item and copies metadata', async () => {
    const p = ExportPresetSchema.parse({ slug: 'job', name: 'job', longEdge: 256, naming: '{date}_{stem}', metadata: 'keep-no-gps' });
    const job1 = await startRenderJob([{ path: jpg, aspect: '1:1', gravity: 'center' }, { path: rotated }], p);
    const done1 = await waitJob(job1.id);
    expect(done1.status).toBe('done');
    expect(done1.done).toBe(2);
    const dst = done1.items[0]!.dst!;
    expect(path.basename(dst)).toBe('20260817_scene.jpg');
    expect(done1.meta.dest).toBe(path.join(getSettings().exportRoot, 'job'));
    // second run must not overwrite; destination override is honoured
    const altDest = path.join(work, 'alt-dest');
    const job2 = await startRenderJob([{ path: jpg }], p, altDest);
    const done2 = await waitJob(job2.id);
    expect(path.dirname(done2.items[0]!.dst!)).toBe(altDest);
    const job2b = await startRenderJob([{ path: jpg }], p);
    const done2b = await waitJob(job2b.id);
    expect(path.basename(done2b.items[0]!.dst!)).toBe('20260817_scene-2.jpg');
    const md = await sharp(dst).metadata();
    expect([md.width, md.height]).toEqual([256, 256]);
    // the uncropped rotated one keeps its 2:3 ratio at 256 long edge
    const md2 = await sharp(done1.items[1]!.dst!).metadata();
    expect([md2.width, md2.height]).toEqual([171, 256]);
    // a broken DNG and a missing file both fail (with messages), an unsupported extension is skipped
    const fake = path.join(work, 'x.dng');
    await writeFile(fake, 'not a dng');
    const txt = path.join(work, 'notes.txt');
    await writeFile(txt, 'hi');
    const job3 = await startRenderJob([{ path: fake }, { path: path.join(work, 'missing.jpg') }, { path: txt }], p);
    const done3 = await waitJob(job3.id);
    expect(done3.failed).toBe(2);
    expect(done3.skipped).toBe(1);
    expect(done3.items[0]!.error).toBeTruthy();
  });

  it('per-item look preset, adjustments, aspect and focal points are honoured in a job', async () => {
    const p = ExportPresetSchema.parse({ slug: 'items', name: 'items', longEdge: 200 });
    const job = await startRenderJob(
      [
        { path: jpg, look: 'clean-bw', adjust: { exposure: 1.5 }, aspect: '1:1', gravity: 'center', focal: { x: 0.9, y: 0.5 } },
        { path: jpg, aspect: '1:1', gravity: 'center' },
        { path: jpg, aspect: '4:3' },
      ],
      p,
    );
    const done = await waitJob(job.id);
    expect(done.done).toBe(3);
    const a = await sharp(done.items[0]!.dst!).stats();
    const b = await sharp(done.items[1]!.dst!).stats();
    // +1.5 EV → clearly brighter overall
    expect(a.channels[1]!.mean).toBeGreaterThan(b.channels[1]!.mean + 20);
    // clean-bw is greyscale: channels agree; the un-looked one has a red subject
    expect(Math.abs(a.channels[0]!.mean - a.channels[2]!.mean)).toBeLessThan(3);
    expect(b.channels[0]!.max).toBeGreaterThan(200);
    const md = await sharp(done.items[2]!.dst!).metadata();
    expect([md.width, md.height]).toEqual([200, 150]);
    // unknown look slug fails fast
    await expect(startRenderJob([{ path: jpg, look: 'no-such-look' }], p)).rejects.toThrow(/no look/);
  });

  it('resolveLook: slug, none, object, adjustments', async () => {
    expect(await resolveLook(undefined)).toEqual(IDENTITY_LOOK);
    expect(await resolveLook('none')).toEqual(IDENTITY_LOOK);
    expect((await resolveLook('teal-orange')).splitShadowAmount).toBeGreaterThan(0);
    expect((await resolveLook('teal-orange', { exposure: 1 })).exposure).toBe(1);
    expect((await resolveLook({ vignette: 40 })).vignette).toBe(40);
  });

  it('clarity renders at any size without sharp limits and adds local contrast', async () => {
    const src = await openSource(jpg);
    const flat = await renderImage(src, spec({ longEdge: 300 }));
    const crisp = await renderImage(src, spec({ look: look({ clarity: 100 }), longEdge: 300 }));
    const soft = await renderImage(src, spec({ look: look({ clarity: -100 }), longEdge: 300 }));
    const sd = async (b: Buffer) => (await sharp(b).stats()).channels[1]!.stdev;
    expect(await sd(crisp.data)).toBeGreaterThan(await sd(flat.data));
    expect(await sd(soft.data)).toBeLessThan(await sd(flat.data));
    // full size (1200 px) works too — this is where sharp's sharpen(sigma ≤ 10) used to throw
    const big = await renderImage(src, spec({ look: look({ clarity: 60 }) }));
    expect(big.width).toBe(1200);
  });
});

describe('ingest', () => {
  const card = path.join(work, 'CARD', 'DCIM', 'Camera01');

  beforeAll(async () => {
    await mkdir(card, { recursive: true });
    await makeScene(path.join(card, 'IMG_0001.jpg'), 600, 400);
    await makeScene(path.join(card, 'IMG_0002.jpg'), 600, 400);
    await writeFile(path.join(card, 'IMG_0001.dng'), Buffer.alloc(2048, 1)); // fake sidecar
    await writeFile(path.join(card, 'CLIP_0001.mp4'), Buffer.alloc(4096, 2)); // fake video, no exif → mtime
    await writeFile(path.join(card, 'notes.txt'), 'ignore me');
    await exiftool.write(path.join(card, 'IMG_0001.jpg'), { DateTimeOriginal: '2026:08:16 18:30:00' }, { writeArgs: ['-overwrite_original'] });
    await exiftool.write(path.join(card, 'IMG_0002.jpg'), { DateTimeOriginal: '2026:08:16 18:30:00' }, { writeArgs: ['-overwrite_original'] });
  });

  it('plans: groups sidecars, names by capture time, dedupes stems, skips unknown', async () => {
    const plan = await planImport(path.join(work, 'CARD'));
    expect(plan.totals.skipUnsupported).toBe(1);
    const jpg1 = plan.items.find((i) => i.src.endsWith('IMG_0001.jpg'))!;
    const dng1 = plan.items.find((i) => i.src.endsWith('IMG_0001.dng'))!;
    const jpg2 = plan.items.find((i) => i.src.endsWith('IMG_0002.jpg'))!;
    expect(jpg1.action).toBe('copy');
    expect(path.basename(jpg1.dst)).toBe('20260816-183000.jpg');
    expect(path.basename(dng1.dst)).toBe('20260816-183000.dng'); // same stem as its JPG
    expect(path.basename(jpg2.dst)).toBe('20260816-183000-2.jpg'); // same second, different group
    expect(jpg1.dst).toContain(path.join('2026', '2026-08-16'));
    const mp4 = plan.items.find((i) => i.src.endsWith('CLIP_0001.mp4'))!;
    expect(mp4.dateSource).toBe('mtime');
    expect(plan.totals.copy).toBe(4);
  });

  it('runs the plan, verifies, and a re-plan skips what exists', async () => {
    const plan = await planImport(path.join(work, 'CARD'));
    const job = startImportJob(plan);
    const done = await waitJob(job.id);
    expect(done.status).toBe('done');
    expect(done.done).toBe(4);
    for (const it of done.items) expect(existsSync(it.dst!)).toBe(true);
    const again = await planImport(path.join(work, 'CARD'));
    expect(again.totals.copy).toBe(0);
    expect(again.totals.skipExists).toBe(4);
    const manifest = (await import('node:fs/promises')).readdir(path.join(dataDir, 'jobs'));
    expect((await manifest).some((f) => f.endsWith('.manifest.json'))).toBe(true);
  });

  it('refuses a source inside the archive', async () => {
    await expect(planImport(getSettings().archiveRoot)).rejects.toThrow(/inside the archive/);
  });
});

function synthDngPixels(w: number, h: number): Float32Array {
  const px = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const red = x > w * 0.6 && x < w * 0.85 && y > h * 0.3 && y < h * 0.8;
      px[i] = red ? 0.8 : 0.4;
      px[i + 1] = red ? 0.1 : 0.4;
      px[i + 2] = red ? 0.05 : 0.6;
    }
  return px;
}

describe('RAW engines', () => {
  const dng = path.join(work, 'synth.dng');
  const w = 320;
  const h = 240;
  beforeAll(async () => {
    await writeLinearDng(dng, w, h, synthDngPixels(w, h));
  });

  it('reports the engine chain', async () => {
    const info = await detectRawEngine(true);
    expect(['darktable', 'libraw', 'embedded']).toContain(info.engine);
    expect(info.libraw).toBe(true);
  });

  it('LibRaw (wasm) develops a synthetic linear DNG in a worker', async () => {
    const r = await developRawToBuffer(dng);
    expect([r.width, r.height]).toEqual([w, h]);
    const st = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).stats();
    expect(st.channels[0]!.max).toBeGreaterThan(150); // the red block survived development
    // the red block sits right of centre (stats() ignores extract, so materialize the region first)
    const region = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
      .extract({ left: Math.round(w * 0.65), top: Math.round(h * 0.4), width: 30, height: 30 })
      .png()
      .toBuffer();
    const right = await sharp(region).stats();
    expect(right.channels[0]!.mean).toBeGreaterThan(right.channels[2]!.mean + 60);
    const bg = await sharp(await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).extract({ left: 10, top: 10, width: 30, height: 30 }).png().toBuffer()).stats();
    expect(bg.channels[2]!.mean).toBeGreaterThan(bg.channels[0]!.mean); // bluish background
  });

  it('LibRaw demosaics a Bayer (RGGB) DNG', async () => {
    const bayer = path.join(work, 'bayer.dng');
    await writeBayerDng(bayer, 400, 300, synthDngPixels(400, 300));
    const r = await developRawToBuffer(bayer);
    expect([r.width, r.height]).toEqual([400, 300]);
    const region = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
      .extract({ left: 260, top: 120, width: 40, height: 40 })
      .png()
      .toBuffer();
    const st = await sharp(region).stats();
    expect(st.channels[0]!.mean).toBeGreaterThan(st.channels[2]!.mean + 60);
  });

  it('forced LibRaw engine develops through openSource, caches, and feeds derivatives', async () => {
    await saveSettings({ raw: { engine: 'libraw', darktablePath: '', quality: 96 } });
    const info = await detectRawEngine(true);
    expect(info.engine).toBe('libraw');
    const src = await openSource(dng);
    expect(src.note).toContain('LibRaw');
    expect([src.width, src.height]).toEqual([w, h]);
    const r = await renderImage(src, spec({ longEdge: 160 }));
    expect(r.width).toBe(160);
    const st = await sharp(r.data).stats();
    expect(st.channels[0]!.max).toBeGreaterThan(150);
    const t0 = Date.now();
    const again = await openSource(dng);
    expect(again.width).toBe(w);
    expect(Date.now() - t0).toBeLessThan(2000); // cache hit
    const d = await ensureDerivatives(dng);
    expect(existsSync(d.thumb)).toBe(true);
    // a broken DNG reports a real error (no silent embedded-preview nonsense)
    const broken = path.join(work, 'broken.dng');
    await writeFile(broken, Buffer.alloc(4096, 7));
    await expect(openSource(broken)).rejects.toThrow(/RAW development failed|no embedded preview|LibRaw/);
    await saveSettings({ raw: { engine: 'auto', darktablePath: '', quality: 96 } });
    await detectRawEngine(true);
  });

  it.skipIf(!existsSync('/usr/bin/darktable-cli') && !process.env.DARKTABLE_CLI)('darktable-cli develops the same DNG when present (auto)', async () => {
    const info = await detectRawEngine(true);
    expect(info.engine).toBe('darktable');
    const dng2 = path.join(work, 'synth2.dng');
    await writeLinearDng(dng2, w, h, synthDngPixels(w, h));
    const src = await openSource(dng2);
    expect(src.note).toContain('darktable');
    expect([src.width, src.height]).toEqual([w, h]);
    const r = await renderImage(src, spec({ longEdge: 160 }));
    const st = await sharp(r.data).stats();
    expect(st.channels[0]!.max).toBeGreaterThan(150);
  });
});

describe('export presets store', () => {
  it('seeds defaults and supports CRUD', async () => {
    const all = await exportStore.list();
    expect(all.map((p) => p.slug)).toEqual(expect.arrayContaining(['instagram', 'full-quality', 'web']));
    expect(all[0]!.slug).toBe('instagram');
    const saved = await exportStore.save({ slug: 'my-export', name: 'Mine', longEdge: 1000, format: 'webp' }, { create: true });
    expect(saved.quality).toBe(90);
    expect(saved.metadata).toBe('keep-no-gps');
    await expect(exportStore.save({ slug: 'my-export', name: 'dup' }, { create: true })).rejects.toThrow(/exists/);
    expect(await exportStore.remove('my-export')).toBe(true);
    expect(await exportStore.remove('my-export')).toBe(false);
  });
});

describe('look presets store', () => {
  it('seeds defaults and supports CRUD', async () => {
    const all = await lookStore.list();
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((l) => l.slug === 'teal-orange')).toBe(true);
    expect(all.some((l) => l.slug === 'night-city')).toBe(true);
    const saved = await lookStore.save({ slug: 'my-test', name: 'My test', look: { exposure: 0.4 } }, { create: true });
    expect(saved.group).toBe('custom');
    expect(saved.look.exposure).toBe(0.4);
    expect(saved.look.fade).toBe(0);
    await expect(lookStore.save({ slug: 'my-test', name: 'dup' }, { create: true })).rejects.toThrow(/exists/);
    expect(await lookStore.remove('my-test')).toBe(true);
    expect(await lookStore.remove('my-test')).toBe(false);
  });
});

describe('per-folder edits sidecar', () => {
  const dir = path.join(work, 'edits-dir');
  const other = path.join(work, 'edits-other');
  it('patches, merges, prunes and transfers', async () => {
    await mkdir(dir, { recursive: true });
    await mkdir(other, { recursive: true });
    expect((await readFolderEdits(dir)).edits).toEqual({});
    let e = await patchFolderEdits(dir, { 'a.jpg': { star: true }, 'b.jpg': { focal: { x: 0.2, y: 0.3 }, adjust: { exposure: 0.5 } } });
    expect(e.edits['a.jpg']!.star).toBe(true);
    // merging keeps other fields; adjustments merge key-wise; look slug and aspect are plain fields
    e = await patchFolderEdits(dir, { 'b.jpg': { adjust: { contrast: 10 }, look: 'teal-orange', aspect: '4:3' } });
    expect(e.edits['b.jpg']!.focal).toEqual({ x: 0.2, y: 0.3 });
    expect(e.edits['b.jpg']!.adjust).toEqual({ exposure: 0.5, contrast: 10 });
    expect(e.edits['b.jpg']!.look).toBe('teal-orange');
    expect(e.edits['b.jpg']!.aspect).toBe('4:3');
    // null inside adjust removes one slider; null aspect removes the crop ratio
    e = await patchFolderEdits(dir, { 'b.jpg': { adjust: { exposure: null }, aspect: null } });
    expect(e.edits['b.jpg']!.adjust).toEqual({ contrast: 10 });
    expect(e.edits['b.jpg']!.aspect).toBeUndefined();
    // un-star prunes an otherwise empty entry
    e = await patchFolderEdits(dir, { 'a.jpg': { star: false } });
    expect(e.edits['a.jpg']).toBeUndefined();
    // null deletes
    e = await patchFolderEdits(dir, { 'b.jpg': null });
    expect(e.edits['b.jpg']).toBeUndefined();
    // transfer between folders
    await patchFolderEdits(dir, { 'c.jpg': { star: true } });
    await transferEdits([{ from: path.join(dir, 'c.jpg'), to: path.join(other, 'c.jpg') }]);
    expect((await readFolderEdits(dir)).edits['c.jpg']).toBeUndefined();
    expect((await readFolderEdits(other)).edits['c.jpg']!.star).toBe(true);
    // the sidecar file itself exists and is valid JSON
    const raw = JSON.parse(await readFile(path.join(other, '.image-processor.json'), 'utf8')) as { version: number };
    expect(raw.version).toBe(2);
  });
  it('reads a v1 (profile-based) sidecar and migrates it', async () => {
    const legacy = path.join(work, 'edits-legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, '.image-processor.json'),
      JSON.stringify({ version: 1, edits: { 'x.jpg': { profile: 'instagram-4x5', lookPreset: 'beach-midday', look: { exposure: 0.2 }, star: true } } }),
    );
    const e = await readFolderEdits(legacy);
    expect(e.version).toBe(2);
    expect(e.edits['x.jpg']).toEqual({ look: 'beach-midday', adjust: { exposure: 0.2 }, star: true });
    const after = await patchFolderEdits(legacy, { 'x.jpg': { aspect: '1:1' } });
    expect(after.edits['x.jpg']!.look).toBe('beach-midday');
    const raw = JSON.parse(await readFile(path.join(legacy, '.image-processor.json'), 'utf8')) as { version: number };
    expect(raw.version).toBe(2);
  });
});

describe('sanity', () => {
  it('data dir was created under the temp root', async () => {
    expect((await stat(dataDir)).isDirectory()).toBe(true);
    expect(existsSync(path.join(dataDir, 'config', 'settings.json'))).toBe(true);
    void readFile;
  });
});
