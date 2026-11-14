import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { getSettings } from '../config.js';
import { SYSTEM_DIRS, isHiddenName, normalizeUserPath } from '../fs/list.js';
import { requireDirectory, takenStems } from '../fs/util.js';
import { httpError } from '../http.js';
import { readSourceMeta } from '../meta/exif.js';
import { archiveSubdir, ingestStem, splitName, uniqueStem, isoDate } from '../../../shared/src/naming.js';
import { groupBySidecar, mediaKind } from '../../../shared/src/pairing.js';
import type { ImportPlan, ImportPlanItem, Settings } from '../../../shared/src/api.js';
import { fileHash, hashVerifies } from './hash.js';

/** Folders on a card that hold no originals: OS folders and the camera's own thumbnail folders. Lower-case. */
const SKIP_DIRS = new Set([...SYSTEM_DIRS, 'misc', 'thumb', 'thumbnails']);
const MAX_FILES = 20_000;
const MAX_DEPTH = 8;

interface Found {
  src: string;
  dir: string;
  name: string;
  size: number;
  mtimeMs: number;
}

async function walk(root: string, out: Found[], depth = 0): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (isHiddenName(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      await walk(full, out, depth + 1);
    } else if (e.isFile()) {
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      out.push({ src: full, dir: root, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * Dry run: what an import would do. Groups sidecars (X.jpg + X.dng) so they get one stem, names by
 * capture time, detects files that already exist in the archive (same size → same content hash).
 */
export async function planImport(sourceInput: string): Promise<ImportPlan> {
  const settings = getSettings();
  const source = normalizeUserPath(sourceInput);
  await requireDirectory(source);
  const archiveRoot = settings.archiveRoot;
  const warnings: string[] = [];
  if (isInside(source, archiveRoot)) throw httpError(400, 'source is inside the archive; pick the card or another folder');

  const found: Found[] = [];
  await walk(source, found);
  if (found.length >= MAX_FILES) warnings.push(`stopped scanning at ${MAX_FILES} files`);

  // Capture dates in parallel (exiftool pool handles the fan-in).
  const limit = pLimit(8);
  const metas = await Promise.all(
    found.map((f) =>
      limit(async () => {
        const kind = mediaKind(f.name);
        if (kind === 'other') return null;
        try {
          return await readSourceMeta(f.src);
        } catch {
          return null;
        }
      }),
    ),
  );

  const groups = groupBySidecar(
    found.map((f, i) => ({ f, meta: metas[i] })),
    (x) => ({ dir: x.f.dir, name: x.f.name }),
  );

  const items: ImportPlanItem[] = [];
  const takenByDay = new Map<string, Set<string>>();
  const byKind: Record<string, number> = {};
  const days = new Set<string>();

  for (const g of groups) {
    // One capture time per group: the earliest EXIF date among members, else earliest mtime.
    const exifTimes = g.members.flatMap((m) => (m.meta?.dateSource === 'exif' ? [m.meta.capturedAt.getTime()] : []));
    const dateSource: 'exif' | 'mtime' = exifTimes.length ? 'exif' : 'mtime';
    const capturedAt = new Date(Math.min(...(exifTimes.length ? exifTimes : g.members.map((m) => m.f.mtimeMs))));
    const [year, day] = archiveSubdir(capturedAt);
    const dayDir = path.join(archiveRoot, year, day);
    const taken = takenByDay.get(dayDir) ?? (await takenStems(dayDir));
    takenByDay.set(dayDir, taken);
    // Members that already exist in the archive keep the group from consuming a new stem.
    let stem: string | null = null;
    for (const m of g.members) {
      const kind = mediaKind(m.f.name);
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      const base: Omit<ImportPlanItem, 'dst' | 'action'> = {
        src: m.f.src,
        size: m.f.size,
        kind,
        capturedAt: capturedAt.toISOString(),
        dateSource,
        group: g.key,
      };
      if (kind === 'other') {
        items.push({ ...base, dst: '', action: 'skip-unsupported', reason: 'unknown file type' });
        continue;
      }
      const ext = splitName(m.f.name).ext || '';
      const existing = await findExisting(dayDir, m.f, ext, settings.importVerify);
      if (existing) {
        items.push({ ...base, dst: existing, action: 'skip-exists', reason: 'identical file already in the archive' });
        continue;
      }
      if (!stem) stem = uniqueStem(ingestStem(capturedAt), taken);
      items.push({ ...base, dst: path.join(dayDir, `${stem}${ext}`), action: 'copy' });
      days.add(isoDate(capturedAt));
    }
  }

  const copy = items.filter((i) => i.action === 'copy');
  return {
    source,
    archiveRoot,
    createdAt: new Date().toISOString(),
    items,
    totals: {
      files: items.length,
      bytes: items.reduce((a, b) => a + b.size, 0),
      copy: copy.length,
      copyBytes: copy.reduce((a, b) => a + b.size, 0),
      skipExists: items.filter((i) => i.action === 'skip-exists').length,
      skipUnsupported: items.filter((i) => i.action === 'skip-unsupported').length,
      byKind,
      days: [...days].sort(),
    },
    warnings,
  };
}

/** True when `child` is `parent` or somewhere below it (case-insensitive on Windows). */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);
}

/**
 * Same-content detection: a file in the day folder with the same extension and size, and (for photos, or
 * everything when importVerify = 'all') the same xxhash64. Cheap first, expensive only on size match.
 */
async function findExisting(dayDir: string, f: Found, ext: string, verify: Settings['importVerify']): Promise<string | null> {
  const candidates = (await readdir(dayDir).catch(() => [] as string[])).filter((n) => splitName(n).ext === ext);
  const wantHash = hashVerifies(verify, mediaKind(f.name));
  let srcHash: string | null = null;
  for (const c of candidates) {
    const full = path.join(dayDir, c);
    const st = await stat(full).catch(() => null);
    if (!st || st.size !== f.size) continue;
    if (!wantHash) return full;
    srcHash ??= await fileHash(f.src);
    if ((await fileHash(full)) === srcHash) return full;
  }
  return null;
}
