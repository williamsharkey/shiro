/**
 * The product profile this page runs as (docs/PROFILES.md): shiro.computer's
 * terminal-first Shiro, or tabcomputer, the Unix edition with the desktop.
 * A profile is data in profiles/<id>/profile.json: its UI mode, brand, banner,
 * the packages boot installs, and which Shiro-specific shims are on. The engine
 * (everything else under src/) asks `activeProfile()` instead of looking at
 * the hostname.
 *
 * Chosen by host (profiles/select.mjs, shared with server.mjs). `?profile=ID`
 * picks one and remembers it (localStorage `tabcomputer-profile`); `?profile=` with
 * no value forgets it.
 */
import { pickProfile } from '../profiles/select.mjs';
import shiro from '../profiles/shiro/profile.json';
import tabcomputer from '../profiles/tabcomputer/profile.json';

export interface Brand { name: string; domain: string; tagline: string; description: string }

export interface ProfileShims {
  /** What plain `claude` runs: the pinned npm build, or the native binary (`claude --native`) */
  claude: 'npm' | 'native';
  /** curl/fetch of claude.ai/install.sh returns a stand-in that npm-installs the pinned build */
  claudeInstallSh: boolean;
  /** `ssh CODE` is Shiro's tab-to-tab ssh over WebRTC (OpenSSH still takes user@host) */
  tabSsh: boolean;
  /** Shiro builtins stat as executables in /bin, /usr/bin, /usr/local/bin for WASM/x86 programs */
  binCommandStat: boolean;
  /** Debian mode diverts programs to Shiro builtins by default (src/debian/overlay-policy.json) */
  debianOverlay: boolean;
  /** `python`/`python3` without a package: Pyodide, or nothing (pkg/apt python3 only) */
  python: 'pyodide' | 'package';
}

export interface Profile {
  id: string;
  /** The product's name in messages, help and banners ("tabcomputer" is always lowercase) */
  name: string;
  /** The machine's hostname: the prompt's \h, uname, /etc/hostname, os.hostname() */
  hostname: string;
  description: string;
  /** Host patterns this profile serves ("example.com", "*.example.com") */
  hosts: string[];
  /** Serves hosts no profile names (localhost, previews) */
  default?: boolean;
  ui: 'desktop' | 'terminal';
  /** The product name for titles and link previews; null keeps the page's own */
  brand: Brand | null;
  /** The terminal's startup banner: the full HUD, or the desktop's compact welcome */
  banner: 'hud' | 'desktop';
  /** Installed in the background after boot ('claude-code': the pinned npm build) */
  preinstall: string[];
  shims: ProfileShims;
}

export const PROFILES: readonly Profile[] = [shiro as Profile, tabcomputer as Profile];

export const PROFILE_KEY = 'tabcomputer-profile';

/** The profile for `loc` (default: this page), honoring and remembering ?profile=. */
export function selectProfile(loc: Pick<Location, 'search' | 'hostname'> | null = typeof location !== 'undefined' ? location : null): Profile {
  let override: string | null = null;
  if (loc) {
    const q = new URLSearchParams(loc.search);
    if (q.has('profile')) {
      override = q.get('profile') || null;
      try {
        if (override && PROFILES.some((p) => p.id === override)) localStorage.setItem(PROFILE_KEY, override);
        else localStorage.removeItem(PROFILE_KEY);
      } catch {}
    } else {
      try { override = localStorage.getItem(PROFILE_KEY); } catch {}
    }
  }
  return pickProfile([...PROFILES], loc?.hostname ?? '', override);
}

let active: Profile | null = null;

/** The page's profile, chosen once (Node tests and workers get the default one). */
export function activeProfile(): Profile {
  return active ??= selectProfile();
}

/** Tests: run as another profile (null: choose again). */
export function setActiveProfile(p: Profile | string | null): void {
  active = typeof p === 'string' ? PROFILES.find((x) => x.id === p) ?? null : p;
}

/** uname(2)'s release and version (and /proc/version's): Linux 6.1, named for the host */
export const unameRelease = (hostname = activeProfile().hostname): string => `6.1.0-${hostname}`;
export const UNAME_VERSION = '#1 SMP PREEMPT_DYNAMIC';
