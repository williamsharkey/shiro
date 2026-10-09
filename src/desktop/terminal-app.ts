/**
 * Terminal windows: the real Shiro terminal (ShiroTerminal + Shell, each with
 * its own pty) in desktop windows, with tabs. The page's main terminal
 * (`window.__shiro.terminal`) lives in the first window; closing it parks the
 * terminal instead of destroying it, and the next Terminal window adopts it.
 */

import type { Shell } from '../shell';
import { ShiroTerminal } from '../terminal';
import { setActiveTerminal } from '../active-terminal';
import type { DesktopWindow, WindowManager } from './wm';
import { GLYPHS } from './icons';

export interface TerminalDeps {
  makeShell: () => Shell;
  /** Shell of the main terminal (its tab title follows this shell's cwd) */
  mainShell: Shell;
}

interface Tab {
  pane: HTMLElement;
  tabEl: HTMLButtonElement;
  term: ShiroTerminal | null;
  shell: Shell | null;
  main: boolean;
  /** Title a program set with OSC 0/2, if any */
  osc: string;
}

const DARK = {
  background: '#14151d', foreground: '#e3e5ee', cursor: '#7ef0c1', cursorAccent: '#14151d',
  selectionBackground: 'rgba(126, 140, 255, .35)',
  black: '#1c1d27', red: '#ff6b7a', green: '#5ee08f', yellow: '#ffd76a', blue: '#7aa7ff', magenta: '#d38bff', cyan: '#5fe0e6', white: '#d8dae4',
  brightBlack: '#5b5f75', brightRed: '#ff8e9a', brightGreen: '#83f0ab', brightYellow: '#ffe594', brightBlue: '#9fc0ff', brightMagenta: '#e3adff', brightCyan: '#8cecf0', brightWhite: '#ffffff',
};
const LIGHT = {
  background: '#fbfbfd', foreground: '#1e1f2a', cursor: '#5b57f0', cursorAccent: '#fbfbfd',
  selectionBackground: 'rgba(91, 87, 240, .22)',
  black: '#1e1f2a', red: '#d0283f', green: '#14853b', yellow: '#9a6700', blue: '#2f5fe0', magenta: '#9a3bc7', cyan: '#0c7f8f', white: '#6c7083',
  brightBlack: '#8a8ea0', brightRed: '#e5485d', brightGreen: '#1f9d4b', brightYellow: '#b57d00', brightBlue: '#4a7af5', brightMagenta: '#b158dd', brightCyan: '#1593a6', brightWhite: '#2b2c38',
};

export function terminalTheme(theme: 'light' | 'dark') {
  return theme === 'light' ? LIGHT : DARK;
}

// Web font + generic only: each missing family costs a blocking font lookup in xterm's first measure
const MONO = '"JetBrains Mono", monospace';

/** Live views, for theming and for adopting the parked main terminal */
const views = new Set<TerminalView>();
let parking: HTMLElement | null = null;
/** The main terminal's pane while no window shows it */
let parkedMain: { pane: HTMLElement; term: ShiroTerminal | null } | null = null;

export class TerminalView {
  readonly root: HTMLElement;
  private tabsEl: HTMLElement;
  private stack: HTMLElement;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  /** Title to show instead of user@host: cwd (a program's window: "Vim") */
  fixedTitle = '';

  constructor(private win: DesktopWindow, private wm: WindowManager, private deps: TerminalDeps, body: HTMLElement) {
    views.add(this);
    this.root = document.createElement('div');
    this.root.className = 'sd-term';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'sd-tabs';
    this.stack = document.createElement('div');
    this.stack.className = 'sd-term-stack';
    this.root.append(this.tabsEl, this.stack);
    body.appendChild(this.root);
    if (win.titlebarExtra) {
      const plus = document.createElement('button');
      plus.className = 'sd-tb-btn';
      plus.title = 'New Tab (Alt+Shift+T)';
      plus.setAttribute('aria-label', 'New tab');
      plus.innerHTML = GLYPHS.plus;
      plus.addEventListener('click', () => this.newTab());
      win.titlebarExtra.appendChild(plus);
    }
    win.on('focus', () => this.active?.term?.term.focus());
    win.on('close', () => this.dispose());
  }

  /** Put the page's main terminal element in this view (before or after its ShiroTerminal exists). */
  adoptMain(pane: HTMLElement, term: ShiroTerminal | null): Tab {
    pane.classList.add('sd-term-pane');
    const tab = this.addTab(pane, term, term ? null : this.deps.mainShell, true);
    if (term) this.wireTerm(tab, term);
    return tab;
  }

  /** The main tab's terminal was created after adoptMain */
  attachMain(term: ShiroTerminal): void {
    const tab = this.tabs.find(t => t.main);
    if (!tab) return;
    tab.term = term;
    this.wireTerm(tab, term);
  }

  newTab(opts: { command?: string; cwd?: string } = {}): void {
    const pane = document.createElement('div');
    pane.className = 'sd-term-pane';
    const shell = this.deps.makeShell();
    if (opts.cwd) shell.cwd = opts.cwd;
    const tab = this.addTab(pane, null, shell, false);
    this.select(tab);
    const term = new ShiroTerminal(pane, shell);
    shell.setTerminal(term);
    tab.term = term;
    this.wireTerm(tab, term);
    term.startPane();
    if (opts.command) term.injectInput(opts.command + '\r');
    term.term.focus();
  }

  private addTab(pane: HTMLElement, term: ShiroTerminal | null, shell: Shell | null, main: boolean): Tab {
    const tabEl = document.createElement('button');
    tabEl.className = 'sd-tab';
    tabEl.type = 'button';
    tabEl.innerHTML = `<span class="sd-tab-title"></span><span class="sd-tab-x" role="button" aria-label="Close tab">${GLYPHS.x}</span>`;
    const tab: Tab = { pane, tabEl, term, shell: shell ?? this.deps.mainShell, main, osc: '' };
    tabEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sd-tab-x')) { this.closeTab(tab); return; }
      this.select(tab);
    });
    this.tabsEl.appendChild(tabEl);
    this.stack.appendChild(pane);
    this.tabs.push(tab);
    this.root.classList.toggle('sd-has-tabs', this.tabs.length > 1);
    if (!this.active) this.select(tab); else pane.hidden = true;
    this.updateTitle(tab);
    return tab;
  }

  private wireTerm(tab: Tab, term: ShiroTerminal): void {
    term.onExit = () => this.closeTab(tab);
    term.term.onTitleChange((t: string) => { tab.osc = t; this.updateTitle(tab); });
    // The prompt's cwd: refresh after each line the shell prints
    term.term.onLineFeed(() => this.updateTitle(tab));
    term.term.textarea?.addEventListener('focus', () => { if (this.active === tab) setActiveTerminal(term); });
  }

  select(tab: Tab): void {
    if (this.active === tab) return;
    this.active = tab;
    for (const t of this.tabs) {
      t.pane.hidden = t !== tab;
      t.tabEl.classList.toggle('sd-active', t === tab);
    }
    this.updateTitle(tab);
    if (tab.term) {
      setActiveTerminal(tab.term);
      requestAnimationFrame(() => { try { tab.term?.fitAddon.fit(); } catch {} tab.term?.term.focus(); });
    }
  }

  closeTab(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.tabEl.remove();
    if (tab.main) park(tab);
    else {
      try { tab.shell?.abortController?.abort(); } catch {}
      tab.pane.remove();
      tab.term?.dispose();
    }
    this.root.classList.toggle('sd-has-tabs', this.tabs.length > 1);
    if (!this.tabs.length) { this.active = null; this.win.close(true); return; }
    if (this.active === tab) { this.active = null; this.select(this.tabs[Math.min(i, this.tabs.length - 1)]); }
  }

  /** Window title: a program's OSC title, else user@host: cwd */
  private updateTitle(tab: Tab): void {
    const shell = tab.shell;
    let title = tab.osc || this.fixedTitle;
    if (!title && shell) {
      const home = shell.env['HOME'] || '/home/user';
      const cwd = shell.cwd;
      const shown = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
      title = `${shell.env['USER'] || 'user'}@shiro: ${shown}`;
    }
    const label = tab.tabEl.querySelector('.sd-tab-title');
    if (label && label.textContent !== title) label.textContent = title;
    if (this.active === tab) this.win.setTitle(title);
  }

  terminals(): ShiroTerminal[] {
    return this.tabs.map(t => t.term).filter((t): t is ShiroTerminal => !!t);
  }

  /** Working directory of the active tab's shell (session restore) */
  cwd(): string | undefined {
    return this.active?.shell?.cwd;
  }

  activeTerminal(): ShiroTerminal | null {
    return this.active?.term ?? null;
  }

  private dispose(): void {
    views.delete(this);
    for (const tab of [...this.tabs]) {
      if (tab.main) park(tab);
      else { try { tab.shell?.abortController?.abort(); } catch {} tab.term?.dispose(); }
    }
    this.tabs = [];
  }
}

function park(tab: Tab): void {
  if (!parking) {
    parking = document.createElement('div');
    parking.id = 'sd-parking';
    document.body.appendChild(parking);
  }
  parking.appendChild(tab.pane);
  tab.pane.hidden = false;
  parkedMain = { pane: tab.pane, term: tab.term };
}

export function hasParkedMain(): boolean {
  return !!parkedMain;
}

/** Take the parked main terminal, if it's waiting for a window. */
export function takeParkedMain(): { pane: HTMLElement; term: ShiroTerminal | null } | null {
  const p = parkedMain;
  parkedMain = null;
  return p;
}

export function allTerminalViews(): TerminalView[] {
  return [...views];
}

/** Restyle every desktop terminal for the theme. */
export function applyTerminalTheme(theme: 'light' | 'dark', extra: ShiroTerminal[] = []): void {
  const t = terminalTheme(theme);
  const seen = new Set<ShiroTerminal>();
  for (const v of views) for (const term of v.terminals()) seen.add(term);
  for (const term of extra) seen.add(term);
  for (const term of seen) term.term.options.theme = t;
}

/** Use the bundled mono font once it has loaded (xterm measures glyphs when the family changes). */
export function useMonoFont(terms: () => ShiroTerminal[]): void {
  const apply = () => {
    for (const t of terms()) {
      // xterm re-measures only when the family string changes
      t.term.options.fontFamily = t.term.options.fontFamily === MONO ? MONO + ', monospace' : MONO;
      try { t.fitAddon.fit(); } catch {}
    }
  };
  if (!document.fonts?.load) { apply(); return; }
  document.fonts.load('14px "JetBrains Mono"').then(apply, apply);
}

export { MONO as TERMINAL_FONT };
