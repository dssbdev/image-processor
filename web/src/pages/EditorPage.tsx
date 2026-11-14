import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, Copy, Crop, Eye, SkipForward, SlidersHorizontal, Star, Upload, Wand2, X } from 'lucide-react';
import type { ImageInfo } from '../../../shared/src/api.js';
import { aspectToRatio } from '../../../shared/src/crop.js';
import { effectiveLook, type ImageEditPatch } from '../../../shared/src/edits.js';
import { IDENTITY_LOOK, LOOK_CONTROLS, type LookKey } from '../../../shared/src/spec.js';
import { api, type PreviewResult } from '../api.js';
import { ExportDialog } from '../components/ExportDialog.js';
import { FramingCanvas } from '../components/FramingCanvas.js';
import { LookSliders, lookOptions } from '../components/LookSliders.js';
import { PreviewPane } from '../components/PreviewPane.js';
import { Badge, Button, Card, cx, EmptyState, Hero, IconButton, Kbd, KV, layout, Meter, PageHeader, Segmented, Select } from '../components/ui.js';
import { ASPECT_OPTIONS, autoPlacement, changedControls, controlText, cropKeep, lookWords, specForEdit } from '../lib/spec.js';
import { useApp } from '../store.js';
import { andList, cameraName, fmtClock, fmtDay, plural } from '../lib/format.js';
import { baseNameOf, extLabel } from '../lib/paths.js';

type Mode = 'frame' | 'result';


/**
 * Step-through editor: one photo at a time from the session queue. Every change is saved to the folder
 * sidecar immediately, so leaving is always safe. Done/Skip advance; the last photo offers Export (if the
 * session asked for it). Two independent tools: Look (preset + sliders) and Crop (ratio + framing).
 * A focus mode: no hero; the header carries the session, the cards on the right close on what the tools do.
 */
export function EditorPage() {
  const app = useApp();
  const s = app.session;
  const [mode, setMode] = useState<Mode>(() => (s?.tools.frame ? 'frame' : 'result'));
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [clipboard, setClipboard] = useState<ImageEditPatch | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [finished, setFinished] = useState(false);

  const path = s ? s.paths[s.index] ?? null : null;
  const edit = path ? app.editFor(path) : undefined;
  const preset = edit?.look ? app.looks.find((l) => l.slug === edit.look) ?? null : null;
  const baseLook = preset?.look ?? IDENTITY_LOOK;
  const eff = useMemo(() => effectiveLook(edit, preset), [edit, preset]);
  const aspect = edit?.aspect ?? 'original';
  const ratio = aspectToRatio(aspect);
  const gravity = app.settings?.defaultGravity ?? 'attention';
  const spec = path ? specForEdit(edit, gravity) : null;

  useEffect(() => {
    setMode(s?.tools.frame ? 'frame' : 'result');
    setFinished(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.startedAt]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setInfo(null);
    api
      .imageInfo(path)
      .then((i) => alive && setInfo(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);

  const goTo = useCallback(
    (index: number) => {
      app.setSession((prev) => (prev ? { ...prev, index: Math.max(0, Math.min(prev.paths.length, index)) } : prev));
      setPreview(null);
    },
    [app],
  );

  const done = useCallback(() => {
    if (!s) return;
    if (s.index + 1 >= s.paths.length) setFinished(true);
    else goTo(s.index + 1);
  }, [s, goTo]);

  // Keyboard: ← → navigate, Enter = done, F/R switch mode, S star, Esc = leave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.getAttribute?.('role') === 'combobox') return;
      if (!s || exportOpen) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        done();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (finished) setFinished(false);
        else goTo(s.index - 1);
      } else if (e.key.toLowerCase() === 'f' && s.tools.frame) setMode('frame');
      else if (e.key.toLowerCase() === 'r') setMode('result');
      else if (e.key.toLowerCase() === 's' && path) void app.patchEdit(path, { star: !edit?.star });
      else if (e.key === 'Escape') app.go('gallery');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s, done, goTo, finished, app, path, edit?.star, exportOpen]);

  const setSlider = useCallback(
    (key: LookKey, v: number) => {
      if (!path) return;
      // An adjustment equal to the preset value is no adjustment.
      void app.patchEdit(path, { adjust: { [key]: v === baseLook[key] ? null : v } });
    },
    [app, path, baseLook],
  );
  const resetSlider = useCallback(
    (key: LookKey) => {
      if (!path) return;
      void app.patchEdit(path, { adjust: { [key]: null } });
    },
    [app, path],
  );

  if (!s) {
    return (
      <div className={layout.fixedPage}>
        <PageHeader title="Edit" sub="One photo at a time: frame it, nudge its look, move on." />
        <div className="min-h-0 flex-1 px-6 pb-6">
          <div className="h-full rounded-card bg-card shadow-card">
            <EmptyState title="No editing session" icon={SlidersHorizontal}>
              Select photos in the Gallery and press <span className="text-ink-0">Start</span>: you choose there whether to frame each photo, adjust the look on each, or just apply a look and a crop to all.
              <div className="mt-4">
                <Button variant="primary" onClick={() => app.go('gallery')}>
                  Go to the Gallery
                </Button>
              </div>
            </EmptyState>
          </div>
        </div>
      </div>
    );
  }

  if (finished || !path) {
    const edited = s.paths.filter((p) => app.editFor(p)).length;
    const starred = s.paths.filter((p) => app.editFor(p)?.star).length;
    const minutes = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-4">
          <Hero
            tone="green"
            icon={Check}
            title={`All ${plural(s.paths.length, 'photo')} reviewed`}
            text={`${edited} with edits saved to the folder${starred ? `, ${starred} starred` : ''}, in about ${plural(minutes, 'minute')}. ${s.exportAfter ? 'Export now, or go back and change something.' : 'The edits are saved; export whenever you like from the Gallery.'}`}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setExportOpen(true)}>
              <Upload size={15} /> Export {plural(s.paths.length, 'photo')}…
            </Button>
            <Button variant="secondary" onClick={() => setFinished(false)}>
              <ArrowLeft size={15} /> Back to the last photo
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                app.setSession(null);
                app.go('gallery');
              }}
            >
              Close without exporting
            </Button>
          </div>
        </div>
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          onExported={() => {
            app.setSession(null);
            app.go('gallery');
          }}
          paths={s.paths}
        />
      </div>
    );
  }

  const adjustedCount = (Object.keys(edit?.adjust ?? {}) as LookKey[]).filter((k) => LOOK_CONTROLS.some((c) => c.key === k)).length;
  const presetLook = preset?.look;
  const changed = changedControls(eff, baseLook);

  // ---- sentences --------------------------------------------------------------------------------------
  const sessionLine = [
    `Photo ${s.index + 1} of ${s.paths.length}`,
    s.tools.frame ? 'framing by hand' : null,
    s.tools.look ? 'adjusting the look' : null,
    s.exportAfter ? 'export at the end' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const cropNote = (() => {
    if (!info) return null;
    const keep = cropKeep(info.width, info.height, aspect);
    if (!keep) return `No crop: the whole photo, ${info.width} × ${info.height} px, goes out.`;
    return `${aspect} keeps ${keep.w} × ${keep.h} of ${info.width} × ${info.height} px (${keep.pct}%), ${edit?.focal ? 'positioned by you' : `placed ${autoPlacement(gravity)} automatically`}. Pixels are never resized here; the export preset decides the size.`;
  })();

  const lookNote = (() => {
    if (edit?.look && !preset) return null;
    const list = andList([...changed.slice(0, 3).map((k) => controlText(k, eff[k])), ...(changed.length > 3 ? [`${changed.length - 3} more`] : [])]);
    if (preset) {
      const words = presetLook ? lookWords(presetLook) : [];
      const what = words.length ? ` (${andList(words)})` : '';
      return changed.length ? `${preset.name}${what}, with ${plural(changed.length, 'adjustment')} of your own: ${list}.` : `${preset.name}${what}, exactly as saved.`;
    }
    return changed.length ? `No look; ${plural(changed.length, 'adjustment')} of your own: ${list}.` : 'No look: the photo as it came.';
  })();

  const camera = info ? cameraName(info.make, info.model, app.settings?.hideCameraMakes) : '';

  return (
    <div className={layout.fixedPage}>
      {/* header: the photo, the session, the progress, the moves */}
      <header className={layout.pageBar}>
        <IconButton label="Back to gallery (Esc)" onClick={() => app.go('gallery')}>
          <X size={16} />
        </IconButton>
        <div className="min-w-0">
          <h1 className={cx('truncate', layout.heading)} title={path}>
            {baseNameOf(path)}
          </h1>
          <div className="truncate text-small text-ink-2">{sessionLine}</div>
        </div>
        <IconButton label={edit?.star ? 'Unstar (S)' : 'Star (S)'} onClick={() => void app.patchEdit(path, { star: !edit?.star })}>
          <Star size={16} className={edit?.star ? 'fill-warn text-warn' : ''} />
        </IconButton>
        <div className="mx-2 min-w-24 flex-1">
          <Meter value={s.index + 1} max={s.paths.length} />
        </div>
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            ...(s.tools.frame
              ? [
                  {
                    value: 'frame' as Mode,
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Crop size={13} /> Frame
                      </span>
                    ),
                    title: 'F',
                  },
                ]
              : []),
            {
              value: 'result',
              label: (
                <span className="inline-flex items-center gap-1">
                  <Eye size={13} /> Result
                </span>
              ),
              title: 'R',
            },
          ]}
        />
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => goTo(s.index - 1)} disabled={s.index === 0}>
            <ArrowLeft size={14} /> Back
          </Button>
          <Button variant="ghost" size="sm" onClick={done} title="Leave as is">
            <SkipForward size={14} /> Skip
          </Button>
          <Button variant="primary" size="sm" onClick={done}>
            {s.index + 1 >= s.paths.length ? 'Finish' : 'Done'} <ArrowRight size={14} />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] gap-4 px-6 pb-6">
        {/* the photo */}
        <section className="flex min-h-0 flex-col rounded-card bg-card p-4 shadow-card">
          {mode === 'frame' && info ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {ratio ? (
                  <FramingCanvas
                    path={path}
                    sourceWidth={info.width}
                    sourceHeight={info.height}
                    ratio={ratio}
                    gravity={gravity}
                    focal={edit?.focal ?? null}
                    serverCrop={preview?.crop ?? null}
                    onFocal={(f) => void app.patchEdit(path, { focal: f, crop: null })}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl bg-shade text-body text-ink-2">
                    <Crop size={22} className="text-ink-3" />
                    No crop on this photo: pick a ratio to frame it.
                    <div className="w-56">
                      <Select value={aspect} options={ASPECT_OPTIONS} onChange={(a) => void app.patchEdit(path, { aspect: a === 'original' ? null : a, crop: null })} />
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3 text-center text-caption text-ink-2">
                Drag the window onto the subject. <Kbd>R</Kbd> shows the result full size, <Kbd>Enter</Kbd> is done, <Kbd>S</Kbd> stars.
              </div>
            </div>
          ) : (
            <PreviewPane path={path} spec={spec} maxEdge={1800} onResult={setPreview} />
          )}
        </section>

        {/* the tools */}
        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto pb-1">
          <Card title="Crop" icon={Crop} tone="blue" className="shrink-0" actions={edit?.focal && ratio ? <Badge tone="info">framed by hand</Badge> : undefined} note={cropNote}>
            <Select value={aspect} options={ASPECT_OPTIONS} onChange={(a) => void app.patchEdit(path, { aspect: a === 'original' ? null : a, crop: null })} />
            {ratio && edit?.focal && (
              <button className="mt-2 text-caption text-info hover:underline" onClick={() => void app.patchEdit(path, { focal: null, crop: null })} title="Back to automatic position">
                Back to the automatic position
              </button>
            )}
            {mode === 'frame' && ratio && (
              <div className="mt-3 h-44">
                <PreviewPane path={path} spec={spec} maxEdge={700} onResult={setPreview} compact />
              </div>
            )}
          </Card>

          <Card
            title="Look"
            subtitle={adjustedCount ? `${adjustedCount} adjusted` : undefined}
            icon={Wand2}
            tone="violet"
            className="shrink-0"
            note={lookNote}
            actions={
              <>
                <IconButton
                  label="Copy this photo's look, adjustments and crop"
                  className="h-7 w-7"
                  onClick={() => setClipboard({ look: edit?.look ?? null, adjust: edit?.adjust ? { ...edit.adjust } : null, aspect: edit?.aspect ?? null, focal: edit?.focal ?? null })}
                >
                  <Copy size={14} />
                </IconButton>
                {clipboard && (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      const rest = s.paths.slice(s.index);
                      const patch: Record<string, ImageEditPatch> = {};
                      for (const p of rest) patch[p] = { ...clipboard, crop: null };
                      void app.patchEdits(patch);
                      app.toast({ kind: 'ok', title: `Applied to this and ${plural(rest.length - 1, 'following photo')}` });
                    }}
                    title="Paste the copied look, adjustments and crop onto this photo and all remaining ones"
                  >
                    Paste → rest
                  </Button>
                )}
              </>
            }
          >
            <Select value={edit?.look ?? ''} options={lookOptions(app.looks, 'No look')} onChange={(v) => void app.patchEdit(path, { look: v || null })} />
            {edit?.look && !preset && <div className="mt-1.5 text-caption text-warn">The look “{edit.look}” no longer exists; pick another.</div>}
            {s.tools.look ? (
              <div className="mt-3">
                <LookSliders values={eff} base={baseLook} onChange={setSlider} onReset={resetSlider} onResetAll={() => void app.patchEdit(path, { adjust: null })} />
              </div>
            ) : (
              <p className="mt-3 text-small leading-relaxed text-ink-2">
                Sliders are off for this session (framing only). Start a new session with “Adjust the look” to nudge sliders per photo.
                {adjustedCount > 0 && <span className="text-ink-1"> This photo already has {plural(adjustedCount, 'adjustment')}; they are kept.</span>}
              </p>
            )}
          </Card>

          <Card title="Photo" icon={Camera} tone="gray" className="shrink-0">
            {info ? (
              <>
                {info.capturedAt && (
                  <KV label="Taken">
                    {fmtDay(info.capturedAt)}, {fmtClock(info.capturedAt)}
                  </KV>
                )}
                {camera && <KV label="Camera">{camera}</KV>}
                <KV label="Size">
                  {info.width} × {info.height} · {((info.width * info.height) / 1e6).toFixed(1)} MP
                </KV>
                <KV label="Kind">{info.kind === 'raw' ? 'DNG (RAW)' : info.kind === 'heic' ? 'HEIC' : extLabel(path)}</KV>
                {info.colorProfile && <KV label="Colour">{info.colorProfile}</KV>}
              </>
            ) : (
              <div className="text-small text-ink-2">Reading the file…</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
