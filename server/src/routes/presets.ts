import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Preset, PresetStore } from '../store/presets.js';

const SlugParams = z.object({ slug: z.string().min(1) });

/** The same REST surface for every preset library: list, get, create, update, delete, restore defaults. */
export function registerPresetRoutes<T extends Preset>(app: FastifyInstance, base: string, store: PresetStore<T>): void {
  const slugOf = (params: unknown) => SlugParams.parse(params).slug;

  app.get(base, () => store.list());
  app.get(`${base}/:slug`, (req) => store.require(slugOf(req.params)));
  app.post(base, async (req, reply) => reply.code(201).send(await store.save(req.body, { create: true })));
  app.put(`${base}/:slug`, (req) => store.save(req.body, { expectSlug: slugOf(req.params) }));
  app.delete(`${base}/:slug`, async (req) => {
    const { slug } = await store.require(slugOf(req.params));
    await store.remove(slug);
    return { ok: true };
  });
  app.post(`${base}/restore-defaults`, async () => ({ restored: await store.restoreDefaults() }));
}
