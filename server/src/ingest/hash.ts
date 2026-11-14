import { createReadStream } from 'node:fs';
import { createXXHash64 } from 'hash-wasm';
import type { Settings } from '../../../shared/src/api.js';
import type { MediaKind } from '../../../shared/src/pairing.js';

/** Streaming xxhash64 of a file — fast enough to verify photos on copy without noticing. */
export async function fileHash(file: string): Promise<string> {
  const h = await createXXHash64();
  h.init();
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (chunk) => h.update(chunk as Buffer));
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return h.digest('hex');
}

/** Whether the import compares content hashes for this kind of file (size is always compared). */
export function hashVerifies(policy: Settings['importVerify'], kind: MediaKind): boolean {
  return policy === 'all' || (policy === 'photos' && kind !== 'video');
}
