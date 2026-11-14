// Plain JS on purpose: worker threads must load without the TypeScript loader.
// Decodes one HEIC/HEIF buffer to RGBA with libheif (wasm) — CPU-bound and synchronous inside,
// which is exactly why it runs off the main thread.
import { parentPort } from 'node:worker_threads';
import decode from 'heic-decode';

parentPort.on('message', async (msg) => {
  const { id, buffer } = msg;
  try {
    const { width, height, data } = await decode({ buffer: Buffer.from(buffer) });
    // data is a Uint8ClampedArray (RGBA). Transfer its ArrayBuffer instead of copying 48 MB.
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    parentPort.postMessage({ id, ok: true, width, height, data: ab }, [ab]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});
