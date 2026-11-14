import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { listJsonFiles, readJson, writeJson } from '../fs/util.js';
import { httpError } from '../http.js';

/** What every preset kind has in common: a slug that is also its file name, a name, and timestamps. */
export interface Preset {
  slug: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PresetStore<T extends Preset> {
  list(): Promise<T[]>;
  get(slug: string): Promise<T | null>;
  /** Like `get`, but an unknown slug is a 404. */
  require(slug: string): Promise<T>;
  save(input: unknown, opts?: { expectSlug?: string; create?: boolean }): Promise<T>;
  remove(slug: string): Promise<boolean>;
  /** Re-seed any default that was deleted (never overwrites edited ones). Returns how many came back. */
  restoreDefaults(): Promise<number>;
}

export interface PresetStoreOptions<T extends Preset> {
  /** Folder holding one `<slug>.json` per preset. */
  dir: string;
  /** What one preset is called in messages: "look", "export preset". */
  label: string;
  schema: z.ZodType<T>;
  /** Written on first use, when the folder holds no presets yet. */
  defaults: readonly { slug: string }[];
  /** Order of `list()`. */
  compare: (a: T, b: T) => number;
}

/** A file-backed preset library: `<dir>/<slug>.json`. Seeded on first use; the files on disk always win. */
export function createPresetStore<T extends Preset>({ dir, label, schema, defaults, compare }: PresetStoreOptions<T>): PresetStore<T> {
  const fileFor = (slug: string) => path.join(dir, `${slug}.json`);

  async function write(input: object, createdAt?: string): Promise<T> {
    const now = new Date().toISOString();
    const preset = schema.parse({ ...input, createdAt: createdAt ?? now, updatedAt: now });
    await writeJson(fileFor(preset.slug), preset);
    return preset;
  }

  async function ensureSeeded(): Promise<void> {
    await mkdir(dir, { recursive: true });
    if ((await listJsonFiles(dir)).length > 0) return;
    for (const preset of defaults) await write(preset);
  }

  async function list(): Promise<T[]> {
    await ensureSeeded();
    const presets: T[] = [];
    for (const name of await listJsonFiles(dir)) {
      try {
        // The file name is the slug, whatever the file says.
        presets.push({ ...schema.parse(await readJson(path.join(dir, name))), slug: name.replace(/\.json$/, '') });
      } catch (err) {
        console.warn(`[${label}] skipping ${name}: ${(err as Error).message}`);
      }
    }
    return presets.sort(compare);
  }

  async function get(slug: string): Promise<T | null> {
    return (await list()).find((preset) => preset.slug === slug) ?? null;
  }

  return {
    list,
    get,

    async require(slug) {
      const preset = await get(slug);
      if (!preset) throw httpError(404, `no ${label} "${slug}"`);
      return preset;
    },

    async save(input, opts = {}) {
      const parsed = schema.parse(input);
      if (opts.expectSlug && opts.expectSlug !== parsed.slug) throw httpError(400, 'slug in body must match the URL');
      const existing = await get(parsed.slug);
      if (opts.create && existing) throw httpError(409, `${label} "${parsed.slug}" already exists`);
      return write(parsed, existing?.createdAt);
    },

    async remove(slug) {
      if (!(await get(slug))) return false;
      await rm(fileFor(slug), { force: true });
      return true;
    },

    async restoreDefaults() {
      const present = new Set((await list()).map((preset) => preset.slug));
      const missing = defaults.filter((preset) => !present.has(preset.slug));
      for (const preset of missing) await write(preset);
      return missing.length;
    },
  };
}
