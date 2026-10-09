/** Worker side of src/gui/deb.ts: .deb bytes in, data.tar entries out (their buffers transferred). */
import { debEntries } from './deb';

self.onmessage = async (ev: MessageEvent<{ deb: Uint8Array }>) => {
  try {
    const entries = await debEntries(ev.data.deb);
    const buffers = new Set<ArrayBuffer>();
    for (const e of entries) if (e.data.byteLength) buffers.add(e.data.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ entries }, [...buffers]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ error: (e as Error).message ?? String(e) });
  }
};
