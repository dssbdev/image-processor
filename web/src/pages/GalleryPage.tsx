import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderInput,
  FolderOpen,
  HardDrive,
  Home,
  Image as ImageIcon,
  Images,
  Play,
  RefreshCw,
  Square,
  Star,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import type { FsEntry, ImageInfo, QuickRoot } from '../../../shared/src/api.js';
import type { ImageEditPatch } from '../../../shared/src/edits.js';
import { isRenderable } from '../../../shared/src/pairing.js';
import type { AspectRatio } from '../../../shared/src/spec.js';
import { api } from '../api.js';
import { ExportDialog } from '../components/ExportDialog.js';
import { lookOptions } from '../components/LookSliders.js';
import { PipelineModal } from '../components/PipelineModal.js';
import { PreviewPane } from '../components/PreviewPane.js';
import { Badge, Button, Card, cx, EmptyState, Hero, IconButton, Input, KV, layout, Modal, SegBar, Segmented, Select, Spinner, type SegItem } from '../components/ui.js';
import { ASPECT_OPTIONS, aspectShort, cropKeep, specForEdit } from '../lib/spec.js';
import { useApp } from '../store.js';
import { andList, cameraName, fmtBytes, fmtClock, fmtDay, plural } from '../lib/format.js';
import { baseNameOf, countTwins, extLabel, stemKey } from '../lib/paths.js';

type Filter = 'all' | 'starred' | 'edited' | 'raw';


/** "Aug 6, 2026, 10:58–21:09" on one day, else "Aug 2, 2026 – Aug 6, 2026". */
function dateRange(first?: number, last?: number): string | null {
  if (!first || !last) return null;
  return new Date(first).toDateString() === new Date(last).toDateString() ? `${fmtDay(first)}, ${fmtClock(first)}–${fmtClock(last)}` : `${fmtDay(first)} – ${fmtDay(last)}`;
}

/**
 * The Gallery: folders on the left, the photos in the middle, and a column of
 * cards on the right (the selection, the focused photo, this folder), each closing on a computed sentence.
 */
export function GalleryPage() {
  const app = useApp();
  const [roots, setRoots] = useState<QuickRoot[]>([]);
  const [pathInput, setPathInput] = useState(app.dir);
  const [editingPath, setEditingPath] = useState(false);
  const [zoom, setZoom] = useState<number>(() => Number(localStorage.getItem('ip.zoom') ?? 200));
  const [filter, setFilter] = useState<Filter>('all');
  const [showNames, setShowNames] = useState<boolean>(() => localStorage.getItem('ip.showNames') !== '0');
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [exportPaths, setExportPaths] = useState<string[] | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDest, setMoveDest] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const anchorRef = useRef<string | null>(null);

  useEffect(() => {
    api.roots().then(setRoots).catch(() => undefined);
  }, []);
  useEffect(() => setPathInput(app.dir), [app.dir]);

  /** Every photo in the folder, whatever the filter (the hero and This folder describe the folder). */
  const all = useMemo(() => (app.listing?.files ?? []).filter((f) => isRenderable(f.kind)), [app.listing]);

  const files = useMemo(() => {
    switch (filter) {
      case 'starred':
        return all.filter((f) => app.editFor(f.path)?.star);
      case 'edited':
        return all.filter((f) => !!app.editFor(f.path));
      case 'raw':
        return all.filter((f) => f.kind === 'raw');
      default:
        return all;
    }
  }, [all, filter, app.edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const isEdited = (p: string) => {
      const e = app.editFor(p);
      return !!(e && (e.look || e.aspect || e.adjust || e.focal || e.crop));
    };
    const kindsByStem = new Map<string, Set<string>>();
    for (const f of all) kindsByStem.set(stemKey(f.name), (kindsByStem.get(stemKey(f.name)) ?? new Set()).add(f.kind));
    const looks = new Map<string, number>();
    const aspects = new Map<string, number>();
    for (const f of all) {
      const e = app.editFor(f.path);
      if (e?.look) looks.set(e.look, (looks.get(e.look) ?? 0) + 1);
      if (e?.aspect) aspects.set(e.aspect, (aspects.get(e.aspect) ?? 0) + 1);
    }
    const times = all.map((f) => f.mtimeMs).filter((t): t is number => typeof t === 'number').sort((a, b) => a - b);
    return {
      pairs: [...kindsByStem.values()].filter((k) => k.has('raw') && (k.has('photo') || k.has('heic'))).length,
      edited: all.filter((f) => isEdited(f.path)).length,
      untouched: all.filter((f) => !isEdited(f.path)).map((f) => f.path),
      starred: all.filter((f) => app.editFor(f.path)?.star).length,
      jpg: all.filter((f) => f.kind === 'photo').length,
      raw: all.filter((f) => f.kind === 'raw').length,
      heic: all.filter((f) => f.kind === 'heic').length,
      bytes: all.reduce((s, f) => s + (f.size ?? 0), 0),
      range: dateRange(times[0], times[times.length - 1]),
      looks: [...looks].sort((a, b) => b[1] - a[1]),
      aspects: [...aspects].sort((a, b) => b[1] - a[1]),
    };
  }, [all, app.edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const lookName = (slug: string) => app.looks.find((l) => l.slug === slug)?.name ?? slug;

  const selected = [...app.selection].filter((p) => files.some((f) => f.path === p));
  const selectedRenderable = selected.filter((p) => isRenderable(files.find((f) => f.path === p)!.kind));
  const focused = app.focusedPath && files.some((f) => f.path === app.focusedPath) ? app.focusedPath : null;
  const focusedFile = focused ? files.find((f) => f.path === focused) : undefined;
  const focusedEdit = focused ? app.editFor(focused) : undefined;
  const focusedLook = focusedEdit?.look ? app.looks.find((l) => l.slug === focusedEdit.look) : null;

  // The real size, capture time and camera of the focused photo (the preview proxy is smaller than the file).
  useEffect(() => {
    setInfo(null);
    if (!focused) return;
    let alive = true;
    api
      .imageInfo(focused)
      .then((i) => alive && setInfo(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focused]);

  const onTileClick = (f: FsEntry, ev: React.MouseEvent) => {
    const paths = files.map((x) => x.path);
    if (ev.shiftKey && anchorRef.current) {
      const a = paths.indexOf(anchorRef.current);
      const b = paths.indexOf(f.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        app.setSelection((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(paths[i]!);
          return next;
        });
      }
    } else if (ev.altKey) {
      app.setSelection(new Set([f.path]));
      anchorRef.current = f.path;
    } else {
      app.setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(f.path)) next.delete(f.path);
        else next.add(f.path);
        return next;
      });
      anchorRef.current = f.path;
    }
    app.setFocusedPath(f.path);
  };

  const openSingle = (f: FsEntry) => {
    app.setFocusedPath(f.path);
    const e = app.editFor(f.path);
    app.setSession({
      dir: app.dir,
      paths: [f.path],
      index: 0,
      look: e?.look ?? '',
      aspect: e?.aspect ?? 'original',
      tools: { frame: true, look: true },
      exportAfter: false,
      startedAt: Date.now(),
    });
    app.go('edit');
  };

  const selectAll = () => app.setSelection(new Set(files.map((f) => f.path)));
  const selectNone = () => app.setSelection(new Set());

  const toggleStar = async () => {
    if (!selected.length) return;
    const allStarred = selected.every((p) => app.editFor(p)?.star);
    const patch: Record<string, { star: boolean }> = {};
    for (const p of selected) patch[p] = { star: !allStarred };
    await app.patchEdits(patch);
  };

  const trashSelected = async () => {
    if (!selected.length) return;
    if (!window.confirm(`Move ${plural(selected.length, 'file')} to the Recycle Bin?`)) return;
    setBusy('Deleting…');
    try {
      const r = await api.trash(selected);
      await app.reloadDir();
      app.toast({
        kind: r.failed.length ? 'bad' : 'ok',
        title: `${r.ok.length} moved to the Recycle Bin`,
        body: r.failed.map((f) => `${baseNameOf(f.path)}: ${f.error}`).join('\n') || undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const moveSelected = async () => {
    if (!selected.length || !moveDest) return;
    setBusy('Moving…');
    try {
      const r = await api.move(selected, moveDest);
      setMoveOpen(false);
      await app.reloadDir();
      app.toast({
        kind: r.failed.length ? 'bad' : 'ok',
        title: `${r.ok.length} moved`,
        body: r.failed.map((f) => `${baseNameOf(f.path)}: ${f.error}`).join('\n') || undefined,
        actions: [{ label: 'Show folder', onClick: () => void app.loadDir(moveDest) }],
      });
    } finally {
      setBusy(null);
    }
  };

  /** One-click: set the chosen look on the selection (per-photo adjustments are kept). */
  const applyLook = async (slug: string) => {
    app.setActiveLook(slug);
    if (!selectedRenderable.length) return;
    const patch: Record<string, ImageEditPatch> = {};
    for (const p of selectedRenderable) patch[p] = { look: slug || null };
    await app.patchEdits(patch);
  };

  /** One-click: set the crop ratio on the selection (framing is kept; the window is re-fitted to the new ratio). */
  const applyAspect = async (aspect: AspectRatio) => {
    app.setActiveAspect(aspect);
    if (!selectedRenderable.length) return;
    const patch: Record<string, ImageEditPatch> = {};
    for (const p of selectedRenderable) patch[p] = { aspect: aspect === 'original' ? null : aspect, crop: null };
    await app.patchEdits(patch);
  };

  const tileSize = zoom;
  const thumbPx = Math.round(tileSize * Math.min(2, window.devicePixelRatio || 1));
  const folderName = app.dir ? baseNameOf(app.dir) || app.dir : '';
  const crumbs = useMemo(() => {
    const d = app.dir;
    if (!d) return [] as { label: string; path: string }[];
    const isWin = d.includes('\\');
    const sep = isWin ? '\\' : '/';
    const parts = d.split(sep).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = isWin ? '' : '/';
    parts.forEach((p, i) => {
      if (i === 0 && isWin) acc = `${p}${sep}`;
      else acc = acc.endsWith(sep) ? `${acc}${p}` : `${acc}${sep}${p}`;
      out.push({ label: p, path: acc });
    });
    return out;
  }, [app.dir]);

  // ---- the hero: the folder's state in one sentence, and the one useful next step ----------------------
  const hero = (() => {
    if (app.dirError) return <Hero tone="red" icon={CircleAlert} title="This folder could not be opened" text={app.dirError} />;
    if (!app.dir) return <Hero tone="gray" icon={FolderOpen} title="Pick a folder to start" text="Places on the left hold the archive, the export folder and your pictures; or click the path above and type one." />;
    if (!app.listing) return null;
    if (!all.length)
      return (
        <Hero
          tone="gray"
          icon={Images}
          title={`No photos in ${folderName}`}
          text={`${plural(app.listing.dirs.length, 'subfolder')} here${app.listing.skipped ? `, and ${plural(app.listing.skipped, 'other file')} that ${app.listing.skipped === 1 ? 'is' : 'are'} not a photo` : ''}.`}
        />
      );
    const n = all.length;
    const { edited, untouched, starred, pairs, range, looks } = stats;
    const title =
      edited === 0 ? `${plural(n, 'photo')} in ${folderName}, none edited yet` : edited === n ? `All ${plural(n, 'photo')} in ${folderName} are edited` : `${edited} of ${plural(n, 'photo')} in ${folderName} ${edited === 1 ? 'is' : 'are'} edited — ${untouched.length} to go`;
    const facts: string[] = [];
    if (range) facts.push(`Files dated ${range}.`);
    if (pairs) facts.push(`${plural(pairs, 'shot')} came as JPG + DNG pairs.`);
    if (looks[0]) facts.push(`Most used look: ${lookName(looks[0][0])} (${looks[0][1]}).`);
    facts.push(starred ? `${plural(starred, 'star')}.` : 'Nothing starred yet.');
    const action =
      edited === n ? (
        <Button variant="hero" onClick={() => setExportPaths(all.filter((f) => isRenderable(f.kind)).map((f) => f.path))}>
          <Wand2 size={14} /> Export all…
        </Button>
      ) : edited === 0 ? (
        <Button variant="hero" onClick={() => app.setSelection(new Set(all.map((f) => f.path)))}>
          <CheckSquare size={14} /> Select all {n}
        </Button>
      ) : (
        <Button variant="hero" onClick={() => app.setSelection(new Set(untouched))}>
          <CheckSquare size={14} /> Select the {untouched.length} untouched
        </Button>
      );
    return <Hero tone={edited === n ? 'green' : 'blue'} icon={edited === n ? Check : Images} title={title} text={facts.join(' ')} actions={action} />;
  })();

  // ---- the selection's sentence -------------------------------------------------------------------------
  const selectionNote = (() => {
    if (!selectedRenderable.length) return null;
    const n = selectedRenderable.length;
    const withLook = selectedRenderable.filter((p) => app.editFor(p)?.look).length;
    const withCrop = selectedRenderable.filter((p) => app.editFor(p)?.aspect).length;
    const doubled = countTwins(selectedRenderable);
    const parts = [
      withLook || withCrop
        ? `${withLook} of ${n} already ${withLook === 1 ? 'has' : 'have'} a look and ${withCrop} a crop; Start keeps those unless you switch that off.`
        : `None ${n === 1 ? 'has' : 'of them has'} a look or a crop yet; Start sets both for ${n === 1 ? 'it' : `all ${n}`}.`,
    ];
    if (doubled) parts.push(`${plural(doubled, 'shot')} ${doubled === 1 ? 'is' : 'are'} selected as both JPG and DNG, so ${doubled === 1 ? 'it' : 'each'} would export twice.`);
    return parts.join(' ');
  })();

  // ---- the focused photo's sentence ---------------------------------------------------------------------
  const previewNote = (() => {
    if (!focusedFile || !info) return null;
    const w = info.width;
    const h = info.height;
    const camera = cameraName(info.make, info.model, app.settings?.hideCameraMakes);
    const shot = info.capturedAt ? ` shot ${fmtDay(info.capturedAt)} at ${fmtClock(info.capturedAt)}` : '';
    const adjustments = Object.keys(focusedEdit?.adjust ?? {}).length;
    const look = focusedLook ? `${focusedLook.name} look${adjustments ? ` with ${plural(adjustments, 'adjustment')}` : ''}.` : adjustments ? `No look, ${plural(adjustments, 'adjustment')}.` : 'No look.';
    const keep = cropKeep(w, h, focusedEdit?.aspect);
    const crop = keep
      ? `${focusedEdit?.aspect} keeps ${keep.w} × ${keep.h} px (${keep.pct}%), positioned ${focusedEdit?.focal ? 'by you' : 'automatically'}.`
      : 'Not cropped.';
    return `${w} × ${h} ${extLabel(focusedFile.name)}${camera ? ` from the ${camera}` : ''}${shot}${focusedFile.size ? ` (${fmtBytes(focusedFile.size)})` : ''}. ${look} ${crop}`;
  })();

  // ---- This folder's sentence ---------------------------------------------------------------------------
  const folderNote = (() => {
    if (!all.length) return null;
    const looks = stats.looks.slice(0, 3).map(([slug, c]) => `${lookName(slug)} (${c})`);
    const aspects = stats.aspects.slice(0, 3).map(([a, c]) => `${a} (${c})`);
    if (!looks.length && !aspects.length) return 'No looks or crops here yet.';
    return `${looks.length ? `Looks in use: ${andList(looks)}.` : 'No looks yet.'} ${aspects.length ? `Crops: ${andList(aspects)}.` : 'Nothing cropped yet.'}`;
  })();

  return (
    <div className={layout.fixedPage}>
      <PageTitle
        editing={editingPath}
        setEditing={setEditingPath}
        pathInput={pathInput}
        setPathInput={setPathInput}
        crumbs={crumbs}
        loading={app.loadingDir}
        onGo={(p) => void app.loadDir(p)}
        onOpen={app.dir ? () => void api.openInOs(app.dir).catch(() => undefined) : undefined}
      />

      {hero && <div className="px-6 pb-4">{hero}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-[14.5rem_minmax(0,1fr)_22rem] gap-4 px-6 pb-6">
        {/* Folders */}
        <Card
          title="Folders"
          icon={Folder}
          className="min-h-0"
          bodyClassName="scroll-thin min-h-0 flex-1 overflow-y-auto"
          actions={
            <IconButton label="Refresh" onClick={() => void app.reloadDir()} className="h-7 w-7">
              <RefreshCw size={13} />
            </IconButton>
          }
          note={app.listing?.skipped ? `${plural(app.listing.skipped, 'file')} here ${app.listing.skipped === 1 ? 'is' : 'are'} not a photo and ${app.listing.skipped === 1 ? 'is' : 'are'} hidden.` : undefined}
        >
          <div className="mb-1 px-1 text-caption text-ink-2">Places</div>
          <div className="space-y-0.5">
            {roots.map((r) => {
              const on = app.dir === r.path;
              const Icon = r.label === 'Home' ? Home : /^[A-Z]:$/.test(r.label) || r.label === '/' ? HardDrive : Folder;
              return (
                <button
                  key={r.path}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body transition-colors', on ? 'bg-brand/12 text-ink-0' : 'text-ink-1 hover:bg-fill-1')}
                  title={r.path}
                  onClick={() => void app.loadDir(r.path)}
                >
                  <Icon size={14} className={on ? 'text-brand' : 'text-ink-2'} />
                  <span className="truncate">{r.label}</span>
                </button>
              );
            })}
          </div>
          <div className="my-2.5 h-px bg-line" />
          <div className="mb-1 truncate px-1 text-caption text-ink-2">{folderName ? `In ${folderName}` : 'Subfolders'}</div>
          {app.listing?.parent && (
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body text-ink-2 hover:bg-fill-1 hover:text-ink-0" onClick={() => void app.loadDir(app.listing!.parent!)}>
              <ArrowUp size={14} /> Up one level
            </button>
          )}
          {app.listing?.dirs.map((d) => (
            <button key={d.path} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body text-ink-1 hover:bg-fill-1 hover:text-ink-0" title={d.path} onClick={() => void app.loadDir(d.path)}>
              <Folder size={14} className="shrink-0 text-ink-2" />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
          {app.listing && app.listing.dirs.length === 0 && <div className="px-2 py-1 text-caption text-ink-3">No subfolders</div>}
        </Card>

        {/* Photos */}
        <Card
          title="Photos"
          subtitle={all.length ? (filter === 'all' ? `${all.length} · ${fmtBytes(stats.bytes)}` : `${files.length} of ${all.length}`) : undefined}
          icon={Images}
          tone="blue"
          flush
          className="min-h-0"
          bodyClassName="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3"
          actions={
            <>
              <Segmented<Filter>
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'starred', label: <Star size={12} className="inline" />, title: 'Starred' },
                  { value: 'edited', label: 'Edited' },
                  { value: 'raw', label: 'RAW' },
                ]}
              />
              <div className="flex items-center gap-1.5 pl-1 text-ink-2" title="Thumbnail size">
                <ImageIcon size={13} />
                <input
                  type="range"
                  className="plain w-20"
                  min={120}
                  max={440}
                  step={10}
                  value={zoom}
                  onChange={(e) => {
                    setZoom(Number(e.target.value));
                    localStorage.setItem('ip.zoom', e.target.value);
                  }}
                />
              </div>
              <IconButton
                label={showNames ? 'Hide file names' : 'Show file names'}
                className="h-7 w-7"
                onClick={() => {
                  setShowNames((v) => {
                    localStorage.setItem('ip.showNames', v ? '0' : '1');
                    return !v;
                  });
                }}
              >
                <span className="text-micro font-medium">Aa</span>
              </IconButton>
              <IconButton label="Select all" className="h-7 w-7" onClick={selectAll} disabled={!files.length}>
                <CheckSquare size={14} />
              </IconButton>
            </>
          }
        >
          {files.length === 0 && !app.loadingDir && (
            <EmptyState title={filter === 'all' ? 'No photos here' : 'Nothing matches this filter'} icon={Images}>
              {filter === 'all'
                ? 'Pick a folder on the left or click the path above to type one (your work folder, the card, the archive). Click photos to select them, double-click to edit one.'
                : 'Switch the filter back to All.'}
            </EmptyState>
          )}
          <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}>
            {files.map((f) => {
              const isSel = app.selection.has(f.path);
              const isFocus = app.focusedPath === f.path;
              const e = app.editFor(f.path);
              const chip = e && (e.look || e.adjust || e.aspect);
              return (
                <div
                  key={f.path}
                  className={cx(
                    'group relative cursor-pointer overflow-hidden rounded-xl bg-fill-1 transition-all select-none',
                    isSel ? 'ring-2 ring-brand' : isFocus ? 'ring-1 ring-white/40' : 'ring-1 ring-white/[0.06] ring-inset hover:ring-white/20',
                  )}
                  onClick={(ev) => onTileClick(f, ev)}
                  onDoubleClick={() => openSingle(f)}
                  title={`${f.name}${f.size ? ` · ${fmtBytes(f.size)}` : ''}\nclick: select · shift: range · alt: only this · double-click: edit`}
                >
                  <div className="aspect-[4/3] w-full bg-shade">
                    <img
                      src={api.thumbUrl(f.path, thumbPx)}
                      alt={f.name}
                      loading="lazy"
                      className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                      draggable={false}
                    />
                  </div>
                  <div
                    className={cx(
                      'absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full transition-opacity',
                      isSel ? 'bg-brand text-brand-ink opacity-100' : 'bg-scrim text-white/80 opacity-0 group-hover:opacity-100',
                    )}
                  >
                    {isSel ? <Check size={14} strokeWidth={3} /> : <Square size={12} />}
                  </div>
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    {e?.star && <Star size={14} className="fill-warn text-warn drop-shadow" />}
                    {chip && (
                      <span
                        className="rounded-full bg-scrim px-1.5 py-0.5 text-micro leading-4 backdrop-blur"
                        title={`look: ${e.look ? lookName(e.look) : 'none'}${e.aspect ? ` · crop ${e.aspect}` : ''}${e.adjust ? ' · adjusted' : ''}`}
                      >
                        {e.look ? <span className="text-look">{lookName(e.look)}</span> : e.adjust ? <span className="text-ink-1">adjusted</span> : null}
                        {e.aspect ? <span className="text-info">{e.look || e.adjust ? ' · ' : ''}{e.aspect}</span> : null}
                      </span>
                    )}
                  </div>
                  {(f.kind === 'raw' || f.kind === 'heic') && (
                    <span className={cx('absolute right-2 bottom-2 rounded-md bg-scrim px-1.5 py-0.5 text-micro leading-4 font-medium backdrop-blur', f.kind === 'raw' ? 'text-warn' : 'text-info')} style={showNames ? { bottom: 36 } : undefined}>
                      {f.kind === 'raw' ? 'DNG' : 'HEIC'}
                    </span>
                  )}
                  {showNames && <div className="truncate px-2 py-1.5 text-caption text-ink-2">{f.name}</div>}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Right column: the selection, the focused photo, this folder */}
        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto pb-1">
          {selected.length > 0 && (
            <Card
              title={`${selected.length} selected`}
              subtitle={selectedRenderable.length !== selected.length ? `${selectedRenderable.length} can be rendered` : undefined}
              icon={CheckSquare}
              tone="green"
              className="animate-fade-up shrink-0"
              actions={
                <IconButton label="Clear selection" className="h-7 w-7" onClick={selectNone}>
                  <X size={15} />
                </IconButton>
              }
              note={selectionNote}
            >
              <Button variant="primary" className="mb-2 w-full" onClick={() => setPipelineOpen(true)} disabled={!selectedRenderable.length}>
                <Play size={15} /> Start… (look · crop · by hand)
              </Button>
              <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
                <Select size="sm" value={app.activeLook} options={lookOptions(app.looks, 'No look')} onChange={(v) => void applyLook(v)} title="Look for the selection (applies immediately)" menuWidth={280} />
                <Select size="sm" value={app.activeAspect} options={ASPECT_OPTIONS} onChange={(v) => void applyAspect(v)} title="Crop ratio for the selection (applies immediately)" menuWidth={240} />
              </div>
              <Button variant="secondary" className="mb-2 w-full" onClick={() => setExportPaths(selectedRenderable)} disabled={!selectedRenderable.length || !!busy} title="Export the selection with each photo's own look + crop">
                <Wand2 size={14} /> Export…
              </Button>
              <div className="grid grid-cols-3 gap-1.5">
                <Button variant="secondary" size="sm" onClick={() => void toggleStar()}>
                  <Star size={13} /> Star
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setMoveOpen(true)}>
                  <FolderInput size={13} /> Move
                </Button>
                <Button variant="danger" size="sm" onClick={() => void trashSelected()}>
                  <Trash2 size={13} /> Delete
                </Button>
              </div>
              {busy && (
                <div className="mt-2 flex items-center gap-2 text-caption text-ink-2">
                  <Spinner /> {busy}
                </div>
              )}
            </Card>
          )}

          <Card
            title={focused ? baseNameOf(focused) : 'Preview'}
            icon={ImageIcon}
            tone="gray"
            className="shrink-0"
            actions={
              focused ? (
                <span className="flex shrink-0 items-center gap-1">
                  {focusedLook ? <Badge tone="accent">{focusedLook.name}</Badge> : focusedEdit?.look ? <Badge tone="warn">{focusedEdit.look}?</Badge> : null}
                  {focusedEdit?.adjust && Object.keys(focusedEdit.adjust).length > 0 && <Badge>adjusted</Badge>}
                  {aspectShort(focusedEdit?.aspect) && <Badge tone="info">{aspectShort(focusedEdit?.aspect)}</Badge>}
                </span>
              ) : undefined
            }
            note={previewNote}
          >
            <div className="h-72">
              <PreviewPane path={focused} spec={focused ? specForEdit(focusedEdit, app.settings?.defaultGravity) : null} maxEdge={1000} />
            </div>
            {focused ? (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => openSingle(files.find((f) => f.path === focused)!)}>
                  Edit this photo
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void api.openInOs(focused).catch(() => undefined)}>
                  <FolderOpen size={13} /> Show in Explorer
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-small leading-relaxed text-ink-2">
                Click photos to select them, then <span className="text-ink-0">Start</span> to give them a look and a crop (and frame or adjust each by hand if you like). Double-click opens one in the editor.
              </p>
            )}
          </Card>

          {all.length > 0 && (
            <Card title="This folder" subtitle={folderName} icon={Images} tone="blue" className="shrink-0" note={folderNote}>
              <SegBar
                items={(
                  [
                    { label: 'JPG and other photos', n: stats.jpg, tone: 'gray' },
                    { label: 'DNG (RAW)', n: stats.raw, tone: 'amber' },
                    { label: 'HEIC', n: stats.heic, tone: 'blue' },
                  ] satisfies SegItem[]
                ).filter((i) => i.n > 0)}
              />
              <div className="mt-3">
                <KV label="Edited">
                  {stats.edited} of {all.length}
                </KV>
                <KV label="Starred">{stats.starred || 'none'}</KV>
                {stats.pairs > 0 && <KV label="JPG + DNG pairs">{stats.pairs}</KV>}
                {stats.range && <KV label="Dated">{stats.range}</KV>}
              </div>
            </Card>
          )}
        </div>
      </div>

      <PipelineModal open={pipelineOpen} onClose={() => setPipelineOpen(false)} paths={selectedRenderable} onExport={(p) => setExportPaths(p)} />
      <ExportDialog open={exportPaths !== null} onClose={() => setExportPaths(null)} paths={exportPaths ?? []} />

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title={`Move ${plural(selected.length, 'file')}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void moveSelected()} disabled={!moveDest || !!busy}>
              Move
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input value={moveDest} onChange={(e) => setMoveDest(e.target.value)} placeholder="destination folder (created if missing)" spellCheck={false} />
          <div className="flex flex-wrap gap-1.5">
            {app.listing?.parent && (
              <Button size="sm" variant="secondary" onClick={() => setMoveDest(app.listing!.parent!)}>
                Parent folder
              </Button>
            )}
            {app.listing?.dirs.slice(0, 8).map((d) => (
              <Button key={d.path} size="sm" variant="secondary" onClick={() => setMoveDest(d.path)}>
                {d.name}
              </Button>
            ))}
            {roots
              .filter((r) => r.label === 'Archive' || r.label === 'Export')
              .map((r) => (
                <Button key={r.path} size="sm" variant="secondary" onClick={() => setMoveDest(r.path)}>
                  {r.label}
                </Button>
              ))}
          </div>
          <p className="text-caption text-ink-2">Edits and stars move with the files. Same-name files in the destination are never overwritten.</p>
        </div>
      </Modal>
    </div>
  );
}

/** Page header: "Gallery", the folder path as clickable crumbs (click the bar to type a path), Open folder. */
function PageTitle({
  editing,
  setEditing,
  pathInput,
  setPathInput,
  crumbs,
  loading,
  onGo,
  onOpen,
}: {
  editing: boolean;
  setEditing: (v: boolean) => void;
  pathInput: string;
  setPathInput: (v: string) => void;
  crumbs: { label: string; path: string }[];
  loading: boolean;
  onGo: (path: string) => void;
  onOpen?: () => void;
}) {
  return (
    <header className={cx(layout.pageBar, 'flex-nowrap')}>
      <h1 className={layout.heading}>Gallery</h1>
      {editing ? (
        <form
          className="flex max-w-3xl min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            onGo(pathInput);
          }}
        >
          <Input autoFocus value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} onBlur={() => setEditing(false)} />
        </form>
      ) : (
        <button className="flex h-9 max-w-3xl min-w-0 flex-1 items-center gap-1 rounded-control bg-fill-1 px-3 text-left ring-1 ring-line ring-inset hover:bg-fill-2" onClick={() => setEditing(true)} title="Click to type a path">
          <FolderOpen size={14} className="mr-1 shrink-0 text-ink-2" />
          {crumbs.length === 0 && <span className="text-ink-3">Choose a folder…</span>}
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="shrink-0 text-ink-3" />}
              <span
                className={cx('truncate text-body', i === crumbs.length - 1 ? 'text-ink-0' : 'text-ink-2 hover:text-ink-0')}
                onClick={(e) => {
                  if (i === crumbs.length - 1) return;
                  e.stopPropagation();
                  onGo(c.path);
                }}
              >
                {c.label}
              </span>
            </span>
          ))}
        </button>
      )}
      {loading && <Spinner />}
      <div className="ml-auto flex items-center gap-2">
        {onOpen && (
          <Button variant="secondary" size="sm" onClick={onOpen}>
            <FolderOpen size={13} /> Open folder
          </Button>
        )}
      </div>
    </header>
  );
}
