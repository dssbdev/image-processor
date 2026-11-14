import { stat } from 'node:fs/promises';
import { ExifDateTime, ExifTool, type Tags } from 'exiftool-vendored';
import type { MetadataPolicy } from '../../../shared/src/spec.js';

/**
 * One ExifTool process pool for the whole server (spawning is expensive, reads are ~10–40 ms once warm).
 * Windows: exiftool-vendored ships a perl-free exiftool.exe, nothing to install.
 */
export const exiftool = new ExifTool({
  maxProcs: 2,
  taskTimeoutMillis: 30_000,
  ignoreMinorErrors: true,
});

export async function shutdownExiftool(): Promise<void> {
  await exiftool.end();
}

export interface SourceMeta {
  /** Capture wall-clock time as written by the camera (local to where it was shot), or file mtime. */
  capturedAt: Date;
  dateSource: 'exif' | 'mtime';
  /** EXIF orientation 1..8, 1 when absent. */
  orientation: number;
  make?: string;
  model?: string;
  lens?: string;
  /** ICC profile description, e.g. "Display P3", "sRGB IEC61966-2.1". */
  colorProfile?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  hasGps: boolean;
}

const EXIF_DT_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * Wall-clock Date from an ExifDateTime (or raw string): we deliberately keep the components as written
 * (capture-local time), so date folders and file names say what the camera said, whatever zone the PC is in.
 */
export function wallClock(v: unknown): Date | null {
  if (v instanceof ExifDateTime) {
    return new Date(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  }
  if (typeof v === 'string') {
    const m = EXIF_DT_RE.exec(v);
    if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Order matters: photos first, then the zone-aware QuickTime keys phones write, then generic QuickTime. */
const DATE_TAGS = ['DateTimeOriginal', 'CreationDate', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'ModifyDate'] as const;

export function pickCaptureDate(tags: Tags): Date | null {
  for (const key of DATE_TAGS) {
    const v = (tags as Record<string, unknown>)[key];
    if (v == null) continue;
    const d = wallClock(v);
    if (d && d.getFullYear() > 1980) return d;
  }
  return null;
}

export async function readSourceMeta(file: string): Promise<SourceMeta> {
  let tags: Tags | null = null;
  try {
    tags = await exiftool.read(file, ['-fast']);
  } catch (err) {
    console.warn(`[exif] read failed for ${file}: ${(err as Error).message}`);
  }
  const fromExif = tags ? pickCaptureDate(tags) : null;
  const capturedAt = fromExif ?? (await stat(file)).mtime;
  const orientationRaw = tags ? (tags as Record<string, unknown>).Orientation : undefined;
  return {
    capturedAt,
    dateSource: fromExif ? 'exif' : 'mtime',
    orientation: normalizeOrientation(orientationRaw),
    make: strOrUndef(tags?.Make),
    model: strOrUndef(tags?.Model),
    lens: strOrUndef(tags?.LensModel),
    colorProfile: strOrUndef((tags as Record<string, unknown> | null)?.ProfileDescription),
    width: numOrUndef(tags?.ImageWidth),
    height: numOrUndef(tags?.ImageHeight),
    mimeType: strOrUndef(tags?.MIMEType),
    hasGps: tags?.GPSLatitude != null || tags?.GPSPosition != null,
  };
}

/** exiftool-vendored returns Orientation as a number by default; strings can show up with -fast on odd files. */
export function normalizeOrientation(v: unknown): number {
  if (typeof v === 'number' && v >= 1 && v <= 8) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (n >= 1 && n <= 8) return n;
    const s = v.toLowerCase();
    if (s.includes('horizontal (normal)')) return 1;
    if (s.includes('mirror horizontal') && s.includes('270')) return 5;
    if (s.includes('mirror horizontal') && s.includes('90')) return 7;
    if (s.includes('mirror horizontal')) return 2;
    if (s.includes('mirror vertical')) return 4;
    if (s.includes('180')) return 3;
    if (s.includes('90 cw')) return 6;
    if (s.includes('270 cw')) return 8;
  }
  return 1;
}

/** Sharp-friendly decomposition of an EXIF orientation. */
export function orientationOps(o: number): { rotate: 0 | 90 | 180 | 270; flop: boolean; flip: boolean } {
  switch (o) {
    case 2:
      return { rotate: 0, flop: true, flip: false };
    case 3:
      return { rotate: 180, flop: false, flip: false };
    case 4:
      return { rotate: 0, flop: false, flip: true };
    case 5:
      return { rotate: 90, flop: true, flip: false };
    case 6:
      return { rotate: 90, flop: false, flip: false };
    case 7:
      return { rotate: 270, flop: true, flip: false };
    case 8:
      return { rotate: 270, flop: false, flip: false };
    default:
      return { rotate: 0, flop: false, flip: false };
  }
}

/** Is the ICC profile a Display P3 variant? */
export function isDisplayP3(desc: string | undefined): boolean {
  return !!desc && /p3/i.test(desc) && !/srgb/i.test(desc);
}

/**
 * Copy metadata from the source to a freshly encoded output.
 * - Orientation is reset to 1 (pixels are already upright).
 * - Stale size/thumbnail/preview tags and the source ICC are dropped (the output is sRGB at a new size).
 * - 'keep-no-gps' deletes every GPS tag, EXIF and XMP.
 */
export async function copyMetadata(src: string, dst: string, policy: MetadataPolicy): Promise<void> {
  if (policy === 'strip') return;
  const args = [
    '-overwrite_original',
    '-TagsFromFile',
    src,
    '-all:all',
    '-Orientation#=1',
    '-XMP-tiff:Orientation=',
    '-ExifImageWidth=',
    '-ExifImageHeight=',
    '-ThumbnailImage=',
    '-PreviewImage=',
    '-ICC_Profile:all=',
  ];
  if (policy === 'keep-no-gps') {
    args.push('-gps:all=', '-XMP-exif:GPS*=', '-XMP:GPS*=');
  }
  await exiftool.write(dst, {}, { writeArgs: args, ignoreMinorErrors: true });
}

/** Embedded JPEG from a DNG (or other RAW), largest first. Null when there is none. */
export async function extractEmbeddedPreview(file: string): Promise<Buffer | null> {
  for (const tag of ['JpgFromRaw', 'PreviewImage', 'ThumbnailImage'] as const) {
    try {
      const buf = await exiftool.extractBinaryTagToBuffer(tag, file);
      if (buf && buf.length > 1024) return buf;
    } catch {
      /* tag absent — try the next */
    }
  }
  return null;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
