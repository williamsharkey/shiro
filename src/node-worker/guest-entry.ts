/** The browser Worker for node as a kernel guest (host.ts creates it) */
import { nodeGuestMain } from './guest';

// The Worker's own postMessage and message listener, taken now: a script may replace the
// global postMessage/onmessage (emnapi's thread workers do, as on node's worker_threads)
const post = self.postMessage.bind(self);
nodeGuestMain((h) => { self.addEventListener('message', (e: MessageEvent) => h(e.data)); }, (m) => post(m));
