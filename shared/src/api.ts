import { z } from 'zod';
import type { MediaKind } from './pairing.js';
import type { NormRect } from './crop.js';
import type { FocalSchema } from './edits.js';
import { GRAVITIES, type AspectRatio, type ExportPreset, type Gravity } from './spec.js';

/** Persisted in <config>/settings.json. Paths are absolute on the machine running the server. */
export const SettingsSchema = z.object({
  archiveRoot: z.string().default(''),
  exportRoot: z.string().default(''),
  cacheDir: z.string().default(''),
  /** Parallel renders / copies. 2–4 is right for a desktop; HEIC decoding is the heavy part. */
  concurrency: z.number().int().min(1).max(16).default(3),
  /** Long edge of the cached proxy used for previews. */
  previewMaxEdge: z.number().int().min(600).max(4000).default(1600),
  thumbSize: z.number().int().min(120).max(640).default(320),
  /** Import: hash-verify copies for photos always; videos only when this is 'all'. */
  importVerify: z.enum(['photos', 'all', 'none']).default('photos'),
  upscaler: z
    .object({
      /** Path to realesrgan-ncnn-vulkan(.exe). Empty = not configured (v1 default). */
      binPath: z.string().default(''),
      modelsDir: z.string().default(''),
    })
    .prefault({}),
  /** Where the crop window goes for photos without a focal point of their own. */
  defaultGravity: z.enum(GRAVITIES).default('attention'),
  /** EXIF makes left out when a camera is named (for makes that are a company name nobody knows the camera by). */
  hideCameraMakes: z.array(z.string()).default([]),
  raw: z
    .object({
      /**
       * 'auto' = darktable-cli if installed, else the built-in LibRaw (wasm), else the embedded preview.
       * 'darktable' / 'libraw' force one engine (falls back down the chain if unavailable); 'embedded' = never develop.
       */
      engine: z.enum(['auto', 'darktable', 'libraw', 'embedded']).default('auto'),
      /** Explicit path to darktable-cli(.exe); empty = search the usual install locations. */
      darktablePath: z.string().default(''),
      /** JPEG quality of the cached development. */
      quality: z.number().int().min(80).max(100).default(96),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | MediaKind;
  size?: number;
  mtimeMs?: number;
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: FsEntry[];
  files: FsEntry[];
  /** Number of files skipped as unsupported/hidden. */
  skipped: number;
}

export interface QuickRoot {
  label: string;
  path: string;
}

export interface ImageInfo {
  path: string;
  width: number;
  height: number;
  kind: MediaKind;
  capturedAt: string | null;
  make?: string;
  model?: string;
  colorProfile?: string;
}

export type JobType = 'render' | 'import';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface JobItem {
  src: string;
  dst?: string;
  status: JobItemStatus;
  error?: string;
  note?: string;
}

export interface Job {
  id: string;
  type: JobType;
  title: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  items: JobItem[];
  meta: Record<string, unknown>;
  log: string[];
}

export type FocalPoint = z.infer<typeof FocalSchema>;

/** One photo in a render job with everything that can differ per photo (its sidecar state, basically). */
export interface RenderItem {
  path: string;
  /** Look preset slug; omitted = identity look. */
  look?: string;
  /** Slider adjustments on top of the look. */
  adjust?: Record<string, number>;
  /** Crop ratio; omitted/'original' = no crop. */
  aspect?: AspectRatio;
  /** Where the crop window goes when there is no focal/crop (default: settings.defaultGravity). */
  gravity?: Gravity;
  focal?: FocalPoint;
  crop?: NormRect;
}

export interface RenderRequest {
  /** Export preset slug, or a full preset object (unsaved). */
  export: string | ExportPreset;
  /** Optional destination folder override (absolute). */
  destination?: string;
  items: RenderItem[];
}

export type ImportAction = 'copy' | 'skip-exists' | 'skip-unsupported' | 'skip-hidden';

export interface ImportPlanItem {
  src: string;
  size: number;
  kind: MediaKind;
  capturedAt: string;
  dateSource: 'exif' | 'mtime';
  group: string;
  dst: string;
  action: ImportAction;
  reason?: string;
}

export interface ImportPlan {
  source: string;
  archiveRoot: string;
  createdAt: string;
  items: ImportPlanItem[];
  totals: {
    files: number;
    bytes: number;
    copy: number;
    copyBytes: number;
    skipExists: number;
    skipUnsupported: number;
    byKind: Record<string, number>;
    days: string[];
  };
  warnings: string[];
}

export interface ServerInfo {
  version: string;
  platform: string;
  /** Settings, looks and export presets. */
  configDir: string;
  /** Cache and job history. */
  dataDir: string;
  node: string;
  raw: RawEngineInfo;
}

export type RawEngine = 'darktable' | 'libraw' | 'embedded';
export interface RawEngineInfo {
  /** Engine that will be used for the next DNG. */
  engine: RawEngine;
  darktablePath: string | null;
  /** darktable version when found. */
  version?: string;
  /** LibRaw (wasm) available — always true unless the module failed to load. */
  libraw: boolean;
  librawError?: string;
}

export interface FsOpResult {
  ok: string[];
  failed: { path: string; error: string }[];
}
