/**
 * `npm run test:worker` (vitest.worker.config.ts): every test shell's node
 * runs as a kernel guest, the default in a page that can (a Node
 * worker_threads Worker stands in for the browser's).
 */
import { installNodeWorker } from './node-worker-setup';

await installNodeWorker();
