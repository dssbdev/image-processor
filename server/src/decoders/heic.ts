import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { toTransferable, workerScript, type Pending as PendingFor } from './worker.js';

export interface DecodedRgba {
  width: number;
  height: number;
  /** Interleaved RGBA, 8-bit. */
  data: Buffer;
}

type Pending = PendingFor<DecodedRgba>;

/**
 * Tiny worker pool around heic-worker.mjs. Workers are created lazily and torn down on shutdown.
 * Concurrency is small on purpose: each decode holds ~50 MB for a 12 MP image.
 */
class HeicPool {
  private workers: { worker: Worker; busy: boolean }[] = [];
  private queue: { buffer: Buffer; pending: Pending }[] = [];
  private pending = new Map<number, { pending: Pending; slot: { worker: Worker; busy: boolean } }>();
  private nextId = 1;
  constructor(
    private size: number,
    private timeoutMs = 60_000,
  ) {}

  private spawn() {
    const worker = new Worker(workerScript('heic-worker.mjs'));
    const slot = { worker, busy: false };
    worker.on('message', (msg: { id: number; ok: boolean; width?: number; height?: number; data?: ArrayBuffer; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.pending.timer);
      entry.slot.busy = false;
      if (msg.ok && msg.data) {
        entry.pending.resolve({ width: msg.width!, height: msg.height!, data: Buffer.from(msg.data) });
      } else {
        entry.pending.reject(new Error(msg.error ?? 'HEIC decode failed'));
      }
      this.pump();
    });
    worker.on('error', (err) => {
      // Fail everything routed to this worker and drop it; a fresh one is spawned on demand.
      for (const [id, entry] of this.pending) {
        if (entry.slot === slot) {
          this.pending.delete(id);
          clearTimeout(entry.pending.timer);
          entry.pending.reject(err);
        }
      }
      this.workers = this.workers.filter((w) => w !== slot);
      this.pump();
    });
    this.workers.push(slot);
    return slot;
  }

  private pump() {
    while (this.queue.length > 0) {
      let slot = this.workers.find((w) => !w.busy);
      if (!slot && this.workers.length < this.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.busy = true;
      const id = this.nextId++;
      this.pending.set(id, { pending: job.pending, slot });
      const bytes = toTransferable(job.buffer);
      slot.worker.postMessage({ id, buffer: bytes }, [bytes]);
    }
  }

  decode(buffer: Buffer): Promise<DecodedRgba> {
    return new Promise<DecodedRgba>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error('HEIC decode timed out')), this.timeoutMs),
      };
      this.queue.push({ buffer, pending });
      this.pump();
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers = [];
  }
}

let pool: HeicPool | null = null;

export function heicPool(): HeicPool {
  if (!pool) pool = new HeicPool(2);
  return pool;
}

export async function decodeHeicFile(file: string): Promise<DecodedRgba> {
  return heicPool().decode(await readFile(file));
}

export async function shutdownHeic(): Promise<void> {
  if (pool) await pool.close();
  pool = null;
}
