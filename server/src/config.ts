import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsSchema, type Settings } from '../../shared/src/api.js';
import { exists, readJson, writeJson } from './fs/util.js';

/** Repo root = two levels up from server/src. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function envDir(name: string): string | null {
  const value = process.env[name];
  return value ? path.resolve(value) : null;
}

const dataOverride = envDir('IMAGE_PROCESSOR_DATA');

/** What the app produces: cache, job history, the default archive and export folders. Override with IMAGE_PROCESSOR_DATA. */
export const DATA_DIR = dataOverride ?? path.join(REPO_ROOT, 'data');

/**
 * What is yours: settings.json, looks/ and exports/. Never committed. Override with IMAGE_PROCESSOR_CONFIG;
 * an overridden data dir keeps its config inside it, so one variable relocates everything.
 */
export const CONFIG_DIR = envDir('IMAGE_PROCESSOR_CONFIG') ?? (dataOverride ? path.join(dataOverride, 'config') : path.join(REPO_ROOT, 'config'));

export const PATHS = {
  data: DATA_DIR,
  config: CONFIG_DIR,
  settings: path.join(CONFIG_DIR, 'settings.json'),
  exports: path.join(CONFIG_DIR, 'exports'),
  looks: path.join(CONFIG_DIR, 'looks'),
  jobs: path.join(DATA_DIR, 'jobs'),
  webDist: path.join(REPO_ROOT, 'web', 'dist'),
};

/**
 * Deliberately NOT the generic PORT/HOST names: on Windows env vars are case-insensitive and other tools
 * sometimes set `Host`/`Port` globally, which would silently move the API away from where Vite proxies to.
 */
export const PORT = Number(process.env.IP_PORT ?? 5177);
export const HOST = process.env.IP_HOST ?? '127.0.0.1';

let current: Settings | null = null;

/** Empty folder settings mean "inside the data dir". */
function withDefaultFolders(s: Settings): Settings {
  return {
    ...s,
    archiveRoot: s.archiveRoot || path.join(DATA_DIR, 'archive'),
    exportRoot: s.exportRoot || path.join(DATA_DIR, 'export'),
    cacheDir: s.cacheDir || path.join(DATA_DIR, 'cache'),
  };
}

async function apply(parsed: Settings): Promise<Settings> {
  current = withDefaultFolders(parsed);
  const dirs = [PATHS.config, PATHS.exports, PATHS.looks, PATHS.jobs, current.cacheDir, current.archiveRoot, current.exportRoot];
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  return current;
}

export async function loadSettings(): Promise<Settings> {
  if (current) return current;
  const saved = await exists(PATHS.settings);
  const settings = await apply(SettingsSchema.parse(saved ? await readJson(PATHS.settings) : {}));
  if (!saved) await writeJson(PATHS.settings, settings);
  return settings;
}

export function getSettings(): Settings {
  if (!current) throw new Error('settings not loaded');
  return current;
}

export async function saveSettings(patch: unknown): Promise<Settings> {
  const settings = await apply(SettingsSchema.parse({ ...(current ?? {}), ...(patch as object) }));
  await writeJson(PATHS.settings, settings);
  return settings;
}

export function cachePath(kind: 'thumbs' | 'proxies' | 'previews' | 'raw' | 'tmp'): string {
  return path.join(getSettings().cacheDir, kind);
}
