import { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Pencil, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { METADATA_LABELS, METADATA_POLICIES, OUTPUT_FORMATS, slugify, type ExportPreset, type ExportPresetInput, type MetadataPolicy, type OutputFormat } from '../../../shared/src/spec.js';
import { api } from '../api.js';
import { renderItemFor } from '../lib/spec.js';
import { useApp } from '../store.js';
import { Button, cx, Field, Input, layout, Modal, Select, type SelectOption } from './ui.js';
import { countTwins } from '../lib/paths.js';
import { andList, plural } from '../lib/format.js';

const FORMAT_OPTIONS: SelectOption<OutputFormat>[] = OUTPUT_FORMATS.map((f) => ({ value: f, label: f.toUpperCase(), hint: f === 'jpeg' ? 'Universal; q90 for Instagram, q95 for keeps' : f === 'webp' ? 'Smaller files for web/chat' : 'Lossless, big files' }));
const METADATA_OPTIONS: SelectOption<MetadataPolicy>[] = METADATA_POLICIES.map((m) => ({ value: m, label: METADATA_LABELS[m] }));
const SIZE_PRESETS = [0, 1080, 1600, 2048, 2560, 4096];

function summary(p: ExportPreset, exportRoot?: string): string {
  const size = p.longEdge ? `${p.longEdge} px long edge` : 'original size';
  return `${size} · ${p.format.toUpperCase()} q${p.quality} · ${METADATA_LABELS[p.metadata]} → ${p.destination || `${exportRoot ?? '<export>'}${exportRoot?.includes('\\') ? '\\' : '/'}${p.slug}`}`;
}

/**
 * "Export N photos" — pick an export preset (size, format, quality, metadata, destination, naming), tweak
 * or save presets right here, and start the job. Every photo goes out with its own look + crop from its sidecar.
 */
export function ExportDialog({ open, onClose, paths, title, onExported }: { open: boolean; onClose: () => void; paths: string[]; title?: string; onExported?: () => void }) {
  const app = useApp();
  const [slug, setSlug] = useState(app.activeExport);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ExportPresetInput | null>(null);
  const [destOverride, setDestOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSlug(app.activeExport || app.exports[0]?.slug || '');
    setEditing(false);
    setDraft(null);
    setDestOverride('');
    setError(null);
  }, [open, app.activeExport, app.exports]);

  const preset = useMemo(() => app.exports.find((p) => p.slug === slug) ?? app.exports[0] ?? null, [app.exports, slug]);
  const options: SelectOption<string>[] = app.exports.map((p) => ({ value: p.slug, label: p.name, hint: p.description || summary(p, app.settings?.exportRoot) }));

  const startEdit = (fresh?: boolean) => {
    if (!preset) return;
    setDraft(fresh ? { ...preset, slug: '', name: '', description: '', createdAt: undefined, updatedAt: undefined } : { ...preset });
    setEditing(true);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const isNew = !app.exports.some((p) => p.slug === draft.slug);
      const body: ExportPresetInput = { ...draft, slug: draft.slug || slugify(draft.name || 'export', 'export'), name: draft.name || 'Export' };
      const saved = isNew || body.slug !== draft.slug ? await api.exports.create(body) : await api.exports.update(body);
      await app.reloadExports();
      setSlug(saved.slug);
      app.setActiveExport(saved.slug);
      setEditing(false);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!preset || app.exports.length <= 1) return;
    setBusy(true);
    try {
      await api.exports.remove(preset.slug);
      await app.reloadExports();
      setSlug('');
      setEditing(false);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      const gravity = app.settings?.defaultGravity;
      const items = paths.map((p) => renderItemFor(p, app.editFor(p), gravity));
      const job = await api.render({ export: editing && draft ? { ...preset, ...draft, slug: preset.slug, name: draft.name || preset.name } : preset.slug, destination: destOverride.trim() || undefined, items });
      app.setActiveExport(preset.slug);
      app.toast({ kind: 'info', title: `Exporting ${plural(paths.length, 'photo')}…`, body: job.title });
      onClose();
      onExported?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const d = draft;

  // What goes out: each photo keeps its own look and crop; say how many of each (and catch JPG + DNG twins).
  const what = (() => {
    if (!paths.length) return null;
    const edits = paths.map((p) => app.editFor(p));
    const withLook = edits.filter((e) => e?.look).length;
    const byRatio = new Map<string, number>();
    for (const e of edits) if (e?.aspect) byRatio.set(e.aspect, (byRatio.get(e.aspect) ?? 0) + 1);
    const cropped = [...byRatio.values()].reduce((s, n) => s + n, 0);
    const plain = edits.filter((e) => !e?.look && !e?.aspect && !(e?.adjust && Object.keys(e.adjust).length)).length;
    const twins = countTwins(paths);
    const parts: string[] = [];
    if (withLook) parts.push(`${withLook} with a look`);
    if (cropped) parts.push(`${cropped} cropped (${andList([...byRatio].map(([r, n]) => `${r} ×${n}`))})`);
    if (plain && plain < paths.length) parts.push(`${plain} as ${plain === 1 ? 'it is' : 'they are'}`);
    const mix = parts.length ? `: ${andList(parts)}` : paths.length === 1 ? ', as it is (no look, no crop)' : ', all as they are (no look, no crop)';
    return `${plural(paths.length, 'photo')}${mix}. Each keeps its own look and crop; this only chooses how the files are written.${twins ? ` ${plural(twins, 'shot')} ${twins === 1 ? 'is' : 'are'} included as both JPG and DNG and will come out twice.` : ''}`;
  })();
  const set = (patch: Partial<ExportPresetInput>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? `Export ${plural(paths.length, 'photo')}`}
      width="max-w-2xl"
      footer={
        <>
          {error && <span className="mr-auto text-small text-bad">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || !preset || paths.length === 0}>
            <Download size={15} /> Export {paths.length}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {what && <p className="text-small leading-relaxed text-ink-2">{what}</p>}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Export preset">
            <Select value={preset?.slug ?? ''} options={options} onChange={(v) => { setSlug(v); setEditing(false); setDraft(null); }} disabled={editing} />
          </Field>
          <div className="flex gap-1">
            <Button variant="secondary" size="md" title="Edit this preset" onClick={() => (editing ? (setEditing(false), setDraft(null)) : startEdit())} disabled={!preset}>
              <Pencil size={14} /> {editing ? 'Hide' : 'Edit'}
            </Button>
            <Button variant="secondary" size="md" title="New preset from this one" onClick={() => startEdit(true)} disabled={!preset}>
              <Plus size={14} />
            </Button>
          </div>
        </div>
        {preset && !editing && (
          <div className={cx(layout.well, 'px-3.5 py-3 text-small leading-relaxed text-ink-1')}>
            {preset.description && <div className="mb-1 text-ink-2">{preset.description}</div>}
            <div>{summary(preset, app.settings?.exportRoot)}</div>
            <div className="mt-1 text-ink-2">
              File names: <span className="text-ink-0">{preset.naming}</span>
            </div>
          </div>
        )}
        {editing && d && (
          <div className={cx(layout.well, 'space-y-3 p-3.5')}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={d.name} onChange={(e) => set({ name: e.target.value, slug: d.slug || slugify(e.target.value, 'export') })} placeholder="Instagram, Full quality…" />
              </Field>
              <Field label="Slug" hint="folder name under the export root">
                <Input value={d.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="auto from name" />
              </Field>
            </div>
            <Field label="Description">
              <Input value={d.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Long edge" hint="0 = original">
                <div className="flex items-center gap-1.5">
                  <Input type="number" min={0} max={16384} value={d.longEdge ?? 2048} onChange={(e) => set({ longEdge: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {SIZE_PRESETS.map((n) => (
                    <button key={n} type="button" className={cx('rounded-md px-1.5 py-0.5 text-micro', (d.longEdge ?? 2048) === n ? 'bg-brand/15 text-brand' : 'bg-fill-1 text-ink-2 hover:text-ink-0')} onClick={() => set({ longEdge: n })}>
                      {n === 0 ? 'orig' : n}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Format">
                <Select value={d.format ?? 'jpeg'} options={FORMAT_OPTIONS} onChange={(v) => set({ format: v })} />
              </Field>
              <Field label="Quality" hint="1–100">
                <Input type="number" min={1} max={100} value={d.quality ?? 90} onChange={(e) => set({ quality: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 90))) })} disabled={d.format === 'png'} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Metadata">
                <Select value={d.metadata ?? 'keep-no-gps'} options={METADATA_OPTIONS} onChange={(v) => set({ metadata: v })} />
              </Field>
              <Field label="File name template" hint="{stem} {date} {time} {look} {export} {seq}">
                <Input value={d.naming ?? '{date}-{time}_{stem}'} onChange={(e) => set({ naming: e.target.value })} />
              </Field>
            </div>
            <Field label="Destination folder" hint="empty = <export root>/<slug>">
              <Input value={d.destination ?? ''} onChange={(e) => set({ destination: e.target.value })} placeholder={`${app.settings?.exportRoot ?? ''}`} />
            </Field>
            <div className="flex items-center justify-between pt-1">
              <div className="flex gap-1">
                <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy || app.exports.length <= 1 || !app.exports.some((p) => p.slug === d.slug)}>
                  <Trash2 size={13} /> Delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void api.exports.restoreDefaults().then(() => app.reloadExports())}
                  title="Bring back any deleted default preset"
                >
                  <RotateCcw size={13} /> Restore defaults
                </Button>
              </div>
              <Button variant="primary" size="sm" onClick={() => void saveDraft()} disabled={busy || !d.name}>
                <Save size={13} /> Save preset
              </Button>
            </div>
          </div>
        )}
        <Field label="Just this once: different destination" hint="optional">
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="shrink-0 text-ink-2" />
            <Input value={destOverride} onChange={(e) => setDestOverride(e.target.value)} placeholder="leave empty to use the preset's folder" />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
