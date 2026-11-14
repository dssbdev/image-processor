import { useEffect, useMemo, useState } from 'react';
import { Copy, Image as ImageIcon, Palette, Plus, RotateCcw, Save, Trash2, Undo2, Wand2 } from 'lucide-react';
import { LookPresetSchema, type LookPreset, type LookPresetInput } from '../../../shared/src/looks.js';
import { IDENTITY_LOOK, slugify, type AspectRatio, type Look, type LookKey } from '../../../shared/src/spec.js';
import { api, ApiError } from '../api.js';
import { LookSliders } from '../components/LookSliders.js';
import { PhotoPicker } from '../components/PhotoPicker.js';
import { PreviewPane, type PreviewSpec } from '../components/PreviewPane.js';
import { Button, Card, cx, Field, Hero, Input, layout, PageHeader, Select, type SelectOption } from '../components/ui.js';
import { ASPECT_OPTIONS, changedControls, controlText, lookWords } from '../lib/spec.js';
import { useApp } from '../store.js';
import { andList, plural } from '../lib/format.js';
import { baseNameOf } from '../lib/paths.js';

const GROUP_OPTIONS: SelectOption<LookPreset['group']>[] = [
  { value: 'scenario', label: 'Scenario', hint: 'where you are / what the light does' },
  { value: 'style', label: 'Style', hint: 'a grade or a mood' },
  { value: 'custom', label: 'Custom' },
];

/**
 * The Looks library: named slider sets that only change how the picture looks. Preview any look on any photo
 * of the current folder, optionally through a crop ratio to see the framing you will export with.
 */
export function LooksPage() {
  const app = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<LookPresetInput | LookPreset | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<string | null>(() => localStorage.getItem('ip.looks.sample') ?? localStorage.getItem('ip.profiles.sample'));
  const [previewAspect, setPreviewAspect] = useState<AspectRatio>(() => (localStorage.getItem('ip.looks.aspect') as AspectRatio | null) ?? 'original');

  useEffect(() => {
    if (!selected && app.looks.length && !isNew) select(app.looks[0]!.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.looks.length]);
  useEffect(() => {
    if (!sample && app.focusedPath) setSample(app.focusedPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.focusedPath]);

  function select(slug: string) {
    const l = app.looks.find((x) => x.slug === slug);
    if (!l) return;
    setSelected(slug);
    setDraft(structuredClone(l));
    setIsNew(false);
    setDirty(false);
    setError(null);
  }
  function startNew(base?: LookPreset) {
    setSelected(null);
    setDraft(base ? { ...structuredClone(base), slug: '', name: `${base.name} copy`, group: 'custom', createdAt: undefined, updatedAt: undefined } : { slug: '', name: 'New look', group: 'custom', description: '', look: { ...IDENTITY_LOOK } });
    setIsNew(true);
    setDirty(true);
  }
  const look = { ...IDENTITY_LOOK, ...(draft?.look ?? {}) } as Look;
  const updateLook = (patch: Partial<Look>) => {
    setDraft((d) => (d ? { ...d, look: { ...(d.look ?? {}), ...patch } } : d));
    setDirty(true);
  };

  const sampleEdit = sample ? app.editFor(sample) : undefined;
  const previewSpec = useMemo<PreviewSpec>(
    () => ({ look, aspect: previewAspect, gravity: app.settings?.defaultGravity ?? null, focal: sampleEdit?.focal ?? null, crop: sampleEdit?.crop ?? null }),
    [look, previewAspect, app.settings?.defaultGravity, sampleEdit?.focal, sampleEdit?.crop],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const parsed = LookPresetSchema.parse({ ...draft, slug: draft.slug || slugify(draft.name, 'look') });
      const saved = isNew ? await api.looks.create(parsed) : await api.looks.update(parsed);
      await app.reloadLooks();
      setSelected(saved.slug);
      setDraft(saved);
      setIsNew(false);
      setDirty(false);
      app.toast({ kind: 'ok', title: `Saved look “${saved.name}”` });
    } catch (e) {
      const err = e as ApiError & { issues?: { path: (string | number)[]; message: string }[] };
      setError(err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err.message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!selected || !window.confirm(`Delete look "${selected}"?`)) return;
    await api.looks.remove(selected);
    await app.reloadLooks();
    setSelected(null);
    setDraft(null);
  };
  const restore = async () => {
    const r = await api.looks.restoreDefaults();
    await app.reloadLooks();
    app.toast({ kind: 'ok', title: r.restored ? `Restored ${plural(r.restored, 'default look')}` : 'All default looks are present' });
  };

  const groups: { id: LookPreset['group']; label: string }[] = [
    { id: 'scenario', label: 'Scenarios' },
    { id: 'style', label: 'Styles' },
    { id: 'custom', label: 'Your own' },
  ];

  // ---- usage in the Gallery's folder, for the hero and the library -------------------------------------
  const folder = app.dir ? baseNameOf(app.dir) || app.dir : '';
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of Object.values(app.edits.edits)) if (e?.look) m.set(e.look, (m.get(e.look) ?? 0) + 1);
    return m;
  }, [app.edits]);
  const photosWithLook = [...usage.values()].reduce((s, n) => s + n, 0);
  const top = [...usage].sort((a, b) => b[1] - a[1])[0];
  const count = (g: LookPreset['group']) => app.looks.filter((l) => l.group === g).length;
  const nameOf = (slug: string) => app.looks.find((l) => l.slug === slug)?.name ?? slug;

  const heroText = [
    folder ? (photosWithLook ? `In ${folder}, ${plural(photosWithLook, 'photo')} ${photosWithLook === 1 ? 'has' : 'have'} a look${top ? `; ${nameOf(top[0])} is on ${top[1]}` : ''}.` : `No photo in ${folder} has a look yet.`) : null,
    'A look changes colour and tone only; the crop and the export size are separate choices.',
  ]
    .filter(Boolean)
    .join(' ');

  const changed = changedControls(look, IDENTITY_LOOK);
  const draftNote = draft
    ? changed.length
      ? `Changes ${changed.length} of 16 controls: ${andList([...changed.slice(0, 4).map((k: LookKey) => controlText(k, look[k])), ...(changed.length > 4 ? [`${changed.length - 4} more`] : [])])}.`
      : 'Every slider at zero: the photo as it came.'
    : null;
  const inUse = app.looks.filter((l) => usage.has(l.slug)).length;
  const libraryNote = folder ? `${plural(inUse, 'look')} of ${app.looks.length} ${inUse === 1 ? 'is' : 'are'} on photos in ${folder}.` : null;
  const previewNote = draft && sample ? `${draft.name || 'This look'} on ${baseNameOf(sample)}${previewAspect !== 'original' ? `, seen through a ${previewAspect} crop` : ''}. ${lookWords(look).length ? `In words: ${andList(lookWords(look))}.` : 'It leaves the colours as they are.'}` : null;

  return (
    <div className={layout.fixedPage}>
      <PageHeader title="Looks" sub="Named slider sets you put on photos.">
        <Button variant="primary" onClick={() => startNew()}>
          <Plus size={15} /> New look
        </Button>
        <Button variant="secondary" disabled={!selected} onClick={() => selected && startNew(app.looks.find((l) => l.slug === selected))} title="Duplicate the selected look">
          <Copy size={14} /> Duplicate
        </Button>
        <Button variant="ghost" onClick={() => void restore()} title="Bring back any deleted default look">
          <RotateCcw size={14} /> Restore defaults
        </Button>
      </PageHeader>

      <div className="px-6 pb-4">
        <Hero
          tone="violet"
          icon={Palette}
          title={`${plural(app.looks.length, 'look')}: ${count('scenario')} scenarios, ${count('style')} styles${count('custom') ? `, ${count('custom')} of your own` : ''}`}
          text={heroText}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[17rem_25rem_minmax(0,1fr)] gap-4 px-6 pb-6">
        {/* library */}
        <Card title="Library" subtitle={String(app.looks.length)} icon={Palette} tone="violet" className="min-h-0" bodyClassName="scroll-thin min-h-0 flex-1 overflow-y-auto" note={libraryNote}>
          {groups.map((g) => {
            const items = app.looks.filter((l) => l.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className="mb-3">
                <div className="px-1 pb-1 text-caption text-ink-2">{g.label}</div>
                {items.map((l) => {
                  const on = selected === l.slug;
                  const used = usage.get(l.slug) ?? 0;
                  return (
                    <button
                      key={l.slug}
                      className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors', on ? 'bg-brand/12' : 'hover:bg-fill-1')}
                      onClick={() => {
                        if (dirty && !window.confirm('Discard unsaved changes?')) return;
                        select(l.slug);
                      }}
                      title={l.description}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={cx('block truncate text-body', on ? 'text-ink-0' : 'text-ink-1')}>{l.name}</span>
                        <span className="block truncate text-caption text-ink-2">{lookWords(l.look).join(' · ') || 'neutral'}</span>
                      </span>
                      {used > 0 && (
                        <span className="tone-violet shrink-0 rounded-full px-1.5 text-micro leading-[18px]" title={`on ${plural(used, 'photo')} in ${folder}`}>
                          {used}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {isNew && <div className="rounded-lg bg-brand/12 px-2.5 py-1.5 text-body text-ink-0">{draft?.name || 'New look'} (unsaved)</div>}
        </Card>

        {/* the look being edited */}
        {draft ? (
          <Card
            title={draft.name || 'New look'}
            subtitle={isNew ? 'unsaved' : dirty ? 'edited' : undefined}
            icon={Wand2}
            tone="violet"
            className="min-h-0"
            bodyClassName="scroll-thin min-h-0 flex-1 overflow-y-auto"
            note={draftNote}
            actions={
              <>
                <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                  <Save size={13} /> {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => (isNew ? (setDraft(null), setIsNew(false), setDirty(false)) : select(selected!))} disabled={!dirty && !isNew}>
                  <Undo2 size={13} /> Revert
                </Button>
                {!isNew && (
                  <Button variant="danger" size="sm" onClick={() => void remove()} title="Delete this look">
                    <Trash2 size={13} />
                  </Button>
                )}
              </>
            }
          >
            <div className="space-y-3">
              {error && <div className="tone-red rounded-lg p-2.5 text-small">{error}</div>}
              <Field label="Name">
                <Input
                  value={draft.name}
                  onChange={(e) => {
                    setDraft({ ...draft, name: e.target.value, ...(isNew ? { slug: slugify(e.target.value, 'look') } : {}) });
                    setDirty(true);
                  }}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Group">
                  <Select
                    value={draft.group ?? 'custom'}
                    options={GROUP_OPTIONS}
                    onChange={(g) => {
                      setDraft({ ...draft, group: g });
                      setDirty(true);
                    }}
                  />
                </Field>
                <Field label="Slug" hint={isNew ? 'file name' : 'fixed'}>
                  <Input
                    value={draft.slug}
                    disabled={!isNew}
                    onChange={(e) => {
                      setDraft({ ...draft, slug: e.target.value });
                      setDirty(true);
                    }}
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Description">
                <Input
                  value={draft.description ?? ''}
                  onChange={(e) => {
                    setDraft({ ...draft, description: e.target.value });
                    setDirty(true);
                  }}
                />
              </Field>
              <LookSliders values={look} onChange={(k: LookKey, v) => updateLook({ [k]: v })} onReset={(k) => updateLook({ [k]: IDENTITY_LOOK[k] })} onResetAll={() => updateLook({ ...IDENTITY_LOOK })} />
            </div>
          </Card>
        ) : (
          <Card title="No look selected" icon={Wand2} tone="gray" className="min-h-0">
            <p className="text-small leading-relaxed text-ink-2">Pick a look in the library, or press New look.</p>
          </Card>
        )}

        {/* preview */}
        <Card
          title="Preview"
          subtitle={sample ? baseNameOf(sample) : undefined}
          icon={ImageIcon}
          tone="gray"
          className="min-h-0"
          bodyClassName="flex min-h-0 flex-1 flex-col"
          note={previewNote}
          actions={
            <div className="w-44" title="Preview through a crop ratio (does not change the look)">
              <Select
                size="sm"
                value={previewAspect}
                options={ASPECT_OPTIONS}
                onChange={(a) => {
                  setPreviewAspect(a);
                  localStorage.setItem('ip.looks.aspect', a);
                }}
              />
            </div>
          }
        >
          <PhotoPicker
            value={sample}
            onChange={(p) => {
              setSample(p);
              localStorage.setItem('ip.looks.sample', p);
            }}
          />
          <div className="mt-2 min-h-0 flex-1">
            <PreviewPane path={sample} spec={sample ? previewSpec : null} maxEdge={1400} />
          </div>
        </Card>
      </div>
    </div>
  );
}
