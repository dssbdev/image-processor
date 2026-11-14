import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { CONFIG_DIR, DATA_DIR, HOST, PATHS, PORT, loadSettings } from './config.js';
import { coreRoutes } from './routes/core.js';
import { fileRoutes } from './routes/files.js';
import { jobRoutes } from './routes/jobs.js';
import { registerPresetRoutes } from './routes/presets.js';
import { previewRoutes } from './routes/preview.js';
import { jobs } from './jobs/queue.js';
import { exportStore } from './store/exports.js';
import { lookStore } from './store/looks.js';
import { shutdownExiftool } from './meta/exif.js';
import { shutdownHeic } from './decoders/heic.js';
import { detectRawEngine, describeRawEngine, shutdownLibRaw } from './decoders/raw.js';

/** Startup phases are logged so a hang or crash on a new machine says exactly where it happened. */
const phase = (msg: string) => console.log(`[server] ${msg}`);

export async function startServer(): Promise<void> {
  phase('loading settings…');
  const settings = await loadSettings();
  phase(`config dir ${CONFIG_DIR}`);
  phase(`data dir ${DATA_DIR}`);
  await jobs.loadHistory();
  phase('job history loaded');

  const app = Fastify({
    logger: { level: process.env.IP_LOG_LEVEL ?? 'warn' },
    bodyLimit: 8 * 1024 * 1024,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(e);
    return reply.code(status).send({ error: e.message });
  });

  await app.register(coreRoutes);
  await app.register(previewRoutes);
  await app.register(jobRoutes);
  await app.register(fileRoutes);
  registerPresetRoutes(app, '/api/looks', lookStore);
  registerPresetRoutes(app, '/api/exports', exportStore);
  phase('routes registered');

  const hasUi = existsSync(path.join(PATHS.webDist, 'index.html'));
  if (hasUi) {
    await app.register(fastifyStatic, { root: PATHS.webDist, prefix: '/', wildcard: true, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  phase(`listening on ${HOST}:${PORT}…`);
  await app.listen({ port: PORT, host: HOST });
  const url = `http://${HOST}:${PORT}`;
  console.log(`\nimage-processor server on ${url}${hasUi ? '' : '  (API only — the UI is served by Vite on http://localhost:5173 in dev, or run "npm run build" first)'}`);
  console.log(`archive:  ${settings.archiveRoot}\nexport:   ${settings.exportRoot}`);
  // Non-blocking: report the RAW engine once detection finishes.
  void detectRawEngine()
    .then((r) => console.log(`RAW:      ${describeRawEngine(r)}`))
    .catch(() => undefined);

  const stop = async () => {
    console.log('shutting down…');
    await app.close();
    await Promise.allSettled([shutdownExiftool(), shutdownHeic(), shutdownLibRaw()]);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
