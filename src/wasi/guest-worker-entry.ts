/** Worker entry point (bundled inline by Vite via ./browser-worker.ts). */
import { guestMain, type Port } from './guest-worker';

guestMain(self as unknown as Port);
