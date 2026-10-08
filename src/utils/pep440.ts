/**
 * Python packaging rules pip needs: PEP 440 versions and specifiers,
 * PEP 508 requirements and environment markers, wheel file names (PEP 427)
 * and name normalization (PEP 503).
 */

export interface PyVersion {
  epoch: number;
  release: number[];
  pre?: [string, number];   // a | b | rc
  post?: number;
  dev?: number;
  local?: string;
  text: string;
}

const VERSION_RE = /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

export function parseVersion(text: string): PyVersion | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const v: PyVersion = { epoch: m[1] ? +m[1] : 0, release: m[2].split('.').map(Number), text: text.trim() };
  if (m[3]) {
    const l = m[3].toLowerCase();
    v.pre = [l === 'alpha' ? 'a' : l === 'beta' ? 'b' : (l === 'c' || l === 'pre' || l === 'preview') ? 'rc' : l, m[4] ? +m[4] : 0];
  }
  if (m[5] !== undefined) v.post = +m[5];
  else if (m[6] !== undefined) v.post = m[6] ? +m[6] : 0;
  if (m[7] !== undefined) v.dev = m[7] ? +m[7] : 0;
  if (m[9]) v.local = m[9].toLowerCase();
  return v;
}

export const isPrerelease = (v: PyVersion) => v.pre !== undefined || v.dev !== undefined;

function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

/** Sort key pieces after the release, per PEP 440. */
function suffixKey(v: PyVersion): number[] {
  // dev-only releases sort before pre-releases of the same release
  const pre = v.pre ? [PRE_ORDER[v.pre[0]], v.pre[1]] : (v.post === undefined && v.dev !== undefined ? [-1, 0] : [9, 0]);
  const post = v.post === undefined ? -1 : v.post;
  const dev = v.dev === undefined ? Infinity : v.dev;
  return [...pre, post, dev];
}

export function compareVersions(a: PyVersion, b: PyVersion): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  const r = cmpRelease(a.release, b.release);
  if (r) return r;
  const ka = suffixKey(a), kb = suffixKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  if ((a.local ?? '') !== (b.local ?? '')) return (a.local ?? '') < (b.local ?? '') ? -1 : 1;
  return 0;
}

export interface Specifier { op: string; version: string }

export function parseSpecifiers(text: string): Specifier[] {
  const out: Specifier[] = [];
  for (const part of text.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(.+)$/.exec(t);
    if (!m) throw new Error(`invalid version specifier: ${t}`);
    out.push({ op: m[1], version: m[2].trim() });
  }
  return out;
}

function matchOne(v: PyVersion, s: Specifier): boolean {
  if (s.op === '===') return v.text === s.version;
  if ((s.op === '==' || s.op === '!=') && s.version.endsWith('.*')) {
    const p = parseVersion(s.version.slice(0, -2));
    if (!p) return false;
    const prefix = v.epoch === p.epoch && p.release.every((n, i) => (v.release[i] ?? 0) === n);
    return s.op === '==' ? prefix : !prefix;
  }
  const sv = parseVersion(s.version);
  if (!sv) return false;
  const pub = { ...v, local: sv.local ? v.local : undefined };
  const c = compareVersions(pub, sv);
  switch (s.op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
    // < and > exclude pre/post releases of the named version itself
    case '<': return c < 0 && !(isPrerelease(v) && !isPrerelease(sv) && cmpRelease(v.release, sv.release) === 0);
    case '>': return c > 0 && !(v.post !== undefined && sv.post === undefined && cmpRelease(v.release, sv.release) === 0);
    case '~=': {
      if (sv.release.length < 2) return false;
      const upper = sv.release.slice(0, -1);
      return c >= 0 && v.epoch === sv.epoch && upper.every((n, i) => (v.release[i] ?? 0) === n);
    }
  }
  return false;
}

/** Does `version` satisfy every specifier? Pre-releases only when allowed or named. */
export function satisfies(version: string | PyVersion, specs: Specifier[], allowPre = false): boolean {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return false;
  if (isPrerelease(v) && !allowPre && !specs.some(s => { const p = parseVersion(s.version.replace(/\.\*$/, '')); return p && isPrerelease(p); })) return false;
  return specs.every(s => matchOne(v, s));
}

/** PEP 503 normalized project name. */
export const normalizeName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

// ── PEP 508 ────────────────────────────────────────────────────────────

export interface Requirement {
  name: string;
  extras: string[];
  specifiers: Specifier[];
  url?: string;
  marker?: string;
  text: string;
}

export function parseRequirement(text: string): Requirement {
  const t = text.trim();
  let body = t, marker: string | undefined;
  const semi = t.indexOf(';');
  if (semi >= 0) { body = t.slice(0, semi).trim(); marker = t.slice(semi + 1).trim(); }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(body);
  if (!m) throw new Error(`invalid requirement: ${text}`);
  let rest = m[3].trim();
  let url: string | undefined;
  if (rest.startsWith('@')) { url = rest.slice(1).trim(); rest = ''; }
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1);
  return {
    name: m[1], extras: m[2] ? m[2].split(',').map(s => s.trim()).filter(Boolean) : [],
    specifiers: parseSpecifiers(rest), url, marker, text: t,
  };
}

export type MarkerEnv = Record<string, string>;

/** The environment Shiro's WASI CPython reports. */
export function markerEnv(pyVersion = '3.13.7'): MarkerEnv {
  return {
    os_name: 'posix', sys_platform: 'wasi', platform_machine: 'wasm32', platform_python_implementation: 'CPython',
    platform_release: '', platform_system: 'WASI', platform_version: '', python_version: pyVersion.split('.').slice(0, 2).join('.'),
    python_full_version: pyVersion, implementation_name: 'cpython', implementation_version: pyVersion, extra: '',
  };
}

const VERSION_KEYS = new Set(['python_version', 'python_full_version', 'implementation_version', 'platform_release']);

/** Evaluate a PEP 508 marker. `extra` comparisons match any of `extras`. */
export function evalMarker(marker: string, env: MarkerEnv, extras: string[] = []): boolean {
  const toks = marker.match(/\s*("[^"]*"|'[^']*'|\(|\)|===|==|!=|<=|>=|~=|<|>|not\s+in\b|in\b|and\b|or\b|[A-Za-z_][A-Za-z0-9_.]*)\s*/g)?.map(s => s.trim()) ?? [];
  let i = 0;
  const value = (): { v: string; key?: string } => {
    const t = toks[i++];
    if (t === undefined) throw new Error(`bad marker: ${marker}`);
    if (t[0] === '"' || t[0] === "'") return { v: t.slice(1, -1) };
    return { v: env[t] ?? '', key: t };
  };
  const cmp = (): boolean => {
    if (toks[i] === '(') { i++; const r = or(); i++; return r; }
    const l = value();
    const op = toks[i++].replace(/\s+/g, ' ');
    const r = value();
    if (l.key === 'extra' || r.key === 'extra') {
      const lit = normalizeName(l.key === 'extra' ? r.v : l.v);
      const has = extras.some(e => normalizeName(e) === lit);
      return op === '!=' ? !has : op === '==' ? has : false;
    }
    if (op === 'in') return r.v.includes(l.v);
    if (op === 'not in') return !r.v.includes(l.v);
    const versiony = VERSION_KEYS.has(l.key ?? '') || VERSION_KEYS.has(r.key ?? '');
    if (versiony && parseVersion(l.v) && parseVersion(r.v)) return satisfies(l.v, [{ op, version: r.v }], true);
    switch (op) {
      case '==': case '===': return l.v === r.v;
      case '!=': return l.v !== r.v;
      case '<': return l.v < r.v;
      case '<=': return l.v <= r.v;
      case '>': return l.v > r.v;
      case '>=': return l.v >= r.v;
    }
    return false;
  };
  const and = (): boolean => { let r = cmp(); while (toks[i] === 'and') { i++; const x = cmp(); r = r && x; } return r; };
  const or = (): boolean => { let r = and(); while (toks[i] === 'or') { i++; const x = and(); r = r || x; } return r; };
  return or();
}

// ── wheels ─────────────────────────────────────────────────────────────

export interface WheelName { name: string; version: string; build?: string; pythonTags: string[]; abiTags: string[]; platformTags: string[] }

export function parseWheelName(file: string): WheelName | null {
  const parts = file.replace(/\.whl$/, '').split('-');
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [name, version] = parts;
  const [py, abi, plat] = parts.slice(-3);
  return { name, version, build: parts.length === 6 ? parts[2] : undefined,
    pythonTags: py.split('.'), abiTags: abi.split('.'), platformTags: plat.split('.') };
}

/** A pure-Python wheel this interpreter can install (pyN / cpNN with abi none, any platform). */
export function wheelCompatible(w: WheelName, pyMinor = 13): boolean {
  if (!w.platformTags.includes('any') || !w.abiTags.includes('none')) return false;
  return w.pythonTags.some(t => t === 'py3' || t === `py3${pyMinor}` || t === `cp3${pyMinor}` ||
    (/^py3\d+$/.test(t) && +t.slice(3) <= pyMinor));
}
