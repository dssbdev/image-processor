/** File-name helpers shared by export naming and ingest naming. Pure string/date math. */

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** YYYYMMDD in local time. */
export function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}

/** HHMMSS in local time. */
export function timeStamp(d: Date): string {
  return `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`;
}

/** YYYY-MM-DD in local time. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Characters Windows and macOS refuse in file names, plus control chars, collapsed to '_'. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || 'file';
}

export interface NamingContext {
  stem: string;
  capturedAt: Date;
  /** Export preset slug. */
  export: string;
  /** Look preset slug ('' when none). */
  look?: string;
  seq: number;
}

/**
 * Expand an export naming template. Tokens: {stem} {date} {time} {export} {look} {seq}
 * ({profile} is accepted as an alias of {export} for old templates).
 * Unknown tokens are left as-is (then sanitized). Result has no extension.
 */
export function expandTemplate(template: string, ctx: NamingContext): string {
  const out = template
    .replace(/\{stem\}/g, ctx.stem)
    .replace(/\{date\}/g, dateStamp(ctx.capturedAt))
    .replace(/\{time\}/g, timeStamp(ctx.capturedAt))
    .replace(/\{export\}/g, ctx.export)
    .replace(/\{profile\}/g, ctx.export)
    .replace(/\{look\}/g, ctx.look ?? '')
    .replace(/\{seq\}/g, pad(ctx.seq, 3));
  return sanitizeFileName(out);
}

/** Split "IMG_0001.DNG" → { stem: "IMG_0001", ext: ".dng" }. */
export function splitName(fileName: string): { stem: string; ext: string } {
  const i = fileName.lastIndexOf('.');
  if (i <= 0) return { stem: fileName, ext: '' };
  return { stem: fileName.slice(0, i), ext: fileName.slice(i).toLowerCase() };
}

/** Archive folder for a capture date: "YYYY/YYYY-MM-DD" (posix separators; join with the platform later). */
export function archiveSubdir(d: Date): [string, string] {
  return [String(d.getFullYear()), isoDate(d)];
}

/** Ingest stem for a capture time: "YYYYMMDD-HHMMSS". Collisions get "-2", "-3", … via `uniqueStem`. */
export function ingestStem(d: Date): string {
  return `${dateStamp(d)}-${timeStamp(d)}`;
}

/**
 * Make `stem` unique against a set of stems already taken (case-insensitive), by appending -2, -3, …
 * Registers the chosen stem in the set.
 */
export function uniqueStem(stem: string, taken: Set<string>): string {
  let candidate = stem;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${stem}-${n}`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}
