/**
 * Which UI the page boots: the desktop (src/desktop, the Unix edition) or
 * shiro.computer's full-page terminal.
 *
 * `?ui=desktop` / `?ui=terminal` choose and remember (localStorage
 * `shiro-ui`). Embedded pages (seeds), `?demo=1` and app ("become") mode
 * always use the terminal. Otherwise the product profile decides
 * (src/profile.ts): shiro.computer and its subdomains get the terminal, every
 * other host (tabcomputer.com, localhost) the desktop.
 */
import { selectProfile } from './profile';

export type UiMode = 'desktop' | 'terminal';

export const UI_MODE_KEY = 'shiro-ui';

export function uiMode(loc: Pick<Location, 'search' | 'hostname'> = location, embedded = window.parent !== window): UiMode {
  const q = new URLSearchParams(loc.search);
  const asked = q.get('ui');
  if (asked === 'desktop' || asked === 'terminal') {
    try { localStorage.setItem(UI_MODE_KEY, asked); } catch {}
    return asked;
  }
  if (q.get('demo') === '1' || embedded) return 'terminal';
  try { if (localStorage.getItem('shiro-become')) return 'terminal'; } catch {}
  try {
    const saved = localStorage.getItem(UI_MODE_KEY);
    if (saved === 'desktop' || saved === 'terminal') return saved;
  } catch {}
  return selectProfile(loc).ui;
}
