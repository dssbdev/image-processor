import type { FastifyInstance } from 'fastify';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import trash from 'trash';
import { z } from 'zod';
import { normalizeUserPath } from '../fs/list.js';
import { exists } from '../fs/util.js';
import { dropEdits, patchFolderEdits, readFolderEdits, transferEdits } from '../store/edits.js';
import { ImageEditPatchSchema } from '../../../shared/src/edits.js';
import type { FsOpResult } from '../../../shared/src/api.js';

const Paths = z.array(z.string().min(1)).min(1).max(5000);
const PathsBody = z.object({ paths: Paths });
const MoveBody = z.object({ paths: Paths, dest: z.string().min(1) });
const OpenBody = z.object({ path: z.string().min(1) });
const EditsQuery = z.object({ dir: z.string().min(1) });
const EditsBody = z.object({
  dir: z.string().min(1),
  patch: z.record(z.string(), ImageEditPatchSchema.nullable()),
});

/** Run `op` on every path; one failing file never stops the rest. `op` returns the path to report as done. */
async function forEachPath(paths: string[], op: (file: string) => Promise<string>): Promise<FsOpResult> {
  const result: FsOpResult = { ok: [], failed: [] };
  for (const file of paths.map(normalizeUserPath)) {
    try {
      result.ok.push(await op(file));
    } catch (err) {
      result.failed.push({ path: file, error: (err as Error).message });
    }
  }
  return result;
}

/** Rename, or copy then delete when source and destination are on different drives. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/** Show a file or folder in the OS file manager: a folder opens, a file is selected inside its folder. */
async function revealInFileManager(target: string): Promise<void> {
  const isDir = (await stat(target)).isDirectory();
  const run = (cmd: string, args: string[]) => execa(cmd, args, { reject: false, windowsHide: true, timeout: 10_000, detached: process.platform === 'linux' });
  if (process.platform === 'win32') await run('explorer.exe', isDir ? [target] : ['/select,', target]);
  else if (process.platform === 'darwin') await run('open', isDir ? [target] : ['-R', target]);
  else await run('xdg-open', [isDir ? target : path.dirname(target)]);
}

/**
 * File operations the gallery needs: per-folder edits sidecar, move, trash (recycle bin), and
 * "open this folder in the file manager" — the one thing a browser tab cannot do by itself.
 */
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/edits', async (req) => {
    const { dir } = EditsQuery.parse(req.query);
    return readFolderEdits(normalizeUserPath(dir));
  });

  app.put('/api/edits', async (req) => {
    const { dir, patch } = EditsBody.parse(req.body);
    return patchFolderEdits(normalizeUserPath(dir), patch);
  });

  app.post('/api/fs/trash', async (req): Promise<FsOpResult> => {
    const { paths } = PathsBody.parse(req.body);
    const result = await forEachPath(paths, async (file) => {
      await stat(file);
      await trash([file]);
      return file;
    });
    await dropEdits(result.ok).catch(() => undefined);
    return result;
  });

  app.post('/api/fs/move', async (req): Promise<FsOpResult> => {
    const { paths, dest } = MoveBody.parse(req.body);
    const destDir = normalizeUserPath(dest);
    await mkdir(destDir, { recursive: true });
    const moved: { from: string; to: string }[] = [];
    const result = await forEachPath(paths, async (from) => {
      const to = path.join(destDir, path.basename(from));
      if (from === to) return to;
      if (await exists(to)) throw new Error('a file with that name already exists in the destination');
      await moveFile(from, to);
      moved.push({ from, to });
      return to;
    });
    await transferEdits(moved).catch(() => undefined);
    return result;
  });

  app.post('/api/os/open', async (req) => {
    const target = normalizeUserPath(OpenBody.parse(req.body).path);
    await revealInFileManager(target);
    return { ok: true, path: target };
  });
}
