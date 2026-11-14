import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { listJsonFiles, readJson, writeJson } from '../fs/util.js';
import type { Job, JobItem, JobType } from '../../../shared/src/api.js';

export interface JobHandle {
  job: Job;
  /** True once cancel() was called; runners must check between items. */
  readonly cancelled: boolean;
  log(line: string): void;
  itemStart(i: number): void;
  itemDone(i: number, patch?: Partial<JobItem>): void;
  itemFail(i: number, error: string): void;
  itemSkip(i: number, note: string): void;
  emitProgress(): void;
}

type Runner = (h: JobHandle) => Promise<void>;

const HISTORY_LIMIT = 50;
const LOG_LIMIT = 500;
const PROGRESS_THROTTLE_MS = 150;

/**
 * In-process job manager. One job runs at a time (each job parallelizes internally with p-limit),
 * progress is broadcast on the 'progress' event and persisted to data/jobs/<id>.json when finished.
 */
class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private cancelFlags = new Map<string, boolean>();
  private queue: { id: string; runner: Runner }[] = [];
  private running = false;
  private counter = 0;

  create(type: JobType, title: string, items: JobItem[], meta: Record<string, unknown>, runner: Runner): Job {
    const id = `${type}-${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    const job: Job = {
      id,
      type,
      title,
      status: 'queued',
      createdAt: new Date().toISOString(),
      total: items.length,
      done: 0,
      failed: 0,
      skipped: 0,
      items,
      meta,
      log: [],
    };
    this.jobs.set(id, job);
    this.cancelFlags.set(id, false);
    this.queue.push({ id, runner });
    this.emit('progress', job);
    void this.pump();
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q.id !== id);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.emit('progress', job);
      void this.persist(job);
      return true;
    }
    if (job.status === 'running') {
      this.cancelFlags.set(id, true);
      return true;
    }
    return false;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    const job = this.jobs.get(next.id)!;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('progress', job);
    const handle = this.handleFor(job);
    try {
      await next.runner(handle);
      job.status = this.cancelFlags.get(job.id) ? 'cancelled' : job.failed > 0 && job.done === 0 ? 'failed' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.log.push(`fatal: ${(err as Error).stack ?? String(err)}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.emit('progress', job);
      await this.persist(job);
      this.running = false;
      void this.pump();
    }
  }

  private handleFor(job: Job): JobHandle {
    const mgr = this;
    let lastEmit = 0;
    const emitThrottled = () => {
      const now = Date.now();
      if (now - lastEmit > PROGRESS_THROTTLE_MS) {
        lastEmit = now;
        mgr.emit('progress', job);
      }
    };
    const update = (i: number, patch: Partial<JobItem>) => {
      const item = job.items[i];
      if (item) Object.assign(item, patch);
      emitThrottled();
    };
    return {
      job,
      get cancelled() {
        return mgr.cancelFlags.get(job.id) === true;
      },
      log(line) {
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
        if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
        emitThrottled();
      },
      itemStart(i) {
        update(i, { status: 'running' });
      },
      itemDone(i, patch) {
        job.done++;
        update(i, { ...patch, status: 'done' });
      },
      itemFail(i, error) {
        job.failed++;
        update(i, { status: 'failed', error });
      },
      itemSkip(i, note) {
        job.skipped++;
        update(i, { status: 'skipped', note });
      },
      emitProgress() {
        mgr.emit('progress', job);
      },
    };
  }

  private async persist(job: Job): Promise<void> {
    try {
      await mkdir(PATHS.jobs, { recursive: true });
      await writeJson(path.join(PATHS.jobs, `${job.id}.json`), job);
    } catch (err) {
      console.warn(`[jobs] persist failed: ${(err as Error).message}`);
    }
  }

  /** Load the most recent finished jobs from disk at startup so history survives restarts. */
  async loadHistory(): Promise<void> {
    const files = (await listJsonFiles(PATHS.jobs)).filter((f) => !f.endsWith('.manifest.json')).slice(-HISTORY_LIMIT);
    for (const f of files) {
      try {
        const job = (await readJson(path.join(PATHS.jobs, f))) as Job;
        if (!job || typeof job.id !== 'string' || !Array.isArray(job.items)) continue;
        job.log ??= [];
        if (job.status === 'running' || job.status === 'queued') job.status = 'failed';
        this.jobs.set(job.id, job);
      } catch {
        /* ignore corrupt job files */
      }
    }
  }
}

export const jobs = new JobManager();
