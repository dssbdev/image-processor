import sharp, { type Sharp } from 'sharp';
import { fitInside, fromNormRect, type NormRect, type Rect } from '../../../shared/src/crop.js';
import {
  applyClarityToRgb8,
  applyLookToRgb8,
  buildVignetteMask,
  clarityParams,
  saturationMultiplier,
  sharpenParams,
  type ColorMatrix,
} from '../../../shared/src/look.js';
import type { Look, OutputFormat } from '../../../shared/src/spec.js';
import type { DecodedSource } from '../decoders/index.js';

/** Everything the pipeline needs for one image. Preview and export build the same spec; only `opts` differ. */
export interface RenderSpec {
  look: Look;
  /** Crop window in normalized coordinates; null/undefined = whole image. */
  crop?: NormRect | null;
  /** Ratio the crop was made for (exact-ratio snapping at the target size); null = free / none. */
  ratio?: number | null;
  /** Long edge target in pixels; 0 = keep the source size (never enlarge). */
  longEdge: number;
  format: OutputFormat;
  quality: number;
}

export interface RenderOptions {
  /** Cap the long edge below the spec's target (previews). */
  maxEdge?: number;
  /** Override the encode (previews always want a fast JPEG). */
  encode?: { format: OutputFormat; quality: number };
}

export interface RenderResult {
  data: Buffer;
  width: number;
  height: number;
  format: OutputFormat;
  /** Size the image had after cropping, before resize (for "would need upscaling" hints). */
  cropped: { width: number; height: number };
}

/**
 * The one render path. Preview and batch call this with the same source + spec; only `maxEdge`/`encode`
 * differ. Order: crop → resize → look LUT (linear matrix if any) → clarity → saturation → vignette →
 * sharpen → encode. Metadata is handled by the caller (needs the file on disk).
 */
export async function renderImage(src: DecodedSource, spec: RenderSpec, opts: RenderOptions = {}): Promise<RenderResult> {
  const { look } = spec;
  const rect: Rect = spec.crop
    ? fromNormRect(spec.crop, src.width, src.height)
    : { left: 0, top: 0, width: src.width, height: src.height };

  let target = fitInside(rect.width, rect.height, spec.longEdge);
  if (opts.maxEdge) target = fitInside(target.width, target.height, opts.maxEdge);
  // With a fixed aspect, snap to the exact ratio at the target size (1638×2048, not 1639×2048): the crop
  // rectangle is integer-rounded in source pixels, so the resize absorbs the sub-pixel difference.
  const ratio = spec.ratio ?? null;
  if (ratio && spec.crop && (target.width !== rect.width || target.height !== rect.height)) {
    if (ratio >= 1) target = { width: target.width, height: Math.max(1, Math.round(target.width / ratio)) };
    else target = { width: Math.max(1, Math.round(target.height * ratio)), height: target.height };
  }

  let stage = src.pipeline();
  if (rect.left !== 0 || rect.top !== 0 || rect.width !== src.width || rect.height !== src.height) {
    stage = stage.extract(rect);
  }
  if (target.width !== rect.width || target.height !== rect.height) {
    stage = stage.resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' });
  }

  const { data, info } = await stage.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels after decode, got ${info.channels}`);

  applyLookToRgb8(data, look, src.matrix as ColorMatrix | undefined);

  const rawOpts = { raw: { width: info.width, height: info.height, channels: 3 as const }, failOn: 'none' as const, limitInputPixels: false as const };
  await applyClarity(data, look, info.width, info.height, rawOpts);
  let out = sharp(data, rawOpts);
  out = applyPostLook(out, look);
  out = await applyVignette(out, look, info.width, info.height);

  const enc = opts.encode ?? { format: spec.format, quality: spec.quality };
  out = encode(out, enc.format, enc.quality);
  const buf = await out.toBuffer();
  return {
    data: buf,
    width: info.width,
    height: info.height,
    format: enc.format,
    cropped: { width: rect.width, height: rect.height },
  };
}

/**
 * Clarity in place: the blur is computed on a small copy (long edge 400) and scaled back up, so the radius is
 * relative to the image and the cost is tiny at any resolution; the mix happens in JS.
 */
async function applyClarity(
  data: Buffer,
  look: Look,
  w: number,
  h: number,
  rawOpts: { raw: { width: number; height: number; channels: 3 }; failOn: 'none'; limitInputPixels: false },
): Promise<void> {
  const p = clarityParams(look.clarity ?? 0, w, h);
  if (!p) return;
  const small = await sharp(data, rawOpts).resize(p.smallWidth, p.smallHeight, { fit: 'fill', kernel: 'cubic' }).blur(p.sigma).raw().toBuffer();
  const blur = await sharp(small, { raw: { width: p.smallWidth, height: p.smallHeight, channels: 3 }, limitInputPixels: false })
    .resize(w, h, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
  applyClarityToRgb8(data, blur, p.amount);
}

function applyPostLook(img: Sharp, look: Look): Sharp {
  let s = img;
  const sat = saturationMultiplier(look.saturation);
  if (sat !== 1) s = s.modulate({ saturation: sat });
  const sp = sharpenParams(look.sharpen);
  if (sp) s = s.sharpen(sp);
  return s;
}

async function applyVignette(img: Sharp, look: Look, w: number, h: number): Promise<Sharp> {
  if (look.vignette <= 0) return img;
  const size = 256;
  const grey = buildVignetteMask(look.vignette, size);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < grey.length; i++) {
    const v = grey[i]!;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  const mask = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
    .resize(w, h, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
  return img.composite([{ input: mask, raw: { width: w, height: h, channels: 3 }, blend: 'multiply' }]);
}

function encode(img: Sharp, format: OutputFormat, quality: number): Sharp {
  switch (format) {
    case 'webp':
      return img.webp({ quality, effort: 4 });
    case 'png':
      return img.png({ compressionLevel: 6 });
    default:
      return img.jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' });
  }
}

export function extensionFor(format: OutputFormat): string {
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}
