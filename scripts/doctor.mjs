#!/usr/bin/env node
// Environment check. Plain JS on purpose: runs with `node` alone, no TypeScript loader involved.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { darktableCandidates, whichCommand } from '../server/src/decoders/darktable-locations.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
let problems = 0;

console.log(`image-processor doctor\n  node ${process.version} · ${process.platform}-${process.arch} · ${os.cpus().length} cpus · ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM`);
console.log(`  project ${root}`);

// 1. Node version
const major = Number(process.version.slice(1).split('.')[0]);
if (major >= 22) ok(`Node ${process.version} (>= 22 required)`);
else {
  bad(`Node ${process.version} is too old — install Node 22 LTS or newer from https://nodejs.org`);
  problems++;
}

// 2. Env collisions
for (const k of ['IP_PORT', 'IP_HOST', 'IMAGE_PROCESSOR_DATA', 'IMAGE_PROCESSOR_CONFIG']) if (process.env[k]) warn(`${k}=${process.env[k]} is set (intentional?)`);
if (process.env.PORT || process.env.HOST) warn(`PORT/HOST are set in your environment (${process.env.HOST ?? ''}:${process.env.PORT ?? ''}) — ignored since v1.1, the app uses IP_PORT/IP_HOST`);

// 3. Dependencies load
async function tryImport(name, check) {
  try {
    const m = await import(name);
    ok(`${name} loads${check ? ` — ${check(m)}` : ''}`);
    return m;
  } catch (err) {
    bad(`${name} failed to load: ${err.message.split('\n')[0]}`);
    problems++;
    return null;
  }
}
const sharp = await tryImport('sharp', (m) => `sharp ${m.default.versions.sharp}, libvips ${m.default.versions.vips}`);
await tryImport('fastify');
await tryImport('zod');
await tryImport('execa');
await tryImport('trash');
await tryImport('heic-decode');
await tryImport('hash-wasm');
await tryImport('p-limit');
const ev = await tryImport('exiftool-vendored');
if (ev) {
  try {
    const t = new ev.ExifTool({ taskTimeoutMillis: 20000 });
    const v = await t.version();
    await t.end();
    ok(`exiftool ${v} answers`);
  } catch (err) {
    bad(`exiftool did not answer: ${err.message.split('\n')[0]}`);
    problems++;
  }
}
if (sharp) {
  try {
    const buf = await sharp.default({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    ok(`sharp encodes (${buf.length} bytes test JPEG)`);
  } catch (err) {
    bad(`sharp cannot encode: ${err.message}`);
    problems++;
  }
}

// 3b. LibRaw (wasm) — the built-in RAW engine
try {
  const dist = path.dirname(require.resolve('libraw-wasm/package.json'));
  const { default: createModule } = await import(pathToFileURL(path.join(dist, 'dist', 'libraw.js')).href);
  const wasmBinary = readFileSync(path.join(dist, 'dist', 'libraw.wasm'));
  const t0 = Date.now();
  const mod = await createModule({ wasmBinary, print: () => {}, printErr: () => {} });
  const inst = new mod.LibRaw();
  ok(`libraw-wasm loads (LibRaw wasm module ready in ${Date.now() - t0} ms${inst ? '' : ''}) — DNGs develop without any install`);
} catch (err) {
  bad(`libraw-wasm failed to load: ${err.message.split('\n')[0]} — run "npm install" again`);
  problems++;
}

// 4. darktable-cli
let dt = null;
for (const c of darktableCandidates()) {
  try {
    await access(c);
    dt = c;
    break;
  } catch {
    /* next */
  }
}
if (!dt) {
  dt = await new Promise((resolve) => execFile(whichCommand(), ['darktable-cli'], (e, out) => resolve(e ? null : out.split(/\r?\n/)[0]?.trim() || null)));
}
if (dt) ok(`darktable-cli found: ${dt} (preferred RAW engine)`);
else warn('darktable-cli not found — DNGs use the built-in LibRaw (slower, CPU only). darktable is optional: https://www.darktable.org/install/');

// 5. Port
const port = Number(process.env.IP_PORT ?? 5177);
await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      bad(`port ${port} is already in use — another server (an old "npm run dev"?) is still running. Close it or set IP_PORT.`);
      problems++;
    } else warn(`port check failed: ${err.message}`);
    resolve();
  });
  srv.listen(port, '127.0.0.1', () => {
    ok(`port ${port} is free`);
    srv.close(resolve);
  });
});

// 6. Config dir + settings (same rules as server/src/config.ts)
const envDir = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);
const dataDir = envDir('IMAGE_PROCESSOR_DATA');
const configDir = envDir('IMAGE_PROCESSOR_CONFIG') ?? (dataDir ? path.join(dataDir, 'config') : path.join(root, 'config'));
const settingsFile = path.join(configDir, 'settings.json');
if (existsSync(settingsFile)) {
  try {
    const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
    ok(`settings.json parses (archive: ${s.archiveRoot || '(default)'}; export: ${s.exportRoot || '(default)'})`);
  } catch (err) {
    bad(`${settingsFile} is not valid JSON: ${err.message}. Fix or delete it (it will be recreated).`);
    problems++;
  }
} else ok(`no settings.json yet in ${configDir} (created on first start)`);

// 7. Web build
if (existsSync(path.join(root, 'web', 'dist', 'index.html'))) ok('web/dist exists (npm start will serve it)');
else warn('web/dist not built — fine for "npm run dev" (Vite serves the UI); "npm start" builds it');

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good. Run: npm run dev');
process.exit(problems ? 1 : 0);
