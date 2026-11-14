import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { mediaKind, type MediaKind } from '../../../shared/src/pairing.js';
import { P3_TO_SRGB, type ColorMatrix } from '../../../shared/src/look.js';
import { httpError } from '../http.js';
import { decodeHeicFile } from './heic.js';
import { developRaw } from './raw.js';
import { extractEmbeddedPreview, isDisplayP3, orientationOps, readSourceMeta, type SourceMeta } from '../meta/exif.js';

/**
 * A decoded source: a factory for fresh sharp pipelines (sharp instances are single-use) plus the
 * oriented dimensions and everything the render stage needs to know about colour.
 */
export interface DecodedSource {
  path: string;
  kind: MediaKind;
  /** Oriented (display) size. */
  width: number;
  height: number;
  /** New pipeline positioned at the oriented image. */
  pipeline: () => Sharp;
  /** Linear-light colour matrix to apply in the look stage (HEIC in Display P3). */
  matrix?: ColorMatrix;
  meta: SourceMeta;
  /** Set for DNG: which engine produced the pixels ('developed by darktable', 'developed by LibRaw', 'embedded preview …'). */
  note?: string;
}

/** The pixels of a source, before the file-level facts (path, kind, metadata) are attached. */
type Pixels = Pick<DecodedSource, 'width' | 'height' | 'pipeline' | 'matrix' | 'note'>;

const LENIENT = { failOn: 'none' as const, limitInputPixels: false };

/** Anything sharp reads by itself. It applies EXIF orientation and the embedded ICC → sRGB, so no matrix. */
async function sharpPixels(file: string): Promise<Pixels> {
  const open = () => sharp(file, { ...LENIENT, autoOrient: true });
  const md = await open().metadata();
  return { width: md.autoOrient?.width ?? md.width ?? 0, height: md.autoOrient?.height ?? md.height ?? 0, pipeline: open };
}

/** HEIC via libheif, which already applied the container rotation: EXIF orientation must NOT be applied again. */
async function heicPixels(file: string, meta: SourceMeta): Promise<Pixels> {
  const { width, height, data } = await decodeHeicFile(file);
  return {
    width,
    height,
    pipeline: () => sharp(data, { ...LENIENT, raw: { width, height, channels: 4 } }).removeAlpha(),
    matrix: isDisplayP3(meta.colorProfile) ? P3_TO_SRGB : undefined,
  };
}

/** RAW: a real development (darktable-cli, else the bundled LibRaw) cached as a full-size JPEG, else the embedded preview. */
async function rawPixels(file: string, meta: SourceMeta): Promise<Pixels> {
  let developError: string | null = null;
  const developed = await developRaw(file).catch((err: Error) => {
    developError = err.message;
    console.warn(`[raw] ${path.basename(file)}: ${developError}`);
    return null;
  });
  if (developed) {
    return { ...(await sharpPixels(developed.file)), note: developed.engine === 'darktable' ? 'developed by darktable' : 'developed by LibRaw' };
  }

  const preview = await extractEmbeddedPreview(file);
  if (!preview) {
    throw new Error(
      developError ? `RAW development failed (${developError}) and the DNG has no embedded preview` : 'DNG has no embedded preview and no RAW engine is enabled (Settings → RAW)',
    );
  }
  // The embedded JPEG usually carries no EXIF; apply the DNG's orientation by hand.
  const ops = orientationOps(meta.orientation);
  const md = await sharp(preview).metadata();
  const [w, h] = [md.width ?? 0, md.height ?? 0];
  const sideways = ops.rotate === 90 || ops.rotate === 270;
  return {
    width: sideways ? h : w,
    height: sideways ? w : h,
    pipeline: () => {
      let s = sharp(preview, LENIENT);
      if (ops.rotate) s = s.rotate(ops.rotate);
      if (ops.flop) s = s.flop();
      if (ops.flip) s = s.flip();
      return s;
    },
    note: developError ? `embedded preview (RAW development failed: ${developError})` : 'embedded preview (RAW development disabled)',
  };
}

export async function openSource(file: string): Promise<DecodedSource> {
  const kind = mediaKind(path.basename(file));
  const meta = await readSourceMeta(file);
  const decoders: Partial<Record<MediaKind, () => Promise<Pixels>>> = {
    photo: () => sharpPixels(file),
    heic: () => heicPixels(file, meta),
    raw: () => rawPixels(file, meta),
  };
  const decode = decoders[kind];
  if (!decode) throw httpError(415, `unsupported file type: ${path.basename(file)}`);
  return { path: file, kind, meta, ...(await decode()) };
}
