import { access, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { splitName } from '../../../shared/src/naming.js';
import { httpError } from '../http.js';

/** Small file-system helpers shared by the stores, the cache, the routes and the jobs. */

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Throws 404 unless `dir` is an existing folder. */
export async function requireDirectory(dir: string): Promise<void> {
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw httpError(404, `not a folder: ${dir}`);
}

/** Write to a temp name, then rename into place: readers never see a half-written file. */
export async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** Names of the `.json` files in a folder, sorted; empty when the folder does not exist. */
export async function listJsonFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.json')).sort();
}

/** Lower-cased stems already used in a folder, for `uniqueStem`. Empty when the folder does not exist. */
export async function takenStems(dir: string): Promise<Set<string>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return new Set(names.map((name) => splitName(name).stem.toLowerCase()));
}
