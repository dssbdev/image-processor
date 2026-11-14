import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR, DATA_DIR, REPO_ROOT, getSettings, saveSettings } from '../config.js';
import { listDir, normalizeUserPath, quickRoots } from '../fs/list.js';
import { readJson } from '../fs/util.js';
import { httpError } from '../http.js';
import { ensureDerivatives, ensureThumbSize } from '../cache/derivatives.js';
import { openSource } from '../decoders/index.js';
import { detectRawEngine } from '../decoders/raw.js';
import { mediaKind, isRenderable } from '../../../shared/src/pairing.js';
import type { ImageInfo, ServerInfo } from '../../../shared/src/api.js';

const PathQuery = z.object({ path: z.string().min(1) });
const ThumbQuery = PathQuery.extend({ size: z.coerce.number().int().min(120).max(1024).optional() });

/** The absolute path a client asked for, or 415 when it is not something the pipeline can render. */
export function imagePath(input: string): string {
  const file = normalizeUserPath(input);
  if (!isRenderable(mediaKind(path.basename(file)))) throw httpError(415, 'not an image');
  return file;
}

/** Send a cached derivative (thumbnail / proxy); the browser may keep it for a day. */
async function sendCachedJpeg(reply: FastifyReply, file: string): Promise<FastifyReply> {
  return reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(await readFile(file));
}

export async function coreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/info', async (): Promise<ServerInfo> => {
    const pkg = (await readJson(path.join(REPO_ROOT, 'package.json'))) as { version: string };
    return { version: pkg.version, platform: process.platform, configDir: CONFIG_DIR, dataDir: DATA_DIR, node: process.version, raw: await detectRawEngine() };
  });

  app.get('/api/settings', async () => getSettings());
  app.put('/api/settings', async (req) => {
    const saved = await saveSettings(req.body);
    await detectRawEngine(true);
    return saved;
  });

  app.get('/api/fs/roots', async () => quickRoots());
  app.get('/api/fs/list', async (req) => listDir(PathQuery.parse(req.query).path));

  app.get('/api/thumb', async (req, reply) => {
    const { path: input, size } = ThumbQuery.parse(req.query);
    const file = imagePath(input);
    return sendCachedJpeg(reply, size ? await ensureThumbSize(file, size) : (await ensureDerivatives(file)).thumb);
  });

  app.get('/api/proxy', async (req, reply) => {
    const file = imagePath(PathQuery.parse(req.query).path);
    return sendCachedJpeg(reply, (await ensureDerivatives(file)).proxy);
  });

  app.get('/api/image/info', async (req): Promise<ImageInfo> => {
    const file = normalizeUserPath(PathQuery.parse(req.query).path);
    await stat(file);
    const src = await openSource(file);
    return {
      path: file,
      width: src.width,
      height: src.height,
      kind: src.kind,
      capturedAt: src.meta.capturedAt.toISOString(),
      make: src.meta.make,
      model: src.meta.model,
      colorProfile: src.meta.colorProfile,
    };
  });
}
