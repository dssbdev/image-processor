import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the decoder worker pools (HEIC, LibRaw) have in common. */

/** A request waiting for its worker's answer. */
export interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Absolute path of a worker script that lives next to the decoders. */
export function workerScript(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

/** The bytes copied into an ArrayBuffer of their own, so it can be transferred to a worker instead of cloned. */
export function toTransferable(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}
