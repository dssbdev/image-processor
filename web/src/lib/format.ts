/** Words and numbers as the pages print them. Everything here is a pure function of its arguments (and the clock). */

type Moment = number | string | Date;

/** "1 photo", "12 photos" (thousands separated). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Aug 6, 2026" */
export function fmtDay(t: Moment): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "10:58" */
export function fmtClock(t: Moment): string {
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "just now", "5 min ago", "2 h ago", "3 days ago", then the date. */
export function timeAgo(t: Moment): string {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d < 30 ? `${plural(d, 'day')} ago` : fmtDay(t);
}

/** "1.4 s", "2 min 5 s" */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** "812 B", "3 KB", "4.2 MB", "1.07 GB" */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A camera as people name it: "Make Model", without the makes the settings ask to leave out. */
export function cameraName(make: string | undefined, model: string | undefined, hiddenMakes: string[] = []): string {
  const hidden = make !== undefined && hiddenMakes.some((h) => h.toLowerCase() === make.toLowerCase());
  return [hidden ? undefined : make, model].filter(Boolean).join(' ');
}
