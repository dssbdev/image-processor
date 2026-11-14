import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CircleAlert, CircleCheck, Download, Files, FolderOpen, HardDriveDownload, Images, ListChecks, Play } from 'lucide-react';
import type { ImportAction, ImportPlan, ImportPlanItem, Job, QuickRoot } from '../../../shared/src/api.js';
import { isoDate } from '../../../shared/src/naming.js';
import { api } from '../api.js';
import { Badge, Button, Card, Hero, Input, KV, layout, Meter, PageHeader, SegBar, Segmented, Select, Spinner, Stat, StatStrip, type Tone } from '../components/ui.js';
import { isActive } from '../hooks/useJobs.js';
import { useApp } from '../store.js';
import { fmtBytes, fmtDay, plural } from '../lib/format.js';
import { baseNameOf } from '../lib/paths.js';
import { VERIFY_WORDS } from '../lib/spec.js';

const LS_SRC = 'ip.import.source';

type Filter = 'all' | 'copy' | 'skip-exists' | 'skip-unsupported';
const ACTION_LABEL: Record<ImportAction, string> = { copy: 'Copy', 'skip-exists': 'Already there', 'skip-unsupported': 'Not supported', 'skip-hidden': 'Hidden' };
const ACTION_TONE: Record<ImportAction, Tone> = { copy: 'blue', 'skip-exists': 'green', 'skip-unsupported': 'gray', 'skip-hidden': 'gray' };
const KIND_TONE: Record<string, Tone> = { photo: 'gray', raw: 'amber', heic: 'blue', video: 'violet', other: 'gray' };
const KIND_LABEL: Record<string, string> = { photo: 'Photos (JPG, PNG…)', raw: 'DNG (RAW)', heic: 'HEIC', video: 'Videos', other: 'Other' };
const dayKey = (iso: string) => isoDate(new Date(iso));

/**
 * Import: point at the card or a folder, get a dry-run plan, then copy into Archive/YYYY/YYYY-MM-DD/ with
 * dated names. The hero says where things stand, the strip counts the plan, the side cards break it down.
 */
export function ImportPage() {
  const app = useApp();
  const [roots, setRoots] = useState<QuickRoot[]>([]);
  const [source, setSource] = useState(() => localStorage.getItem(LS_SRC) ?? '');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [job, setJob] = useState<Job | null>(null);
  const live = job ? (app.jobs.find((j) => j.id === job.id) ?? job) : null;

  useEffect(() => {
    api.roots().then(setRoots).catch(() => undefined);
  }, []);

  const analyze = async () => {
    setPlanning(true);
    setError(null);
    setPlan(null);
    setJob(null);
    try {
      localStorage.setItem(LS_SRC, source);
      setPlan(await api.planImport(source));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const run = async () => {
    if (!plan) return;
    setError(null);
    try {
      setJob(await api.runImport(plan));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rows = useMemo(() => {
    if (!plan) return [] as ImportPlanItem[];
    const list = filter === 'all' ? plan.items : plan.items.filter((i) => i.action === filter);
    return list.slice(0, 500);
  }, [plan, filter]);

  const days = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of plan?.items ?? []) if (i.action === 'copy') m.set(dayKey(i.capturedAt), (m.get(dayKey(i.capturedAt)) ?? 0) + 1);
    return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [plan]);

  const archiveRoot = plan?.archiveRoot ?? app.settings?.archiveRoot ?? '';
  const sourceName = plan ? baseNameOf(plan.source) || plan.source : source;
  const running = live && isActive(live);
  const finished = live ? live.done + live.failed + live.skipped : 0;

  // ---- hero: where things stand, one next step ----------------------------------------------------------
  const hero = (() => {
    if (error) return <Hero tone="red" icon={CircleAlert} title="That did not work" text={error} />;
    if (live && running)
      return (
        <Hero
          tone="blue"
          icon={HardDriveDownload}
          title={`Copying ${plural(live.total, 'file')} into the archive: ${live.done} done`}
          text={`${live.failed ? `${live.failed} failed so far. ` : ''}The copy keeps running if you leave this page; the Jobs page has every file.`}
        />
      );
    if (live)
      return (
        <Hero
          tone={live.failed ? 'amber' : 'green'}
          icon={live.failed ? CircleAlert : CircleCheck}
          title={`${plural(live.done, 'file')} copied into the archive${live.failed ? `, ${live.failed} failed` : ''}`}
          text={`They are under ${archiveRoot}, one folder per day. Nothing was removed from ${sourceName}.`}
          actions={
            <Button
              variant="hero"
              onClick={() => {
                void app.loadDir(archiveRoot);
                app.go('gallery');
              }}
            >
              <Images size={14} /> Show in the Gallery
            </Button>
          }
        />
      );
    if (planning) return <Hero tone="blue" icon={HardDriveDownload} title={`Reading ${source}…`} text="Listing every file and its capture date; nothing is written." />;
    if (plan) {
      const t = plan.totals;
      if (t.copy === 0)
        return (
          <Hero
            tone="green"
            icon={CircleCheck}
            title={`Nothing new on ${sourceName}`}
            text={`${t.skipExists ? `All ${plural(t.skipExists, 'file')} ${t.skipExists === 1 ? 'is' : 'are'} already in the archive` : 'No photos or videos found'}${t.skipUnsupported ? `, and ${t.skipUnsupported} ${t.skipUnsupported === 1 ? 'is' : 'are'} not supported` : ''}.`}
          />
        );
      return (
        <Hero
          tone={plan.warnings.length ? 'amber' : 'blue'}
          icon={HardDriveDownload}
          title={`${plural(t.copy, 'new file')} from ${plural(days.length || t.days.length, 'day')} ready to copy (${fmtBytes(t.copyBytes)})`}
          text={`${t.skipExists ? `${t.skipExists} ${t.skipExists === 1 ? 'is' : 'are'} already in the archive and will be skipped. ` : ''}${plan.warnings.length ? `${plural(plan.warnings.length, 'warning')} below. ` : ''}Nothing is written until you press Run.`}
          actions={
            <Button variant="hero" onClick={() => void run()}>
              <Play size={14} /> Run import
            </Button>
          }
        />
      );
    }
    return (
      <Hero
        tone="gray"
        icon={HardDriveDownload}
        title="Point at the card or a folder, then Analyze"
        text={`Photos are copied into ${archiveRoot || 'the archive'} as YYYY/YYYY-MM-DD/YYYYMMDD-HHMMSS.ext. JPG and DNG pairs keep one name, videos come along, and files already there are skipped.`}
      />
    );
  })();

  // ---- sentences ----------------------------------------------------------------------------------------
  const planNote = (() => {
    if (!plan) return null;
    const noDate = plan.items.filter((i) => i.action === 'copy' && i.dateSource === 'mtime').length;
    const groups = new Map<string, number>();
    for (const i of plan.items) if (i.action === 'copy') groups.set(i.group, (groups.get(i.group) ?? 0) + 1);
    const pairs = [...groups.values()].filter((n) => n > 1).length;
    const parts: string[] = [];
    if (pairs) parts.push(`${plural(pairs, 'shot')} ${pairs === 1 ? 'has' : 'have'} JPG + DNG (or companion) files that keep one name.`);
    if (noDate) parts.push(`${plural(noDate, 'file')} ${noDate === 1 ? 'has' : 'have'} no capture date and ${noDate === 1 ? 'uses its' : 'use their'} file time (marked *).`);
    if (plan.items.length > rows.length && filter === 'all') parts.push(`Showing the first ${rows.length} of ${plan.items.length}.`);
    return parts.join(' ') || null;
  })();

  const maxDay = Math.max(1, ...days.map(([, n]) => n));
  const kinds = plan ? Object.entries(plan.totals.byKind).filter(([, n]) => n > 0) : [];

  return (
    <div className={layout.scrollPage}>
      <PageHeader title="Import" sub="Copy a card or a folder into the archive, dated and renamed. Nothing is ever moved." />
      <div className={layout.pageBody}>
        {hero}

        {plan && (
          <StatStrip>
            <Stat label="Files found" value={plan.totals.files.toLocaleString('en-US')} sub={fmtBytes(plan.totals.bytes)} icon={Files} tone="gray" />
            <Stat label="To copy" value={plan.totals.copy.toLocaleString('en-US')} sub={fmtBytes(plan.totals.copyBytes)} icon={Download} tone="blue" />
            <Stat label="Already archived" value={plan.totals.skipExists.toLocaleString('en-US')} sub="skipped" icon={CircleCheck} tone="green" />
            <Stat label="Not supported" value={plan.totals.skipUnsupported.toLocaleString('en-US')} sub="left where they are" icon={CircleAlert} tone={plan.totals.skipUnsupported ? 'amber' : 'gray'} />
            <Stat
              label="Days"
              value={plan.totals.days.length}
              sub={plan.totals.days.length ? `${plan.totals.days[0]}${plan.totals.days.length > 1 ? ` to ${plan.totals.days[plan.totals.days.length - 1]}` : ''}` : undefined}
              icon={CalendarDays}
              tone="violet"
            />
          </StatStrip>
        )}

        <div className={layout.columns}>
          <div className={layout.column}>
            <Card title="Source" subtitle="the card, or any folder" icon={HardDriveDownload} tone="blue">
              <div className="flex gap-2">
                <div className="w-44 shrink-0">
                  <Select value="" placeholder="Places…" options={roots.map((r) => ({ value: r.path, label: r.label, hint: r.path }))} onChange={(v) => setSource(v)} menuWidth={320} />
                </div>
                <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="E:\ (the card) or C:\path\to\folder" spellCheck={false} />
                <Button variant="primary" disabled={!source || planning} onClick={() => void analyze()}>
                  {planning ? <Spinner /> : <HardDriveDownload size={15} />} Analyze
                </Button>
              </div>
              {plan?.warnings.map((w) => (
                <div key={w} className="tone-amber mt-3 rounded-lg p-2.5 text-small">
                  {w}
                </div>
              ))}
            </Card>

            {plan && (
              <Card
                title="Plan"
                subtitle={filter === 'all' ? `${plan.items.length} files` : `${rows.length} of ${plan.items.length}`}
                icon={ListChecks}
                tone="gray"
                flush
                note={planNote}
                actions={
                  <>
                    <Segmented<Filter>
                      size="sm"
                      value={filter}
                      onChange={setFilter}
                      options={[
                        { value: 'all', label: 'All' },
                        { value: 'copy', label: 'To copy' },
                        { value: 'skip-exists', label: 'Archived' },
                        { value: 'skip-unsupported', label: 'Unsupported' },
                      ]}
                    />
                    <Button variant="primary" size="sm" disabled={plan.totals.copy === 0 || !!running} onClick={() => void run()}>
                      <Play size={13} /> Run ({plan.totals.copy})
                    </Button>
                  </>
                }
              >
                <div className="scroll-thin max-h-[52vh] overflow-auto">
                  <table className="w-full text-left text-small">
                    <thead className="sticky top-0 bg-card text-caption text-ink-2">
                      <tr className="border-b border-line">
                        <th className="py-2 pr-2 pl-[18px] font-normal">Source</th>
                        <th className="px-2 py-2 font-normal">Kind</th>
                        <th className="px-2 py-2 font-normal">Captured</th>
                        <th className="px-2 py-2 font-normal">Destination</th>
                        <th className="px-2 py-2 text-right font-normal">Size</th>
                        <th className="py-2 pr-[18px] pl-2 font-normal">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.src} className="border-b border-line text-ink-1 last:border-b-0">
                          <td className="max-w-[16rem] truncate py-1.5 pr-2 pl-[18px]" title={r.src}>
                            {r.src.replace(plan.source, '…')}
                          </td>
                          <td className="px-2 py-1.5">{r.kind === 'raw' ? 'DNG' : r.kind}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {new Date(r.capturedAt).toLocaleString(undefined, { hour12: false })}
                            {r.dateSource === 'mtime' && (
                              <span className="ml-1 text-warn" title="no capture date in the file; using the file's modified time">
                                *
                              </span>
                            )}
                          </td>
                          <td className="max-w-[18rem] truncate px-2 py-1.5" title={r.dst}>
                            {r.dst.replace(plan.archiveRoot, '…')}
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtBytes(r.size)}</td>
                          <td className="py-1.5 pr-[18px] pl-2">
                            <Badge tone={ACTION_TONE[r.action]} title={r.reason}>
                              {ACTION_LABEL[r.action]}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>

          <div className={layout.column}>
            {live && (
              <Card
                title={running ? 'Copying' : 'Last import'}
                icon={HardDriveDownload}
                tone={running ? 'blue' : live.failed ? 'amber' : 'green'}
                note={`${live.done} of ${plural(live.total, 'file')} copied${live.failed ? `, ${live.failed} failed` : ''}${live.skipped ? `, ${live.skipped} skipped` : ''}.`}
              >
                <Meter value={finished} max={live.total} tone={live.failed ? 'amber' : undefined} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {running && (
                    <Button size="sm" variant="danger" onClick={() => void api.cancelJob(live.id)}>
                      Cancel
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => void api.openInOs(archiveRoot).catch(() => undefined)}>
                    <FolderOpen size={13} /> Open archive
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void app.loadDir(archiveRoot);
                      app.go('gallery');
                    }}
                  >
                    <Images size={13} /> Gallery
                  </Button>
                </div>
              </Card>
            )}

            <Card
              title="Where they go"
              icon={FolderOpen}
              tone="gray"
              note={app.settings ? `Copies are checked ${VERIFY_WORDS[app.settings.importVerify]}; the source is never changed.` : undefined}
            >
              <KV label="Archive" title={archiveRoot}>
                {archiveRoot ? baseNameOf(archiveRoot) : '–'}
              </KV>
              <KV label="Folders">YYYY / YYYY-MM-DD</KV>
              <KV label="Names">YYYYMMDD-HHMMSS.ext</KV>
              <KV label="Same second">-2, -3 …</KV>
            </Card>

            {plan && days.length > 0 && (
              <Card
                title="Days"
                subtitle={`${days.length}`}
                icon={CalendarDays}
                tone="violet"
                note={days.length > 1 ? `The busiest day is ${fmtDay(`${[...days].sort((a, b) => b[1] - a[1])[0]![0]}T12:00:00`)} with ${plural([...days].sort((a, b) => b[1] - a[1])[0]![1], 'file')}.` : undefined}
              >
                <div className="space-y-2.5">
                  {days.slice(-10).map(([day, n]) => (
                    <div key={day}>
                      <div className="mb-1 flex items-baseline justify-between text-small">
                        <span className="text-ink-1">{fmtDay(`${day}T12:00:00`)}</span>
                        <span className="text-ink-0">{n}</span>
                      </div>
                      <Meter value={n} max={maxDay} tone="violet" />
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {plan && kinds.length > 0 && (
              <Card title="Kinds" icon={Files} tone="amber">
                <SegBar items={kinds.map(([k, n]) => ({ label: KIND_LABEL[k] ?? k, n, tone: KIND_TONE[k] ?? 'gray' }))} />
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
