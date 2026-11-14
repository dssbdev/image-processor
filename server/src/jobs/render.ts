import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { getSettings } from '../config.js';
import { openSource } from '../decoders/index.js';
import { takenStems } from '../fs/util.js';
import { resolveItemCrop, resolveLook, type ItemSpec } from '../pipeline/spec.js';
import { extensionFor, renderImage } from '../pipeline/render.js';
import { copyMetadata } from '../meta/exif.js';
import { jobs } from './queue.js';
import { expandTemplate, splitName, uniqueStem } from '../../../shared/src/naming.js';
import { mediaKind, isRenderable } from '../../../shared/src/pairing.js';
import type { ExportPreset, Look } from '../../../shared/src/spec.js';
import type { Job, JobItem } from '../../../shared/src/api.js';

/** One photo of an export: where it is, and its own look (a saved preset's slug) and crop. */
export type RenderJobItem = ItemSpec & { path: string; look?: string | null };

/** Where an export writes: the one-off override, else the preset's own folder, else <export root>/<preset slug>. */
export function destinationFor(preset: ExportPreset, override?: string): string {
  const explicit = override || preset.destination;
  return explicit ? path.resolve(explicit) : path.join(getSettings().exportRoot, preset.slug);
}

/**
 * Batch export. Every item carries its own look, adjustments and crop (its sidecar state); the export preset
 * decides size/format/quality/metadata/destination/naming for all of them. Parallel with p-limit, one exiftool
 * metadata copy per output. Names are made unique against what is already in the destination folder, so
 * re-running never overwrites earlier exports.
 */
export async function startRenderJob(items: RenderJobItem[], preset: ExportPreset, destinationOverride?: string): Promise<Job> {
  // Resolve looks up front so the job can fail fast on an unknown slug.
  const lookCache = new Map<string, Look>();
  for (const it of items) if (it.look) await resolveLook(it.look, undefined, lookCache);
  const dest = destinationFor(preset, destinationOverride);
  const jobItems: JobItem[] = items.map((it) => ({ src: it.path, status: 'pending' }));
  const looksUsed = [...new Set(items.map((it) => it.look ?? ''))];
  const title = `Export ${items.length} × ${preset.name}${looksUsed.length === 1 && looksUsed[0] ? ` · ${looksUsed[0]}` : ''}`;

  return jobs.create('render', title, jobItems, { export: preset.slug, dest, dests: [dest] }, async (h) => {
    const settings = getSettings();
    await mkdir(dest, { recursive: true });
    const taken = await takenStems(dest);
    h.log(`destination: ${dest}`);
    h.log(`export: ${preset.name} — ${preset.longEdge ? `${preset.longEdge}px` : 'original size'} ${preset.format} q${preset.quality}, ${preset.metadata}`);
    const limit = pLimit(Math.max(1, settings.concurrency));
    const ext = extensionFor(preset.format);

    await Promise.all(
      items.map((item, i) =>
        limit(async () => {
          if (h.cancelled) {
            h.itemSkip(i, 'cancelled');
            return;
          }
          h.itemStart(i);
          try {
            const file = item.path;
            const kind = mediaKind(path.basename(file));
            if (!isRenderable(kind)) {
              h.itemSkip(i, `unsupported (${kind})`);
              return;
            }
            const look = await resolveLook(item.look, item.adjust, lookCache);
            const src = await openSource(file);
            const { crop, ratio } = await resolveItemCrop(file, item);
            const result = await renderImage(src, { look, crop, ratio, longEdge: preset.longEdge, format: preset.format, quality: preset.quality });
            const stem = expandTemplate(preset.naming, {
              stem: splitName(path.basename(file)).stem,
              capturedAt: src.meta.capturedAt,
              export: preset.slug,
              look: item.look ?? '',
              seq: i + 1,
            });
            const finalStem = uniqueStem(stem, taken);
            const dst = path.join(dest, `${finalStem}${ext}`);
            await writeFile(dst, result.data);
            try {
              await copyMetadata(file, dst, preset.metadata);
            } catch (err) {
              h.log(`metadata copy failed for ${path.basename(dst)}: ${(err as Error).message}`);
            }
            const long = Math.max(result.cropped.width, result.cropped.height);
            const below = preset.longEdge > 0 && long < preset.longEdge;
            const notes = [`${result.width}×${result.height}`];
            if (item.aspect && item.aspect !== 'original') notes.push(`crop ${item.aspect}`);
            if (below) notes.push('below target size — no upscaling yet');
            if (src.note) notes.push(src.note);
            h.itemDone(i, { dst, note: notes.join(' · ') });
          } catch (err) {
            h.itemFail(i, (err as Error).message);
          }
        }),
      ),
    );
    h.log(`finished: ${h.job.done} ok, ${h.job.failed} failed, ${h.job.skipped} skipped`);
  });
}
