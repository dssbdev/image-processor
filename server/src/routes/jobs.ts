import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobs } from '../jobs/queue.js';
import { startRenderJob } from '../jobs/render.js';
import { exportStore } from '../store/exports.js';
import { ItemSpecSchema } from '../pipeline/spec.js';
import { ExportPresetSchema } from '../../../shared/src/spec.js';
import { normalizeUserPath } from '../fs/list.js';
import { httpError } from '../http.js';
import { planImport } from '../ingest/plan.js';
import { startImportJob } from '../ingest/run.js';
import type { ImportPlan, Job } from '../../../shared/src/api.js';

const RenderBody = z.object({
  /** Export preset slug, or an unsaved preset object. */
  export: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  destination: z.string().optional(),
  /** Each photo with its own look and crop; in an export the look is always a saved preset (its slug). */
  items: z
    .array(ItemSpecSchema.extend({ path: z.string().min(1), look: z.string().nullish() }))
    .min(1)
    .max(5000),
});
const IdParams = z.object({ id: z.string().min(1) });
const PlanBody = z.object({ source: z.string().min(1) });
const RunBody = z.object({ plan: z.custom<ImportPlan>((v) => typeof v === 'object' && v !== null && Array.isArray((v as ImportPlan).items)) });

/** Everything but the (possibly long) item list and log; the detail endpoint has the rest. */
function summarize(job: Job): Job {
  return { ...job, items: [], log: job.log.slice(-3) };
}

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/jobs/render', async (req, reply) => {
    const body = RenderBody.parse(req.body);
    const preset = typeof body.export === 'string' ? await exportStore.require(body.export) : ExportPresetSchema.parse({ slug: 'custom', name: 'Custom', ...body.export });
    const items = body.items.map((item) => ({ ...item, path: normalizeUserPath(item.path) }));
    return reply.code(202).send(await startRenderJob(items, preset, body.destination || undefined));
  });

  app.get('/api/jobs', async () => jobs.list().map(summarize));

  app.get('/api/jobs/:id', async (req) => {
    const job = jobs.get(IdParams.parse(req.params).id);
    if (!job) throw httpError(404, 'no such job');
    return job;
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    if (!jobs.cancel(IdParams.parse(req.params).id)) throw httpError(409, 'job cannot be cancelled');
    return { ok: true };
  });

  /** SSE: every job progress event as `data: <job summary>`. */
  app.get('/api/jobs/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const onProgress = (job: Job) => {
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(summarize(job))}\n\n`);
    };
    jobs.on('progress', onProgress);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      jobs.off('progress', onProgress);
    });
  });

  app.post('/api/import/plan', async (req) => planImport(PlanBody.parse(req.body).source));

  app.post('/api/import/run', async (req, reply) => reply.code(202).send(startImportJob(RunBody.parse(req.body).plan)));
}
