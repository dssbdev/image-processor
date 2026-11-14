import { useEffect, useState } from 'react';
import type { Job } from '../../../shared/src/api.js';
import { api } from '../api.js';

/**
 * Live job summaries: initial GET + SSE stream of progress events. One EventSource per hook instance;
 * pages mount it when they need it.
 */
export function useJobsFeed(): { jobs: Job[]; connected: boolean } {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .jobs()
      .then((list) => alive && setJobs(list))
      .catch(() => undefined);
    const es = new EventSource('/api/jobs/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('progress', (ev) => {
      const job = JSON.parse((ev as MessageEvent<string>).data) as Job;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        const next = idx >= 0 ? prev.map((j) => (j.id === job.id ? job : j)) : [job, ...prev];
        return next.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      });
    });
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  return { jobs, connected };
}

export function isActive(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** The folders a job wrote into: an export's destination(s), or the archive for an import. */
export function jobDestinations(job: Job): string[] {
  const { dests, dest, archiveRoot } = job.meta;
  if (Array.isArray(dests)) return dests as string[];
  const single = dest ?? archiveRoot;
  return single ? [String(single)] : [];
}
