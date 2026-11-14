import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { execa } from 'execa';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { cachePath, getSettings } from '../config.js';
import { cacheKey } from '../cache/derivatives.js';
import { exists } from '../fs/util.js';
import type { RawEngine, RawEngineInfo } from '../../../shared/src/api.js';
import { darktableCandidates, whichCommand } from './darktable-locations.mjs';
import { toTransferable, workerScript, type Pending as PendingFor } from './worker.js';

/**
 * RAW (DNG) development. Three engines, tried in this order (or forced in Settings):
 *   1. darktable-cli — best rendering, uses the GPU, needs darktable installed (auto-detected).
 *   2. LibRaw (wasm, bundled) — real demosaic in a worker thread, zero install. Slower than native, fine for
 *      one-time developments that are then cached.
 *   3. embedded preview — the JPEG inside the DNG (small, camera-rendered); the caller says so.
 * Whatever the engine, the result is a full-resolution JPEG (q96 4:4:4) in cache/raw/, then the normal
 * pipeline treats that JPEG as the source. So preview and export always see the same pixels.
 */

let detected: RawEngineInfo | null = null;
let detectedFor = '';
const developLimit = pLimit(1); // both engines use every core; one at a time is faster overall
const inflight = new Map<string, Promise<DevelopResult>>();

export interface DevelopResult {
  /** Path of the developed JPEG in the cache. */
  file: string;
  engine: Exclude<RawEngine, 'embedded'>;
}

async function onPath(): Promise<string | null> {
  try {
    const { stdout } = await execa(whichCommand(), ['darktable-cli'], { timeout: 5000 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/** The darktable-cli to use: the configured path if set (and present), else the usual install locations, else PATH. */
async function findDarktable(configuredPath: string): Promise<string | null> {
  if (configuredPath) return (await exists(configuredPath)) ? configuredPath : null;
  for (const candidate of darktableCandidates()) if (await exists(candidate)) return candidate;
  return onPath();
}

async function darktableVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa(bin, ['--version'], { timeout: 15000, reject: false });
    return /darktable\s+([\d.]+)/i.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/** Find darktable-cli, probe LibRaw, and decide which engine will run — cached until settings change. */
export async function detectRawEngine(force = false): Promise<RawEngineInfo> {
  const s = getSettings();
  const key = `${s.raw.engine}|${s.raw.darktablePath}`;
  if (!force && detected && detectedFor === key) return detected;
  const wantsDarktable = s.raw.engine === 'auto' || s.raw.engine === 'darktable';
  const found = wantsDarktable ? await findDarktable(s.raw.darktablePath) : null;
  const version = found ? await darktableVersion(found) : undefined;
  const lib = s.raw.engine === 'embedded' ? { ok: false, error: 'disabled in settings' } : await librawPool().ping();
  let engine: RawEngine = 'embedded';
  if (found && s.raw.engine !== 'libraw') engine = 'darktable';
  else if (lib.ok) engine = 'libraw';
  detected = { engine, darktablePath: found, version, libraw: lib.ok, librawError: lib.error };
  detectedFor = key;
  return detected;
}

export function describeRawEngine(r: RawEngineInfo): string {
  switch (r.engine) {
    case 'darktable':
      return `darktable-cli ${r.version ?? ''} at ${r.darktablePath}${r.libraw ? ' (LibRaw wasm as fallback)' : ''}`;
    case 'libraw':
      return `LibRaw (wasm, built in)${r.darktablePath ? '' : ' — install darktable for its rendering + GPU'}`;
    default:
      return `embedded previews only${r.librawError ? ` (LibRaw failed to load: ${r.librawError})` : ''}`;
  }
}

export function rawCachePathFor(key: string): string {
  return path.join(cachePath('raw'), `${key}.jpg`);
}

/**
 * Develop a RAW file to a cached full-resolution JPEG. Returns null when no engine can develop it (embedded
 * preview mode); throws when the engines exist but fail on this file. Safe to call concurrently for the same file.
 */
export async function developRaw(file: string): Promise<DevelopResult | null> {
  const info = await detectRawEngine();
  if (info.engine === 'embedded') return null;
  const st = await stat(file);
  const s = getSettings();
  const key = `${cacheKey(file, st.size, st.mtimeMs)}-q${s.raw.quality}`;
  // Either engine's result is accepted from cache (they are named by engine so a later darktable install re-develops).
  for (const eng of ['darktable', 'libraw'] as const) {
    const out = rawCachePathFor(`${key}-${eng}`);
    if (existsSync(out) && (eng === info.engine || eng === 'darktable')) return { file: out, engine: eng };
  }
  let job = inflight.get(key);
  if (!job) {
    job = developLimit(() => developWithChain(info, file, key, s.raw.quality)).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function developWithChain(info: RawEngineInfo, file: string, key: string, quality: number): Promise<DevelopResult> {
  const errors: string[] = [];
  if (info.engine === 'darktable' && info.darktablePath) {
    const out = rawCachePathFor(`${key}-darktable`);
    try {
      await runDarktable(info.darktablePath, file, out, quality);
      return { file: out, engine: 'darktable' };
    } catch (err) {
      errors.push((err as Error).message);
      console.warn(`[raw] darktable-cli failed on ${path.basename(file)}: ${(err as Error).message} — trying LibRaw`);
    }
  }
  if (info.libraw) {
    const out = rawCachePathFor(`${key}-libraw`);
    try {
      await runLibRaw(file, out, quality);
      return { file: out, engine: 'libraw' };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(errors.join(' · ') || 'no RAW engine available');
}

async function runDarktable(bin: string, src: string, out: string, quality: number): Promise<string> {
  await mkdir(path.dirname(out), { recursive: true });
  // darktable-cli refuses to overwrite; render to a fresh temp name and move into place.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ip-dt-'));
  const tmpOut = path.join(tmpDir, 'out.jpg');
  const cfgDir = path.join(tmpDir, 'config');
  await mkdir(cfgDir, { recursive: true });
  const args = [
    src,
    tmpOut,
    '--hq',
    'true',
    '--upscale',
    'false',
    '--apply-custom-presets',
    'false',
    '--core',
    '--configdir',
    cfgDir,
    '--library',
    ':memory:',
    '--conf',
    `plugins/imageio/format/jpeg/quality=${quality}`,
    '--conf',
    'plugins/imageio/format/jpeg/subsample=444',
  ];
  try {
    const res = await execa(bin, args, { timeout: 5 * 60_000, reject: false, windowsHide: true, all: true });
    if (!existsSync(tmpOut)) {
      const tail = (res.all ?? '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
      throw new Error(`darktable-cli failed (exit ${res.exitCode}): ${tail || 'no output'}`);
    }
    // The temp dir may be on another drive than the cache, where rename fails: copy instead.
    await rename(tmpOut, out).catch(() => copyFile(tmpOut, out));
    return out;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* LibRaw (wasm) in a worker thread                                                                   */
/* ------------------------------------------------------------------------------------------------ */

interface LibRawResult {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
  ms: number;
  meta?: { make?: string; model?: string; flip?: number };
}

type Pending = PendingFor<LibRawResult>;

/** LibRaw options: camera white balance, 8-bit sRGB output, AHD demosaic, no auto-brighten (we have exposure). */
const LIBRAW_OPTIONS = { useCameraWb: true, outputBps: 8, outputColor: 1, userQual: 3, noAutoBright: false, halfSize: false, highlight: 0 };

/** wasm memory never shrinks (a 50 MP development leaves ~700 MB allocated) — recycle the worker when idle. */
const LIBRAW_IDLE_MS = 90_000;

class LibRawPool {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private busy: Promise<unknown> = Promise.resolve();
  private pingResult: { ok: boolean; error?: string } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && this.worker) {
        void this.worker.terminate();
        this.worker = null;
      }
    }, LIBRAW_IDLE_MS);
    this.idleTimer.unref();
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerScript('libraw-worker.mjs'));
    worker.on('message', (msg: { id: number; ok: boolean; width?: number; height?: number; channels?: number; data?: ArrayBuffer; ms?: number; error?: string; meta?: LibRawResult['meta'] }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok && msg.data) p.resolve({ width: msg.width!, height: msg.height!, channels: msg.channels ?? 3, data: Buffer.from(msg.data), ms: msg.ms ?? 0, meta: msg.meta });
      else if (msg.ok) p.resolve({ width: 0, height: 0, channels: 0, data: Buffer.alloc(0), ms: 0 });
      else p.reject(new Error(msg.error ?? 'LibRaw failed'));
      this.touch();
    });
    worker.on('error', (err) => this.failAll(err));
    worker.on('exit', () => this.failAll(new Error('LibRaw worker exited')));
    this.worker = worker;
    return worker;
  }

  /** The worker is gone: reject everything that was waiting on it; the next request spawns a fresh one. */
  private failAll(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.worker = null;
  }

  private send(payload: Record<string, unknown>, transfer: ArrayBuffer[], timeoutMs: number): Promise<LibRawResult> {
    return new Promise<LibRawResult>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LibRaw timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.spawn().postMessage({ id, ...payload }, transfer);
      this.touch();
    });
  }

  /** Load the module once (in the worker) and report whether it works. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    if (this.pingResult) return this.pingResult;
    try {
      const r = await this.send({ cmd: 'ping' }, [], 60_000);
      this.pingResult = { ok: r.width === 0 || r.width > 0 };
    } catch (err) {
      this.pingResult = { ok: false, error: (err as Error).message };
    }
    return this.pingResult;
  }

  /** Decode sequentially (one wasm instance, one LibRaw object). */
  develop(buffer: Buffer): Promise<LibRawResult> {
    const run = async () => {
      const bytes = toTransferable(buffer);
      return this.send({ buffer: bytes, options: LIBRAW_OPTIONS }, [bytes], 10 * 60_000);
    };
    const next = this.busy.then(run, run);
    this.busy = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

let pool: LibRawPool | null = null;
export function librawPool(): LibRawPool {
  if (!pool) pool = new LibRawPool();
  return pool;
}

export async function shutdownLibRaw(): Promise<void> {
  if (pool) await pool.close();
  pool = null;
}

async function runLibRaw(src: string, out: string, quality: number): Promise<string> {
  await mkdir(path.dirname(out), { recursive: true });
  const buf = await readFile(src);
  const r = await librawPool().develop(buf);
  if (r.channels !== 3 && r.channels !== 4) throw new Error(`LibRaw returned ${r.channels} channels`);
  const tmp = `${out}.${process.pid}.tmp`;
  let img = sharp(r.data, { raw: { width: r.width, height: r.height, channels: r.channels as 3 | 4 }, limitInputPixels: false });
  if (r.channels === 4) img = img.removeAlpha();
  await img.jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(tmp);
  await rename(tmp, out);
  return out;
}

/** Utility for tests / doctor: develop straight to a buffer without touching the cache. */
export async function developRawToBuffer(file: string): Promise<{ data: Buffer; width: number; height: number; ms: number }> {
  const r = await librawPool().develop(await readFile(file));
  return { data: r.data, width: r.width, height: r.height, ms: r.ms };
}
