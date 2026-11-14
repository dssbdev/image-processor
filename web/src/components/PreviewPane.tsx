import { useEffect, useRef, useState } from 'react';
import { fetchPreview, type PreviewArgs, type PreviewResult } from '../api.js';
import { Spinner, cx } from './ui.js';

/** What to render: everything but the path (look, adjustments, crop). */
export type PreviewSpec = Omit<PreviewArgs, 'path' | 'maxEdge' | 'mode'>;

/**
 * Before/after preview rendered by the server through the real pipeline (same crop, same resize).
 * Debounced on spec changes; previous requests are aborted. Drag the divider or hold to compare.
 */
export function PreviewPane({
  path,
  spec,
  maxEdge = 1400,
  onResult,
  className,
  compact = false,
}: {
  path: string | null;
  spec: PreviewSpec | null;
  maxEdge?: number;
  onResult?: (r: PreviewResult | null) => void;
  className?: string;
  compact?: boolean;
}) {
  const [after, setAfter] = useState<PreviewResult | null>(null);
  const [before, setBefore] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(100);
  const [holdBefore, setHoldBefore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const key = JSON.stringify(spec);

  useEffect(() => {
    if (!path || !spec) {
      setAfter(null);
      setBefore(null);
      setError(null);
      onResult?.(null);
      return;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      setBusy(true);
      setError(null);
      Promise.all([
        fetchPreview({ path, ...spec, maxEdge, mode: 'after' }, ctl.signal),
        fetchPreview({ path, ...spec, maxEdge, mode: 'before' }, ctl.signal),
      ])
        .then(([a, b]) => {
          if (ctl.signal.aborted) return;
          onResult?.(a);
          setAfter((prev) => {
            if (prev) URL.revokeObjectURL(prev.url);
            return a;
          });
          setBefore((prev) => {
            if (prev) URL.revokeObjectURL(prev.url);
            return b;
          });
        })
        .catch((err: Error) => {
          if (ctl.signal.aborted) return;
          setError(err.message);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setBusy(false);
        });
    }, 160);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, maxEdge]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const showBeforePct = holdBefore ? 0 : split;

  return (
    <div className={cx('flex h-full min-h-0 flex-col', className)}>
      <div className="checker relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl ring-1 ring-inset ring-line">
        {!path && <div className="text-body text-ink-2">Select a photo to preview</div>}
        {path && !after && !error && (
          <div className="flex items-center gap-2 text-body text-ink-2">
            <Spinner /> rendering…
          </div>
        )}
        {error && <div className="max-w-sm p-4 text-center text-body text-bad">{error}</div>}
        {after && (
          <div className="relative flex max-h-full max-w-full items-center justify-center" style={{ aspectRatio: `${after.width} / ${after.height}` }}>
            <img src={after.url} alt="after" className="block max-h-full max-w-full select-none object-contain" draggable={false} />
            {before && (
              <img
                src={before.url}
                alt="before"
                draggable={false}
                className="absolute inset-0 h-full w-full select-none object-contain"
                style={{ clipPath: `inset(0 ${showBeforePct}% 0 0)` }}
              />
            )}
            {before && showBeforePct > 0 && showBeforePct < 100 && (
              <div className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: `${100 - showBeforePct}%` }} />
            )}
            {busy && (
              <div className="absolute top-2 right-2 rounded-lg bg-scrim px-2 py-1 backdrop-blur">
                <Spinner />
              </div>
            )}
            <div className="pointer-events-none absolute top-2 left-2 rounded-md bg-scrim px-1.5 py-0.5 text-micro text-ink-0 backdrop-blur">
              {showBeforePct < 100 ? 'before' : 'after'} · {after.width}×{after.height}
            </div>
          </div>
        )}
      </div>
      {after && !compact && (
        <div className="mt-2 flex items-center gap-3 text-caption text-ink-2">
          <span>before</span>
          <input type="range" className="plain flex-1" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} title="Drag to compare" />
          <span>after</span>
          <button
            type="button"
            className="rounded-lg bg-fill-1 px-2 py-0.5 whitespace-nowrap text-ink-1 ring-1 ring-edge ring-inset hover:bg-fill-2 hover:text-ink-0"
            onMouseDown={() => setHoldBefore(true)}
            onMouseUp={() => setHoldBefore(false)}
            onMouseLeave={() => setHoldBefore(false)}
            onTouchStart={() => setHoldBefore(true)}
            onTouchEnd={() => setHoldBefore(false)}
          >
            Hold for before
          </button>
        </div>
      )}
    </div>
  );
}
