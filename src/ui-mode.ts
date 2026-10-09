/**
 * Which UI the page boots: the desktop (src/desktop, the Unix edition) or
 * shiro.computer's full-page terminal.
 *
 * `?ui=desktop` / `?ui=terminal` choose and remember (localStorage
 * `shiro-ui`). Without a choice: shiro.computer and its subdomains keep the
 * terminal; embedded pages (seeds), `?demo=1` and app ("become") mode always
 * use it; every other host (unix.computer, localhost) gets the desktop.
 */

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
  const h = loc.hostname;
  return h === 'shiro.computer' || h.endsWith('.shiro.computer') ? 'terminal' : 'desktop';
}
