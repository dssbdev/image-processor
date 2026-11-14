import { stat } from 'node:fs/promises';
import path from 'node:path';
import { FOLDER_EDITS_VERSION, ImageEditSchema, isEmptyEdit, migrateFolderEdits, type FolderEdits, type ImageEdit, type ImageEditPatch } from '../../../shared/src/edits.js';
import { readJson, writeJson } from '../fs/util.js';

/**
 * Per-folder sidecar: <dir>/.image-processor.json — { version, edits: { [fileName]: ImageEdit } }.
 * Small in-memory cache keyed by folder, invalidated by the file's mtime, so the gallery can hit it often.
 */
export const SIDECAR = '.image-processor.json';

/** A sidecar patch: file name → merge this in, or `null` to drop the entry. */
type FolderPatch = Record<string, ImageEditPatch | null>;

interface CacheEntry {
  mtimeMs: number;
  data: FolderEdits;
}
const cache = new Map<string, CacheEntry>();

const sidecarPath = (dir: string) => path.join(dir, SIDECAR);
const noEdits = (): FolderEdits => ({ version: FOLDER_EDITS_VERSION, edits: {} });

export async function readFolderEdits(dir: string): Promise<FolderEdits> {
  const file = sidecarPath(dir);
  const st = await stat(file).catch(() => null);
  if (!st) {
    cache.delete(dir);
    return noEdits();
  }
  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  try {
    // v1 (profile-based) sidecars are migrated in memory; the next write persists the v2 shape.
    const data = migrateFolderEdits(await readJson(file));
    cache.set(dir, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch (err) {
    console.warn(`[edits] unreadable sidecar in ${dir}: ${(err as Error).message}`);
    return noEdits();
  }
}

async function writeFolderEdits(dir: string, data: FolderEdits): Promise<void> {
  const file = sidecarPath(dir);
  await writeJson(file, data);
  cache.set(dir, { mtimeMs: (await stat(file)).mtimeMs, data });
}

/** `patch` over `prev`: `undefined` leaves a key alone, `null` removes it, anything else replaces it. */
function mergeKeys<T>(prev: Record<string, T>, patch: Record<string, T | null | undefined>): Record<string, T> {
  const next = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** One photo's edit after a patch. `adjust` merges slider by slider, so nudging one keeps the others. */
function mergeEdit(prev: ImageEdit, patch: ImageEditPatch, updatedAt: string): ImageEdit {
  const { adjust, ...fields } = patch;
  const merged: Record<string, unknown> = { ...mergeKeys<unknown>(prev, fields), updatedAt };
  if (adjust === null) delete merged.adjust;
  else if (adjust) {
    const sliders = mergeKeys<number>(prev.adjust ?? {}, adjust);
    if (Object.keys(sliders).length) merged.adjust = sliders;
    else delete merged.adjust;
  }
  return ImageEditSchema.parse(merged);
}

/**
 * Merge a patch into a folder's sidecar. `null` deletes an entry; partial objects are merged into the
 * existing edit (so setting `star` does not drop `focal`); inside `adjust`, `null` removes one slider. Empty edits are pruned.
 */
export async function patchFolderEdits(dir: string, patch: FolderPatch): Promise<FolderEdits> {
  const edits = { ...(await readFolderEdits(dir)).edits };
  const now = new Date().toISOString();
  for (const [name, change] of Object.entries(patch)) {
    const edit = change && mergeEdit(edits[name] ?? {}, change, now);
    if (!edit || isEmptyEdit(edit)) delete edits[name];
    else edits[name] = edit;
  }
  const next: FolderEdits = { version: FOLDER_EDITS_VERSION, edits };
  await writeFolderEdits(dir, next);
  return next;
}

export async function getEdit(file: string): Promise<ImageEdit | undefined> {
  return (await readFolderEdits(path.dirname(file))).edits[path.basename(file)];
}

/** Patches for files in any number of folders, collected per folder and applied one sidecar write each. */
class PatchesByFolder {
  private byDir = new Map<string, FolderPatch>();

  set(file: string, change: ImageEditPatch | null): void {
    const dir = path.dirname(file);
    const patch = this.byDir.get(dir) ?? {};
    patch[path.basename(file)] = change;
    this.byDir.set(dir, patch);
  }

  async apply(): Promise<void> {
    for (const [dir, patch] of this.byDir) await patchFolderEdits(dir, patch);
  }
}

/** Forget the sidecar entries of files that are gone. */
export async function dropEdits(files: string[]): Promise<void> {
  const patches = new PatchesByFolder();
  for (const file of files) patches.set(file, null);
  await patches.apply();
}

/** Carry sidecar entries along when files move between folders. */
export async function transferEdits(files: { from: string; to: string }[]): Promise<void> {
  const patches = new PatchesByFolder();
  for (const { from, to } of files) {
    if (path.dirname(from) === path.dirname(to)) continue;
    const edit = await getEdit(from);
    if (!edit) continue;
    patches.set(from, null);
    patches.set(to, edit);
  }
  await patches.apply();
}
