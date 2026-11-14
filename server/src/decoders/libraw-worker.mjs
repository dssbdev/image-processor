// Plain JS on purpose: worker threads must load without the TypeScript loader.
// Develops one RAW/DNG buffer to 8-bit RGB with LibRaw compiled to wasm (libraw-wasm). CPU-bound and
// synchronous inside — that is why it runs off the main thread. One LibRaw instance per worker, reused.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

let instance = null;
let initError = null;

async function init() {
  if (instance || initError) return;
  try {
    // The package's index.js is browser-only (uses a Web Worker); the emscripten factory in dist/libraw.js
    // works in Node when handed the wasm binary directly.
    const dist = path.dirname(require.resolve('libraw-wasm/package.json'));
    const { default: createModule } = await import(pathToFileURL(path.join(dist, 'dist', 'libraw.js')).href);
    const wasmBinary = await readFile(path.join(dist, 'dist', 'libraw.wasm'));
    const mod = await createModule({ wasmBinary, print: () => {}, printErr: () => {} });
    instance = new mod.LibRaw();
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }
}

parentPort.on('message', async (msg) => {
  const { id, buffer, options } = msg;
  if (msg.cmd === 'ping') {
    await init();
    parentPort.postMessage({ id, ok: !initError, error: initError ?? undefined });
    return;
  }
  try {
    await init();
    if (initError) throw new Error(`LibRaw (wasm) failed to load: ${initError}`);
    const t0 = Date.now();
    instance.open(new Uint8Array(buffer), options ?? {});
    const meta = instance.metadata(false);
    const img = instance.imageData();
    // img.data is a Uint8Array view (8-bit) into wasm memory or a copy; copy into a transferable buffer.
    const bytes = img.data;
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    parentPort.postMessage(
      {
        id,
        ok: true,
        width: img.width,
        height: img.height,
        channels: img.colors,
        bits: img.bits,
        data: ab,
        ms: Date.now() - t0,
        meta: {
          make: meta?.make,
          model: meta?.model,
          flip: meta?.flip,
          rawWidth: meta?.raw_width,
          rawHeight: meta?.raw_height,
        },
      },
      [ab],
    );
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});
