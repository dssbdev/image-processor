import { splitName } from './naming.js';

export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.gif']);
export const HEIC_EXTS = new Set(['.heic', '.heif', '.hif']);
export const RAW_EXTS = new Set(['.dng']);
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.insv', '.insp', '.lrv', '.m4v']);

export type MediaKind = 'photo' | 'heic' | 'raw' | 'video' | 'other';

export function mediaKind(fileName: string): MediaKind {
  const { ext } = splitName(fileName);
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (HEIC_EXTS.has(ext)) return 'heic';
  if (RAW_EXTS.has(ext)) return 'raw';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

/**
 * Kinds the pipeline can turn into pixels, and therefore show as thumbnails, preview and export.
 * RAW goes through a RAW engine when one is available, else its embedded preview.
 */
export function isRenderable(kind: MediaKind | 'dir'): boolean {
  return kind === 'photo' || kind === 'heic' || kind === 'raw';
}

/**
 * Sidecar key: files that belong together share it. Cameras write X.jpg + X.dng pairs and companion
 * files next to a shot; "same folder + same stem" is one group. Case-insensitive.
 */
export function groupKey(dir: string, fileName: string): string {
  return `${dir.toLowerCase()}::${splitName(fileName).stem.toLowerCase()}`;
}

export interface Grouped<T> {
  key: string;
  members: T[];
}

/** Group items by `groupKey`, preserving first-seen order. */
export function groupBySidecar<T>(items: T[], getDirAndName: (t: T) => { dir: string; name: string }): Grouped<T>[] {
  const map = new Map<string, Grouped<T>>();
  for (const item of items) {
    const { dir, name } = getDirAndName(item);
    const key = groupKey(dir, name);
    let g = map.get(key);
    if (!g) {
      g = { key, members: [] };
      map.set(key, g);
    }
    g.members.push(item);
  }
  return [...map.values()];
}
