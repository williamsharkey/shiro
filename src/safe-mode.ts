/**
 * Safe mode: a boot that skips everything started or restored from saved
 * state, so a machine whose saved state freezes the page can still be
 * reached and fixed.
 *
 * On for this load with `?safe=1` (`?safe`, `#safe`), and on its own when the
 * tab's last UNFINISHED_LIMIT loads never reached the first prompt (a
 * counter in sessionStorage, which survives reloads of the tab and doesn't
 * depend on localStorage). Skipped: ~/.profile (and what it autostarts), the
 * desktop and its saved windows, the saved panes layout, app ("become") mode,
 * seed imports, the remote reconnect, the profile's preinstall, the X11 and
 * GL servers, and reading the previous page's console log. The `safe-mode`
 * command shows this and offers resets.
 *
 * No imports: console-log.ts, the first module main.ts loads, asks it.
 */

/** localStorage keys of restored state that `safe-mode reset-layout` clears */
export const RESTORED_STATE_KEYS = ['tabcomputer-desktop-session', 'tabcomputer-panes', 'tabcomputer-console-log', 'tabcomputer-become'];
/** sessionStorage: loads since the last one that reached the prompt */
export const UNFINISHED_KEY = 'tabcomputer-boots-unfinished';
export const UNFINISHED_LIMIT = 2;

type Loc = Pick<Location, 'search' | 'hash'>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): Store | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

/** Why this load is in safe mode, or null. */
export function safeModeReason(loc: Loc | null = typeof location !== 'undefined' ? location : null, session: Store | null = sessionStore()): string | null {
  if (loc) {
    const q = new URLSearchParams(loc.search);
    if (q.has('safe') && q.get('safe') !== '0') return 'asked for (?safe=1)';
    if (/^#safe\b/.test(loc.hash)) return 'asked for (#safe)';
  }
  let n = 0;
  try { n = Number(session?.getItem(UNFINISHED_KEY)) || 0; } catch { /* no storage */ }
  if (n >= UNFINISHED_LIMIT) return `the last ${n} loads of this tab never reached the prompt`;
  return null;
}

let cached: string | null | undefined;
/** Safe mode for this page load (decided once, before this load is counted). */
export function safeMode(): string | null {
  if (cached === undefined) cached = safeModeReason();
  return cached;
}
export const isSafeMode = (): boolean => safeMode() !== null;

/** Count this load as unfinished until bootFinished(). */
export function bootStarted(session: Store | null = sessionStore()): void {
  safeMode(); // decided on the count before this load
  try { session?.setItem(UNFINISHED_KEY, String((Number(session.getItem(UNFINISHED_KEY)) || 0) + 1)); } catch { /* no storage */ }
}

/** The first prompt is up: the next load is a normal one again. */
export function bootFinished(session: Store | null = sessionStore()): void {
  try { session?.removeItem(UNFINISHED_KEY); } catch { /* no storage */ }
}

/** Steps that failed or timed out this boot (`safe-mode` lists them). */
export const bootProblems: string[] = [];

/**
 * Run a boot step so that a throw or a hang can't hold up the prompt: errors
 * are logged, and after `ms` the boot goes on without it (the step keeps
 * running). Returns its value, or undefined.
 */
export async function bootStep<T>(name: string, fn: () => T | Promise<T>, ms = 15000): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
  try {
    const run = Promise.resolve().then(fn);
    const r = await Promise.race([run, late]);
    if (r === 'timeout') {
      bootProblems.push(`${name}: still running after ${ms / 1000} s (boot went on without it)`);
      console.warn(`[boot] ${name}: still running after ${ms / 1000} s; going on without it`);
      run.catch((e) => console.warn(`[boot] ${name} failed later:`, e));
      return undefined;
    }
    return r as T;
  } catch (e) {
    bootProblems.push(`${name}: ${(e as Error)?.message ?? e}`);
    console.warn(`[boot] ${name} failed:`, e);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The page's URL without safe mode's switches. */
export function normalUrl(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('safe');
  if (/^#safe\b/.test(u.hash)) u.hash = '';
  return u.toString();
}

/** The lines the terminal shows in safe mode. */
export function safeModeBanner(reason: string, href: string): string[] {
  return [
    `\x1b[1;33mSafe mode\x1b[0m: ${reason}.`,
    'Skipped: ~/.profile, saved windows and panes, app mode, preinstalls, the X11 display, the remote reconnect.',
    '  safe-mode                    what was skipped, and boot steps that failed',
    '  safe-mode reset-layout       forget saved windows, panes, app mode and the console log',
    '  safe-mode disable-profile    rename ~/.profile so it no longer runs at boot',
    `  safe-mode exit               leave safe mode (reload ${normalUrl(href)})`,
  ];
}
