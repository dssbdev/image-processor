import { copyFile, mkdir, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { getSettings, PATHS } from '../config.js';
import { writeJson } from '../fs/util.js';
import { jobs } from '../jobs/queue.js';
import { fileHash, hashVerifies } from './hash.js';
import type { ImportPlan, Job, JobItem } from '../../../shared/src/api.js';

/**
 * Execute an import plan: copy (never move) each 'copy' item to its destination, verify by size and —
 * for photos, or everything when importVerify = 'all' — by content hash, keep the source mtime,
 * and write the manifest next to the job history. Files that appeared at the destination since the
 * plan was made are not overwritten: the item fails and says so.
 */
export function startImportJob(plan: ImportPlan): Job {
  const settings = getSettings();
  const todo = plan.items.filter((i) => i.action === 'copy');
  const items: JobItem[] = todo.map((i) => ({ src: i.src, dst: i.dst, status: 'pending' }));
  const title = `Import ${todo.length} files from ${plan.source}`;
  return jobs.create('import', title, items, { source: plan.source, archiveRoot: plan.archiveRoot }, async (h) => {
    const limit = pLimit(Math.max(1, Math.min(4, settings.concurrency)));
    let bytes = 0;
    await Promise.all(
      todo.map((item, i) =>
        limit(async () => {
          if (h.cancelled) {
            h.itemSkip(i, 'cancelled');
            return;
          }
          h.itemStart(i);
          try {
            if (existsSync(item.dst)) throw new Error('destination appeared after planning; not overwriting');
            await mkdir(path.dirname(item.dst), { recursive: true });
            await copyFile(item.src, item.dst);
            const [s1, s2] = await Promise.all([stat(item.src), stat(item.dst)]);
            if (s1.size !== s2.size) throw new Error(`size mismatch after copy (${s1.size} vs ${s2.size})`);
            const verifyHash = hashVerifies(settings.importVerify, item.kind);
            if (verifyHash) {
              const [h1, h2] = await Promise.all([fileHash(item.src), fileHash(item.dst)]);
              if (h1 !== h2) throw new Error('hash mismatch after copy');
            }
            await utimes(item.dst, s1.atime, s1.mtime).catch(() => undefined);
            bytes += s1.size;
            h.itemDone(i, { note: verifyHash ? 'verified (hash)' : 'verified (size)' });
          } catch (err) {
            h.itemFail(i, (err as Error).message);
          }
        }),
      ),
    );
    h.log(`copied ${(bytes / 1e6).toFixed(1)} MB: ${h.job.done} ok, ${h.job.failed} failed, ${h.job.skipped} skipped`);
    try {
      await mkdir(PATHS.jobs, { recursive: true });
      await writeJson(path.join(PATHS.jobs, `${h.job.id}.manifest.json`), { job: h.job.id, plan, finishedAt: new Date().toISOString(), items: h.job.items });
    } catch (err) {
      h.log(`manifest write failed: ${(err as Error).message}`);
    }
  });
}
