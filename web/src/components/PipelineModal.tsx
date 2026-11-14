import { useEffect, useState } from 'react';
import { Crop, Play, SlidersHorizontal, Wand2 } from 'lucide-react';
import type { ImageEditPatch } from '../../../shared/src/edits.js';
import type { AspectRatio } from '../../../shared/src/spec.js';
import { ASPECT_OPTIONS } from '../lib/spec.js';
import { useApp } from '../store.js';
import { lookOptions } from './LookSliders.js';
import { Button, Field, layout, Modal, Select, Toggle } from './ui.js';
import { plural } from '../lib/format.js';

/**
 * "What do you want to do with these N photos?" — pick a look and a crop ratio for all of them, decide what
 * to do by hand (frame each / adjust each), and whether to export at the end. Look + aspect are written into
 * every photo's sidecar so they show up in the editor and the gallery, and survive the session.
 */
export function PipelineModal({ open, onClose, paths, onExport }: { open: boolean; onClose: () => void; paths: string[]; onExport: (paths: string[]) => void }) {
  const app = useApp();
  const [look, setLook] = useState(app.activeLook);
  const [aspect, setAspect] = useState<AspectRatio>(app.activeAspect);
  const [keepPerPhoto, setKeepPerPhoto] = useState(true);
  const [frame, setFrame] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [exportAfter, setExportAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setLook(app.activeLook);
      setAspect(app.activeAspect);
    }
  }, [open, app.activeLook, app.activeAspect]);
  const manual = frame || adjust;
  const alreadyEdited = paths.filter((p) => {
    const e = app.editFor(p);
    return e?.look || e?.aspect || e?.adjust;
  }).length;

  // What will happen, in one sentence (the footer button says the same thing in two words).
  const lookName = look ? (app.looks.find((l) => l.slug === look)?.name ?? look) : '';
  const plan = `${plural(paths.length, 'photo')} get ${lookName ? `the ${lookName} look` : 'no look'} and ${aspect === 'original' ? 'no crop' : `a ${aspect} crop`}${keepPerPhoto && alreadyEdited ? `, except where ${alreadyEdited === 1 ? 'one already has' : `${alreadyEdited} already have`} their own` : ''}. ${
    manual
      ? `Then you go through them one at a time${frame ? ', framing each' : ''}${adjust ? (frame ? ' and adjusting its look' : ', adjusting the look') : ''}${exportAfter ? '; the export dialog opens after the last one' : ''}.`
      : 'Then the export dialog opens.'
  }`;

  const start = async () => {
    setBusy(true);
    try {
      const patch: Record<string, ImageEditPatch> = {};
      for (const path of paths) {
        const e = app.editFor(path);
        const p: ImageEditPatch = {};
        if (!keepPerPhoto || !e?.look) p.look = look || null;
        if (!keepPerPhoto || !e?.aspect) p.aspect = aspect === 'original' ? null : aspect;
        if (!keepPerPhoto) {
          p.adjust = null;
          p.focal = null;
          p.crop = null;
        }
        if (Object.keys(p).length) patch[path] = p;
      }
      if (Object.keys(patch).length) await app.patchEdits(patch);
      app.setActiveLook(look);
      app.setActiveAspect(aspect);

      if (manual) {
        app.setSession({ dir: app.dir, paths, index: 0, look, aspect, tools: { frame, look: adjust }, exportAfter, startedAt: Date.now() });
        onClose();
        app.go('edit');
        return;
      }
      onClose();
      onExport(paths);
    } catch (err) {
      app.toast({ kind: 'bad', title: 'Could not start', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${plural(paths.length, 'photo')} — what do you want to do?`}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void start()} disabled={busy}>
            <Play size={15} />
            {manual ? (exportAfter ? 'Start, then export' : 'Start editing') : 'Apply & export…'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Look" hint="colour & tone, nothing else">
            <Select value={look} options={lookOptions(app.looks, 'No look')} onChange={setLook} />
          </Field>
          <Field label="Crop" hint="ratio only — pixels are never resized">
            <Select value={aspect} options={ASPECT_OPTIONS} onChange={setAspect} />
          </Field>
        </div>
        {alreadyEdited > 0 && (
          <Toggle
            checked={keepPerPhoto}
            onChange={setKeepPerPhoto}
            label={`Keep what ${alreadyEdited === paths.length ? 'these photos' : plural(alreadyEdited, 'photo')} already ${alreadyEdited === 1 ? 'has' : 'have'}`}
            hint="On: photos with a look / crop of their own keep it, the rest get the ones above. Off: everything is replaced (adjustments and framing too)."
          />
        )}

        <div>
          <div className="mb-1.5 text-small text-ink-1">Do by hand, one photo at a time</div>
          <div className={layout.well}>
            <Toggle
              checked={frame}
              onChange={setFrame}
              label={
                <span className="inline-flex items-center gap-2">
                  <Crop size={15} className="text-ink-2" /> Frame each photo
                </span>
              }
              hint={aspect === 'original' ? 'Pick a crop ratio above first — with "Original" there is nothing to frame.' : 'Drag the crop window onto the subject. Skip photos that are fine as they are.'}
            />
            <div className="mx-3 h-px bg-line" />
            <Toggle
              checked={adjust}
              onChange={setAdjust}
              label={
                <span className="inline-flex items-center gap-2">
                  <SlidersHorizontal size={15} className="text-ink-2" /> Adjust the look on each photo
                </span>
              }
              hint="Sliders on top of the look — one is darker, one needs warmth. Nothing you don't touch changes."
            />
          </div>
          {!manual && (
            <p className="mt-2 flex items-start gap-2 text-small text-ink-2">
              <Wand2 size={14} className="mt-0.5 shrink-0" /> Nothing by hand: the look and crop are applied to all (crops positioned automatically) and the export dialog opens.
            </p>
          )}
        </div>

        {manual && (
          <div>
            <div className="mb-1.5 text-small text-ink-1">When you reach the last photo</div>
            <div className={layout.well}>
              <Toggle checked={exportAfter} onChange={setExportAfter} label="Open the export dialog at the end" hint="Off = only save the edits; export later from the gallery." />
            </div>
          </div>
        )}
        <p className="border-t border-line pt-3 text-small leading-relaxed text-ink-2">{plan}</p>
      </div>
    </Modal>
  );
}
