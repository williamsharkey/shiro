/**
 * One X server per display, created on the first client connection
 * (display.ts): the protocol server with RENDER, and a rootless bridge to
 * the desktop's window host. Headless (no DOM, e.g. vitest) sessions have
 * no bridge; tests read windows through the server and compose.ts.
 */
import { XServer } from './server';
import { installRender } from './render';
import { Rootless } from './rootless';
import { getWindowHost, type WindowHost } from '../gui/window-host';

export interface XSession {
  display: number;
  server: XServer;
  rootless: Rootless | null;
  started: number;
}

const sessions = new Map<number, Promise<XSession>>();
let opts: { host?: WindowHost | null; headless?: boolean; width?: number; height?: number } = {};

/** Tests: run headless or with a given host and screen size. Call before the first connection. */
export function configureXSession(o: typeof opts): void { opts = o; }

export function getXSession(display = 0): Promise<XSession> {
  let s = sessions.get(display);
  if (!s) {
    s = create(display);
    sessions.set(display, s);
  }
  return s;
}

/** The running session, if a client ever connected. */
export async function peekXSession(display = 0): Promise<XSession | null> {
  const s = sessions.get(display);
  return s ? s : null;
}

/** Forget a display's session (tests). */
export function resetXSession(display = 0): void { sessions.delete(display); }

async function create(display: number): Promise<XSession> {
  const headless = opts.headless ?? typeof document === 'undefined';
  const host = headless ? null : opts.host ?? (await getWindowHost());
  const size = host?.desktopSize() ?? { width: opts.width ?? 1280, height: opts.height ?? 800 };
  const server = new XServer({ width: opts.width ?? size.width, height: opts.height ?? size.height });
  server.log = (s) => console.warn('[Xshiro]', s);
  installRender(server);
  const rootless = host ? new Rootless(server, host) : null;
  if (typeof window !== 'undefined') (window as unknown as { __shiroX?: unknown }).__shiroX = { server, rootless };
  return { display, server, rootless, started: Date.now() };
}
