import { useEffect, useState } from 'react';
import { ChevronDown, CircleAlert, CircleCheck, Clock, Download, FolderOpen, HardDriveDownload, Images, ListChecks, Timer } from 'lucide-react';
import type { Job, JobItemStatus, JobStatus } from '../../../shared/src/api.js';
import { api } from '../api.js';
import { Badge, Button, Card, cx, Hero, IconButton, IconTile, layout, Note, PageHeader, ProgressBar, Stat, StatStrip, type Tone } from '../components/ui.js';
import { isActive, jobDestinations } from '../hooks/useJobs.js';
import { useApp } from '../store.js';
import { fmtClock, fmtDay, fmtDuration, plural, timeAgo } from '../lib/format.js';
import { baseNameOf } from '../lib/paths.js';

const STATUS_TONE: Record<JobStatus, Tone> = { queued: 'blue', running: 'blue', done: 'green', failed: 'red', cancelled: 'amber' };
const STATUS_LABEL: Record<JobStatus, string> = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const ITEM_TONE: Record<JobItemStatus, Tone> = { pending: 'gray', running: 'blue', done: 'green', failed: 'red', skipped: 'amber' };

const tookMs = (j: Job) => (j.startedAt && j.finishedAt ? Date.parse(j.finishedAt) - Date.parse(j.startedAt) : null);

/** One sentence per job: what it did, where it went, how long it took. */
function jobSentence(j: Job): string {
  const dest = jobDestinations(j)[0];
  const where = dest ? `${j.type === 'import' ? 'into' : 'to'} ${baseNameOf(dest) || dest}` : '';
  const verb = j.type === 'import' ? 'copied' : 'written';
  const noun = j.type === 'import' ? 'file' : 'photo';
  const extra = `${j.failed ? `; ${j.failed} failed` : ''}${j.skipped ? `; ${j.skipped} skipped` : ''}`;
  if (isActive(j)) return `${j.done} of ${plural(j.total, noun)} ${verb} so far${extra}.`;
  if (j.status === 'cancelled') return `Cancelled after ${j.done} of ${plural(j.total, noun)}${extra}.`;
  if (j.status === 'failed') return `Stopped after ${j.done} of ${plural(j.total, noun)}${extra}; open it for the reason on each file.`;
  const took = tookMs(j);
  return `${plural(j.done, noun)} ${verb} ${where}${took !== null ? ` in ${fmtDuration(took)}` : ''}${extra}.`.replace(/\s+\./, '.');
}

export function JobsPage() {
  const app = useApp();
  const jobs = app.jobs;
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Job | null>(null);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .job(open)
        .then((j) => alive && setDetail(j))
        .catch(() => undefined);
    void load();
    const summary = jobs.find((j) => j.id === open);
    const timer = summary && isActive(summary) ? window.setInterval(load, 1000) : null;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [open, jobs]);

  const running = jobs.filter(isActive);
  const finished = jobs.filter((j) => !isActive(j) && j.finishedAt).sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!));
  const last = finished[0];
  const openDest = (dst: string) => void api.openInOs(dst).catch(() => undefined);
  const showDest = (dst: string) => {
    void app.loadDir(dst);
    app.go('gallery');
  };

  // ---- hero ---------------------------------------------------------------------------------------------
  const hero = (() => {
    if (!jobs.length)
      return (
        <Hero
          tone="gray"
          icon={ListChecks}
          title="No jobs yet"
          text="Exports you start from the Gallery or the editor, and imports from the Import page, show up here with their progress and each file's result."
          actions={
            <Button variant="hero" onClick={() => app.go('gallery')}>
              <Images size={14} /> Go to the Gallery
            </Button>
          }
        />
      );
    if (running.length) {
      const done = running.reduce((s, j) => s + j.done + j.failed + j.skipped, 0);
      const total = running.reduce((s, j) => s + j.total, 0);
      const first = running[running.length - 1]!;
      return (
        <Hero
          tone="blue"
          icon={Timer}
          title={`${running.length === 1 ? first.title : `${running.length} jobs`} running: ${done} of ${plural(total, 'file')} done`}
          text={`Started ${first.startedAt ? timeAgo(first.startedAt) : 'just now'}. You can keep working; a note pops up when it finishes.`}
        />
      );
    }
    if (!last) return null;
    const dest = jobDestinations(last)[0];
    const bad = last.failed > 0 || last.status === 'failed';
    return (
      <Hero
        tone={bad ? 'amber' : last.status === 'cancelled' ? 'gray' : 'green'}
        icon={bad ? CircleAlert : CircleCheck}
        title={bad ? `The last job had ${plural(last.failed, 'failure')}: ${last.title}` : `All quiet: the last job finished ${timeAgo(last.finishedAt!)}`}
        text={bad ? `${last.done} of ${last.total} went through; open it below for the error on each file.` : `${last.title} — ${jobSentence(last)}`}
        actions={
          dest ? (
            <Button variant="hero" onClick={() => openDest(dest)}>
              <FolderOpen size={14} /> Open the folder
            </Button>
          ) : undefined
        }
      />
    );
  })();

  // ---- output folders -----------------------------------------------------------------------------------
  const folders = (() => {
    const m = new Map<string, { jobs: number; last: string; type: Job['type'] }>();
    for (const j of jobs)
      for (const d of jobDestinations(j)) {
        const cur = m.get(d);
        const t = j.finishedAt ?? j.createdAt;
        if (!cur) m.set(d, { jobs: 1, last: t, type: j.type });
        else m.set(d, { jobs: cur.jobs + 1, last: cur.last > t ? cur.last : t, type: cur.type });
      }
    return [...m].sort((a, b) => (a[1].last < b[1].last ? 1 : -1));
  })();

  const totals = {
    done: jobs.reduce((s, j) => s + j.done, 0),
    failed: jobs.reduce((s, j) => s + j.failed, 0),
    renders: jobs.filter((j) => j.type === 'render').length,
    imports: jobs.filter((j) => j.type === 'import').length,
  };

  return (
    <div className={layout.scrollPage}>
      <PageHeader title="Jobs" sub="Exports and imports, with every file's result." />
      <div className={layout.pageBody}>
        {hero}

        {jobs.length > 0 && (
          <StatStrip>
            <Stat label="Jobs" value={jobs.length} sub={`${plural(totals.renders, 'export')} · ${plural(totals.imports, 'import')}`} icon={ListChecks} tone="gray" />
            <Stat label="Running" value={running.length} sub={running.length ? 'in the background' : 'nothing right now'} icon={Timer} tone={running.length ? 'blue' : 'gray'} />
            <Stat label="Files done" value={totals.done.toLocaleString('en-US')} sub="across every job" icon={CircleCheck} tone="green" />
            <Stat label="Failed" value={totals.failed} sub={totals.failed ? 'open a job to see why' : 'none'} icon={CircleAlert} tone={totals.failed ? 'red' : 'gray'} />
            <Stat label="Last finished" value={last?.finishedAt ? timeAgo(last.finishedAt) : '–'} sub={last?.title} icon={Clock} tone="violet" />
          </StatStrip>
        )}

        {jobs.length > 0 && (
          <div className={layout.columns}>
            <div className="min-w-0 space-y-3">
              {jobs.map((j) => {
                const done = j.done + j.failed + j.skipped;
                const isOpen = open === j.id;
                const d = isOpen ? detail : null;
                const dests = jobDestinations(j);
                const took = tookMs(j);
                return (
                  <section key={j.id} className={cx('rounded-card bg-card shadow-card', isOpen && 'ring-1 ring-edge')}>
                    <button className="flex w-full items-center gap-3 px-[18px] pt-4 pb-3 text-left" onClick={() => setOpen(isOpen ? null : j.id)}>
                      <IconTile icon={j.type === 'import' ? HardDriveDownload : Download} tone={STATUS_TONE[j.status]} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-lead font-medium text-ink-0">{j.title}</span>
                        <span className="block truncate text-caption text-ink-2">
                          {j.type === 'import' ? 'Import' : 'Export'} · started {fmtDay(j.startedAt ?? j.createdAt)} at {fmtClock(j.startedAt ?? j.createdAt)}
                          {took !== null ? ` · took ${fmtDuration(took)}` : ''}
                        </span>
                      </span>
                      <Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge>
                      <ChevronDown size={15} className={cx('shrink-0 text-ink-2 transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    <div className="px-[18px] pb-4">
                      <ProgressBar value={done} total={j.total} failed={j.failed} />
                      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-caption text-ink-2">
                        <span>
                          {j.done} of {j.total}
                          {j.failed ? ` · ${j.failed} failed` : ''}
                          {j.skipped ? ` · ${j.skipped} skipped` : ''}
                        </span>
                        {dests.length > 0 && (
                          <span className="ml-auto flex flex-wrap gap-1">
                            {dests.slice(0, 2).map((dst) => (
                              <span key={dst} className="flex gap-1">
                                <Button size="sm" variant="secondary" onClick={() => openDest(dst)} title={`Open ${dst} in Explorer`}>
                                  <FolderOpen size={12} /> {baseNameOf(dst) || dst}
                                </Button>
                                <IconButton label="Browse this folder in the Gallery" className="h-7 w-7" onClick={() => showDest(dst)}>
                                  <Images size={13} />
                                </IconButton>
                              </span>
                            ))}
                          </span>
                        )}
                        {isActive(j) && (
                          <Button size="sm" variant="danger" className={dests.length ? '' : 'ml-auto'} onClick={() => void api.cancelJob(j.id)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                      <Note className="mt-3">{jobSentence(j)}</Note>
                    </div>
                    {isOpen && (
                      <div className="border-t border-line px-[18px] py-3 text-small">
                        {d?.log.length ? <pre className="scroll-thin mb-2 max-h-32 overflow-auto rounded-lg bg-shade p-2.5 text-micro text-ink-2">{d.log.join('\n')}</pre> : null}
                        {d ? (
                          <div className="scroll-thin max-h-[40vh] overflow-auto">
                            <table className="w-full text-left">
                              <thead className="sticky top-0 bg-card text-caption text-ink-2">
                                <tr className="border-b border-line">
                                  <th className="py-1.5 pr-2 font-normal">Source</th>
                                  <th className="px-2 py-1.5 font-normal">Status</th>
                                  <th className="py-1.5 pl-2 font-normal">Output or note</th>
                                </tr>
                              </thead>
                              <tbody>
                                {d.items.map((it) => (
                                  <tr key={it.src} className="border-b border-line text-ink-1 last:border-b-0">
                                    <td className="max-w-[20rem] truncate py-1.5 pr-2" title={it.src}>
                                      {it.src.split(/[\\/]/).pop()}
                                    </td>
                                    <td className="px-2 py-1.5">
                                      <Badge tone={ITEM_TONE[it.status]}>{it.status}</Badge>
                                    </td>
                                    <td className="max-w-[28rem] truncate py-1.5 pl-2 text-ink-2" title={it.error ?? it.dst ?? ''}>
                                      {it.error ? (
                                        <span className="text-bad">{it.error}</span>
                                      ) : it.dst ? (
                                        <span className="inline-flex items-center gap-2">
                                          {it.dst.split(/[\\/]/).pop()}
                                          {it.note ? <span className="text-ink-3">· {it.note}</span> : null}
                                          <button className="text-info hover:underline" onClick={() => openDest(it.dst!)}>
                                            show
                                          </button>
                                        </span>
                                      ) : (
                                        (it.note ?? '')
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-ink-2">Loading the files…</div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            <div className={layout.column}>
              <Card
                title="Output folders"
                subtitle={String(folders.length)}
                icon={FolderOpen}
                tone="gray"
                note={folders[0] ? `${plural(folders.length, 'folder')} received files; the newest is ${baseNameOf(folders[0][0]) || folders[0][0]}, ${timeAgo(folders[0][1].last)}.` : 'No job has written anything yet.'}
              >
                <div className="-mx-2">
                  {folders.map(([dst, f]) => (
                    <div key={dst} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-fill-1">
                      <IconTile icon={f.type === 'import' ? HardDriveDownload : Download} tone={f.type === 'import' ? 'violet' : 'blue'} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-ink-0" title={dst}>
                          {baseNameOf(dst) || dst}
                        </span>
                        <span className="block truncate text-caption text-ink-2">
                          {plural(f.jobs, 'job')} · last {timeAgo(f.last)}
                        </span>
                      </span>
                      <IconButton label={`Open ${dst} in Explorer`} className="h-7 w-7" onClick={() => openDest(dst)}>
                        <FolderOpen size={13} />
                      </IconButton>
                      <IconButton label="Browse in the Gallery" className="h-7 w-7" onClick={() => showDest(dst)}>
                        <Images size={13} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
