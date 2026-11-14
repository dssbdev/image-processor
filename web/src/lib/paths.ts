/** Path helpers for the browser, where there is no `node:path`. Both separators are accepted. */

/** "C:\photos\IMG_1.jpg" → "IMG_1.jpg" */
export function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** "C:\photos\IMG_1.jpg" → "C:\photos" ('' for a bare name). */
export function dirOf(path: string): string {
  return path.slice(0, Math.max(0, path.length - baseNameOf(path).length - 1));
}

/** The name without its extension, lower-cased: what makes IMG_1.JPG and img_1.dng the same shot. */
export function stemKey(path: string): string {
  return baseNameOf(path).replace(/\.[^.]+$/, '').toLowerCase();
}

/** How many shots are in `paths` more than once under different extensions (a JPG and its DNG). */
export function countTwins(paths: string[]): number {
  const perStem = new Map<string, number>();
  for (const p of paths) perStem.set(stemKey(p), (perStem.get(stemKey(p)) ?? 0) + 1);
  return [...perStem.values()].filter((n) => n > 1).length;
}

/** "IMG_1.jpg" → "JPG" */
export function extLabel(path: string): string {
  return (baseNameOf(path).split('.').pop() ?? '').toUpperCase();
}
