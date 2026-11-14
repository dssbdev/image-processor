import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSettings, DATA_DIR } from '../config.js';
import { httpError } from '../http.js';
import { mediaKind } from '../../../shared/src/pairing.js';
import type { FsEntry, FsListing, QuickRoot } from '../../../shared/src/api.js';
import { exists, requireDirectory } from './util.js';

/** Folders an OS puts on every drive; never worth listing or importing from. Lower-case. */
export const SYSTEM_DIRS = ['$recycle.bin', 'system volume information', '.trashes', '.spotlight-v100'];

const HIDDEN_DIRS = new Set([...SYSTEM_DIRS, 'node_modules', '.git']);

/** Dot files and macOS resource forks ("._name") are never shown or imported. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/** A path as typed by the user → absolute. Accepts "~" and a bare drive letter ("C:"). */
export function normalizeUserPath(input: string): string {
  let p = input.trim();
  if (!p) throw httpError(400, 'path is required');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(p)) p += '\\';
  return path.resolve(p);
}

export async function listDir(input: string): Promise<FsListing> {
  const dir = normalizeUserPath(input);
  await requireDirectory(dir);
  const dirs: FsEntry[] = [];
  const files: FsEntry[] = [];
  let skipped = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const { name } = entry;
    const full = path.join(dir, name);
    const kind = entry.isDirectory() ? 'dir' : entry.isFile() ? mediaKind(name) : 'other';
    if (isHiddenName(name) || kind === 'other' || (kind === 'dir' && HIDDEN_DIRS.has(name.toLowerCase()))) {
      skipped++;
    } else if (kind === 'dir') {
      dirs.push({ name, path: full, kind });
    } else {
      const st = await stat(full).catch(() => null);
      files.push({ name, path: full, kind, size: st?.size, mtimeMs: st?.mtimeMs });
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const byName = (a: FsEntry, b: FsEntry) => collator.compare(a.name, b.name);
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs: dirs.sort(byName), files: files.sort(byName), skipped };
}

/** Starting points for the folder picker: the app's own folders, the home folders, and every drive or mount. */
export async function quickRoots(): Promise<QuickRoot[]> {
  const settings = getSettings();
  const home = os.homedir();
  const root = (label: string, target: string): QuickRoot => ({ label, path: target });
  const existing = async (roots: QuickRoot[]) => {
    const found: QuickRoot[] = [];
    for (const r of roots) if (await exists(r.path)) found.push(r);
    return found;
  };

  const homeFolders = await existing(['Pictures', 'Desktop', 'Downloads'].map((name) => root(name, path.join(home, name))));
  const volumes =
    process.platform === 'win32'
      ? await existing([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => root(`${letter}:`, `${letter}:\\`)))
      : [root('/', '/'), ...(await existing(['/media', '/mnt', '/Volumes'].map((mount) => root(mount, mount)))), root('data', DATA_DIR)];
  return [root('Archive', settings.archiveRoot), root('Export', settings.exportRoot), root('Home', home), ...homeFolders, ...volumes];
}
