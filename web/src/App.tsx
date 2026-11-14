import { useEffect, useRef } from 'react';
import { Aperture, CircleAlert, CircleCheck, FolderOpen, HardDriveDownload, Images, Info, ListChecks, Palette, Settings as SettingsIcon, SlidersHorizontal, X, type LucideIcon } from 'lucide-react';
import { api } from './api.js';
import { Button, IconTile, Meter, cx } from './components/ui.js';
import { isActive, jobDestinations } from './hooks/useJobs.js';
import { EditorPage } from './pages/EditorPage.js';
import { GalleryPage } from './pages/GalleryPage.js';
import { ImportPage } from './pages/ImportPage.js';
import { JobsPage } from './pages/JobsPage.js';
import { LooksPage } from './pages/LooksPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AppProvider, useApp, type Tab } from './store.js';
import { plural, timeAgo } from './lib/format.js';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'gallery', label: 'Gallery', icon: Images },
  { id: 'edit', label: 'Edit', icon: SlidersHorizontal },
  { id: 'looks', label: 'Looks', icon: Palette },
  { id: 'import', label: 'Import', icon: HardDriveDownload },
  { id: 'jobs', label: 'Jobs', icon: ListChecks },
];
const SETTINGS_TAB = { id: 'settings' as Tab, label: 'Settings', icon: SettingsIcon };

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const app = useApp();
  const seenDone = useRef<Set<string>>(new Set());

  // Toast when a job finishes: with "Open folder" / "Show in gallery" for renders.
  useEffect(() => {
    for (const j of app.jobs) {
      if (isActive(j) || seenDone.current.has(j.id)) continue;
      // Only announce jobs that finished during this session (created after page load).
      if (Date.parse(j.createdAt) < performance.timeOrigin) {
        seenDone.current.add(j.id);
        continue;
      }
      seenDone.current.add(j.id);
      const dest = jobDestinations(j)[0];
      app.toast({
        kind: j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'info',
        title: j.status === 'done' ? `Done: ${j.title}` : `${j.status}: ${j.title}`,
        body: `${j.done} ok${j.failed ? ` · ${j.failed} failed` : ''}${j.skipped ? ` · ${j.skipped} skipped` : ''}${dest ? `\n→ ${dest}` : ''}`,
        actions: dest
          ? [
              { label: 'Open folder', onClick: () => void api.openInOs(dest).catch(() => undefined) },
              {
                label: 'Show in gallery',
                onClick: () => {
                  void app.loadDir(dest);
                  app.go('gallery');
                },
              },
              { label: 'Details', onClick: () => app.go('jobs') },
            ]
          : [{ label: 'Details', onClick: () => app.go('jobs') }],
        ttl: 20_000,
      });
    }
  }, [app.jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full bg-canvas">
      <Rail />
      <main className="min-h-0 min-w-0 flex-1">
        {app.tab === 'gallery' && <GalleryPage />}
        {app.tab === 'edit' && <EditorPage />}
        {app.tab === 'looks' && <LooksPage />}
        {app.tab === 'import' && <ImportPage />}
        {app.tab === 'jobs' && <JobsPage />}
        {app.tab === 'settings' && <SettingsPage />}
      </main>
      <Toasts />
    </div>
  );
}

/** The rail: brand, the pages, Settings at the foot, and the live studio card. Icons only below 1280 px. */
function Rail() {
  const app = useApp();
  const running = app.jobs.filter(isActive).length;
  const item = (t: { id: Tab; label: string; icon: LucideIcon }) => {
    const on = app.tab === t.id;
    const badge =
      t.id === 'jobs' && running ? String(running) : t.id === 'edit' && app.session ? `${Math.min(app.session.index + 1, app.session.paths.length)}/${app.session.paths.length}` : null;
    return (
      <button
        key={t.id}
        title={t.label}
        onClick={() => app.go(t.id)}
        className={cx(
          'rail-item flex h-9 items-center gap-2.5 rounded-control px-2.5 text-body transition-colors',
          on ? 'bg-brand font-medium text-brand-ink' : 'text-ink-1 hover:bg-fill-1 hover:text-ink-0',
        )}
      >
        <t.icon size={16} strokeWidth={1.9} className="shrink-0" />
        <span className="rail-label min-w-0 flex-1 truncate text-left">{t.label}</span>
        {badge && <span className={cx('rail-label rounded-full px-1.5 text-micro leading-[18px]', on ? 'bg-black/15' : t.id === 'jobs' ? 'tone-amber' : 'bg-track text-ink-1')}>{badge}</span>}
      </button>
    );
  };
  return (
    <aside className="rail scroll-thin flex h-full shrink-0 flex-col overflow-y-auto px-3 pt-4 pb-3">
      <div className="mb-5 flex items-center gap-2.5 px-1">
        <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-control bg-brand text-brand-ink">
          <Aperture size={17} strokeWidth={2} />
        </span>
        <span className="rail-label min-w-0 leading-tight">
          <span className="block truncate text-lead font-medium text-ink-0">image-processor</span>
          <span className="block truncate text-caption text-ink-2">From card to post</span>
        </span>
      </div>
      <nav className="flex flex-col gap-0.5">{TABS.map(item)}</nav>
      <div className="min-h-4 flex-1" />
      <nav className="mb-3 flex flex-col">{item(SETTINGS_TAB)}</nav>
      <StudioCard />
    </aside>
  );
}

/** Live status at the foot of the rail: what is running, the RAW engine, the last export, the export folder. */
function StudioCard() {
  const app = useApp();
  const running = app.jobs.filter(isActive);
  const job = running[0];
  const last = app.jobs.find((j) => j.type === 'render' && !isActive(j) && j.finishedAt);
  const raw = app.info?.raw.engine;
  const rawLabel = raw === 'darktable' ? 'darktable' : raw === 'libraw' ? 'LibRaw' : raw === 'embedded' ? 'Preview only' : '–';
  const finished = job ? job.done + job.failed + job.skipped : 0;
  return (
    <div className="rail-studio rounded-2xl bg-card p-3 text-caption shadow-card">
      <div className="mb-2 flex items-center gap-2 text-ink-1">
        <span className={cx('h-2 w-2 shrink-0 rounded-full', job ? 'solid-amber animate-pulse' : 'solid-gray')} />
        {job ? `${plural(running.length, 'job')} running` : 'Studio idle'}
      </div>
      {job && (
        <div className="mb-2">
          <div className="mb-1 truncate text-ink-0" title={job.title}>
            {job.title}
          </div>
          <Meter value={finished} max={job.total} />
          <div className="mt-1 text-ink-2">
            {finished} of {job.total}
          </div>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2 py-0.5">
        <span className="text-ink-2">RAW</span>
        <button className={cx('truncate hover:underline', raw === 'embedded' ? 'text-warn' : 'text-ink-0')} onClick={() => app.go('settings')} title="DNG development engine">
          {rawLabel}
        </button>
      </div>
      <div className="flex items-baseline justify-between gap-2 py-0.5">
        <span className="text-ink-2">Last export</span>
        <span className="truncate text-ink-0">{last?.finishedAt ? timeAgo(last.finishedAt) : 'none yet'}</span>
      </div>
      {app.settings && (
        <button
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-fill-1 py-1.5 text-ink-1 transition-colors hover:bg-fill-2 hover:text-ink-0"
          title={app.settings.exportRoot}
          onClick={() => void api.openInOs(app.settings!.exportRoot).catch(() => undefined)}
        >
          <FolderOpen size={13} /> Export folder
        </button>
      )}
    </div>
  );
}

function Toasts() {
  const app = useApp();
  if (!app.toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[22rem] flex-col gap-2">
      {app.toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto animate-fade-up rounded-2xl bg-popover p-3 shadow-pop">
          <div className="flex items-start gap-3">
            <IconTile icon={t.kind === 'ok' ? CircleCheck : t.kind === 'bad' ? CircleAlert : Info} tone={t.kind === 'ok' ? 'green' : t.kind === 'bad' ? 'red' : 'blue'} size="sm" />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-body font-medium text-ink-0">{t.title}</div>
              {t.body && <div className="mt-0.5 text-caption break-words whitespace-pre-wrap text-ink-2">{t.body}</div>}
              {t.actions && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.actions.map((a) => (
                    <Button
                      key={a.label}
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        a.onClick();
                        app.dismissToast(t.id);
                      }}
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <button className="text-ink-2 hover:text-ink-0" onClick={() => app.dismissToast(t.id)} aria-label="dismiss">
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
