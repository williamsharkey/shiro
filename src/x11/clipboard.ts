/**
 * CLIPBOARD between X apps and the browser.
 *
 * - An X app copies (takes the CLIPBOARD selection): the bridge, an internal
 *   X client, converts it to UTF8_STRING and writes the text to the
 *   browser clipboard.
 * - The browser clipboard may have changed (a copy elsewhere in the page,
 *   or the tab regained focus): the next time an X window gets focus, the
 *   bridge takes CLIPBOARD and answers the apps' SelectionRequests with
 *   `navigator.clipboard.readText()`.
 */
import type { XServer, XWindow, Client } from './server';
import { SelectionClear, SelectionNotify, SelectionRequest } from './proto';

export interface ClipboardAccess {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const PROP = '_SHIRO_CLIPBOARD';

export class ClipboardBridge {
  private c: Client;
  private win: XWindow;
  private waiting: ((ok: boolean) => void) | null = null;
  private owned = false;
  /** The browser clipboard may hold something the X side hasn't seen. */
  browserDirty = true;
  /** Last text exchanged, to avoid echoing it back. */
  lastText: string | null = null;

  constructor(readonly server: XServer, private clip: ClipboardAccess | null) {
    this.c = server.internalClient((e) => this.event(e));
    this.win = server.internalWindow(this.c);
  }

  /** server.hooks.selectionOwned */
  selectionOwned(selection: string, owner: XWindow | null): void {
    if (selection !== 'CLIPBOARD') return;
    if (owner && owner.owner !== this.c) {
      this.owned = false;
      void this.pull();
    }
  }

  /** An X window got focus: offer the browser clipboard to X apps if it may be new. */
  focusIn(): void {
    if (!this.clip || !this.browserDirty) return;
    this.browserDirty = false;
    this.server.ownSelection(this.c, this.win, 'CLIPBOARD');
    this.owned = true;
  }

  /** Fetch the X owner's text into the browser clipboard. */
  async pull(): Promise<string | null> {
    for (const target of ['UTF8_STRING', 'STRING']) {
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => { this.waiting = null; resolve(false); }, 3000);
        this.waiting = (v) => { clearTimeout(t); resolve(v); };
        this.server.convertSelectionFor(this.c, this.win, 'CLIPBOARD', target, PROP);
      });
      if (!ok) continue;
      const p = this.server.prop(this.win, PROP);
      if (!p) continue;
      const text = target === 'STRING' ? latin1(p.data) : new TextDecoder().decode(p.data);
      this.win.props.delete(this.server.atom(PROP));
      this.lastText = text;
      try { await this.clip?.writeText(text); } catch { /* no permission: X apps still share it */ }
      return text;
    }
    return null;
  }

  private event(e: Uint8Array): void {
    const dv = new DataView(e.buffer, e.byteOffset, 32);
    const code = e[0] & 0x7f;
    if (code === SelectionNotify && this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(dv.getUint32(20, true) !== 0);
    } else if (code === SelectionRequest) {
      void this.serve(dv.getUint32(4, true), dv.getUint32(12, true), dv.getUint32(16, true), dv.getUint32(20, true), dv.getUint32(24, true));
    } else if (code === SelectionClear) {
      this.owned = false;
    }
  }

  /** Answer an X app's paste from the browser clipboard. */
  private async serve(time: number, requestor: number, selection: number, target: number, property: number): Promise<void> {
    const s = this.server;
    const prop = property || target;
    const name = s.atomName(target) ?? '';
    const reqWin = s.winOrNull(requestor);
    const refuse = () => s.selectionNotify(requestor, selection, target, 0, time);
    if (!reqWin || !this.owned) return refuse();
    if (name === 'TARGETS') {
      const atoms = ['TARGETS', 'UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8', 'text/plain'].map((a) => s.atom(a));
      const data = new Uint8Array(atoms.length * 4);
      atoms.forEach((a, i) => new DataView(data.buffer).setUint32(i * 4, a, true));
      s.setProperty(reqWin, prop, s.atom('ATOM'), 32, data);
      return s.selectionNotify(requestor, selection, target, prop, time);
    }
    if (!['UTF8_STRING', 'STRING', 'TEXT', 'text/plain;charset=utf-8', 'text/plain'].includes(name)) return refuse();
    let text: string;
    try { text = (await this.clip?.readText()) ?? ''; } catch { return refuse(); }
    this.lastText = text;
    const isLatin1 = name === 'STRING' || name === 'text/plain';
    const data = isLatin1 ? Uint8Array.from(text, (ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 0x3f; }) : new TextEncoder().encode(text);
    s.setProperty(reqWin, prop, s.atom(isLatin1 ? 'STRING' : 'UTF8_STRING'), 8, data);
    s.selectionNotify(requestor, selection, target, prop, time);
  }
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
}
