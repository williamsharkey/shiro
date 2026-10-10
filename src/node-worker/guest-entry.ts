/** The browser Worker for node as a kernel guest (host.ts creates it) */
import { nodeGuestMain } from './guest';

nodeGuestMain((h) => { self.onmessage = (e: MessageEvent) => h(e.data); }, (m) => (self as any).postMessage(m));
