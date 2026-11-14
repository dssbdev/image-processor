import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocalPoint } from '../../../shared/src/api.js';
import { computeCropRect, toNormRect, type NormRect } from '../../../shared/src/crop.js';
import type { Gravity } from '../../../shared/src/spec.js';
import { api } from '../api.js';
import { cx } from './ui.js';

/**
 * The uncropped photo with the crop window drawn on it. Drag the window (or the photo) to move it;
 * click outside to jump there. Geometry is the shared `computeCropRect`, so the server produces the
 * same window from the same focal point.
 */
export function FramingCanvas({
  path,
  sourceWidth,
  sourceHeight,
  ratio,
  gravity,
  focal,
  serverCrop,
  onFocal,
  className,
  compact = false,
}: {
  path: string;
  sourceWidth: number;
  sourceHeight: number;
  /** null = no crop (original ratio). */
  ratio: number | null;
  gravity: Gravity;
  focal: FocalPoint | null;
  /** The crop the server chose (smart gravities) when there is no focal point yet. */
  serverCrop?: NormRect | null;
  onFocal: (f: FocalPoint | null) => void;
  className?: string;
  compact?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; startFocal: FocalPoint } | null>(null);
  const [liveFocal, setLiveFocal] = useState<FocalPoint | null>(null);

  const effectiveFocal = liveFocal ?? focal;
  let crop: NormRect | null = null;
  if (ratio && sourceWidth > 0 && sourceHeight > 0) {
    if (effectiveFocal) crop = toNormRect(computeCropRect(sourceWidth, sourceHeight, ratio, gravity, effectiveFocal), sourceWidth, sourceHeight);
    else if (serverCrop) crop = serverCrop;
    else crop = toNormRect(computeCropRect(sourceWidth, sourceHeight, ratio, gravity), sourceWidth, sourceHeight);
  }
  const center = (c: NormRect): FocalPoint => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });

  const rel = useCallback((e: { clientX: number; clientY: number }) => {
    const box = boxRef.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!crop) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = rel(e);
    const inside = p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;
    const startFocal = inside ? center(crop) : { x: p.x, y: p.y };
    if (!inside) setLiveFocal(startFocal);
    setDrag({ startX: p.x, startY: p.y, startFocal });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !crop) return;
    const p = rel(e);
    setLiveFocal({
      x: Math.min(1, Math.max(0, drag.startFocal.x + (p.x - drag.startX))),
      y: Math.min(1, Math.max(0, drag.startFocal.y + (p.y - drag.startY))),
    });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const f = liveFocal ?? drag.startFocal;
    setDrag(null);
    setLiveFocal(null);
    onFocal(f);
  };

  useEffect(() => setLiveFocal(null), [path]);

  // Fit the photo box inside whatever space the parent gives us (exact px, so overlays line up).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ar = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 4 / 3;
    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight || cw / ar;
      let w = cw;
      let h = w / ar;
      if (h > ch) {
        h = ch;
        w = h * ar;
      }
      setFit({ w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sourceWidth, sourceHeight]);

  return (
    <div ref={wrapRef} className={cx('flex h-full w-full select-none flex-col items-center justify-center', className)}>
      <div
        ref={boxRef}
        className={cx('relative overflow-hidden rounded-xl bg-shade', crop ? 'cursor-grab active:cursor-grabbing' : '')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={fit ? { width: fit.w, height: fit.h } : { width: '100%', aspectRatio: sourceWidth && sourceHeight ? `${sourceWidth} / ${sourceHeight}` : undefined }}
      >
        <img src={api.proxyUrl(path)} alt="" className="block h-full w-full object-contain" draggable={false} />
        {crop && (
          <>
            <div className="pointer-events-none absolute inset-0 bg-scrim" />
            <div
              className="pointer-events-none absolute overflow-hidden ring-1 ring-white/90"
              style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
            >
              <img
                src={api.proxyUrl(path)}
                alt=""
                aria-hidden
                draggable={false}
                className="pointer-events-none absolute max-w-none"
                style={{ width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%` }}
              />
              {!compact && (
                <>
                  <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                  <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                  <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                  <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                </>
              )}
            </div>
          </>
        )}
      </div>
      {!compact && (
        <div className="mt-2 flex w-full items-center justify-between text-caption text-ink-2" style={fit ? { maxWidth: fit.w } : undefined}>
          <span>{crop ? 'Drag the frame, or click where the subject is.' : 'No crop on this photo.'}</span>
          {focal && (
            <button className="text-info hover:underline" onClick={() => onFocal(null)}>
              Back to the automatic position
            </button>
          )}
        </div>
      )}
    </div>
  );
}
