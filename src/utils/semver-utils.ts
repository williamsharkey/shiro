/**
 * semver-utils.ts: Semantic version parsing and range resolution
 *
 * Implements subset of semver spec for npm version resolution:
 * - Exact versions: "1.2.3"
 * - Caret ranges: "^1.2.3" (compatible with 1.x.x)
 * - Tilde ranges: "~1.2.3" (compatible with 1.2.x)
 * - Wildcard: "*" or "latest"
 * - Comparator ranges: ">=1.2.3 <2.0.0"
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
  raw: string;
}

/**
 * Parse a semantic version string
 */
export function parseSemVer(version: string): SemVer | null {
  // Remove leading 'v' if present
  version = version.trim();
  if (version.startsWith('v')) {
    version = version.slice(1);
  }

  // Match semver pattern: major.minor.patch[-prerelease][+build]
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/
  );

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
    build: match[5],
    raw: version,
  };
}

/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  // Compare major.minor.patch
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Prerelease versions have lower precedence
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) {
    const pa = a.prerelease.split('.'), pb = b.prerelease.split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      if (pa[i] === pb[i]) continue;
      const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
      if (na && nb) return parseInt(pa[i], 10) - parseInt(pb[i], 10);
      if (na !== nb) return na ? -1 : 1;
      return pa[i] < pb[i] ? -1 : 1;
    }
  }

  return 0;
}

type Bound = { op: '>=' | '>' | '<' | '<=' | '='; v: SemVer };

function satisfiesComparator(version: SemVer, operator: Bound['op'], target: SemVer): boolean {
  const cmp = compareSemVer(version, target);
  switch (operator) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
  }
}

/** Parse a possibly partial version with x/X/* wildcards: "1", "1.2", "1.2.x", "1.2.3-beta.1". */
function parsePartial(str: string): { major?: number; minor?: number; patch?: number; prerelease?: string } | null {
  const m = str.trim().replace(/^[v=]+/, '').match(/^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const num = (x?: string) => (x === undefined || /^[xX*]$/.test(x) ? undefined : parseInt(x, 10));
  const major = num(m[1]);
  const minor = major === undefined ? undefined : num(m[2]);
  const patch = minor === undefined ? undefined : num(m[3]);
  return { major, minor, patch, prerelease: patch === undefined ? undefined : m[4] };
}

const sv = (major: number, minor: number, patch: number, prerelease?: string): SemVer =>
  ({ major, minor, patch, prerelease, raw: `${major}.${minor}.${patch}${prerelease ? '-' + prerelease : ''}` });

/** Desugar one comparator (^1.2, ~1.2.3, >=1.0, 1.x, 1.2.3) into plain bounds, as npm does. */
function comparatorBounds(comp: string): Bound[] | null {
  const m = comp.match(/^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/)!;
  const op = m[1] || '';
  const p = parsePartial(m[2]);
  if (!p) return null;
  const { major, minor, patch, prerelease } = p;
  if (major === undefined) return op === '<' || op === '>' ? [{ op: '<', v: sv(0, 0, 0, '0') }] : [];
  const lo = sv(major, minor ?? 0, patch ?? 0, prerelease);
  switch (op) {
    case '^': {
      const hi = major > 0 || minor === undefined ? sv(major + 1, 0, 0, '0')
        : minor > 0 || patch === undefined ? sv(0, minor + 1, 0, '0')
        : sv(0, 0, patch + 1, '0');
      return [{ op: '>=', v: lo }, { op: '<', v: hi }];
    }
    case '~': case '~>': {
      const hi = minor === undefined ? sv(major + 1, 0, 0, '0') : sv(major, minor + 1, 0, '0');
      return [{ op: '>=', v: lo }, { op: '<', v: hi }];
    }
    case '>': // >1.2 means >=1.3.0
      if (minor === undefined) return [{ op: '>=', v: sv(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: '>=', v: sv(major, minor + 1, 0) }];
      return [{ op: '>', v: lo }];
    case '<=': // <=1.2 means <1.3.0
      if (minor === undefined) return [{ op: '<', v: sv(major + 1, 0, 0, '0') }];
      if (patch === undefined) return [{ op: '<', v: sv(major, minor + 1, 0, '0') }];
      return [{ op: '<=', v: lo }];
    case '>=': return [{ op: '>=', v: lo }];
    case '<': return [{ op: '<', v: lo }];
    default: // bare or '=': partial versions are x-ranges (1.2 = 1.2.x)
      if (minor === undefined) return [{ op: '>=', v: lo }, { op: '<', v: sv(major + 1, 0, 0, '0') }];
      if (patch === undefined) return [{ op: '>=', v: lo }, { op: '<', v: sv(major, minor + 1, 0, '0') }];
      return [{ op: '=', v: lo }];
  }
}

/** Bounds for one ||-separated alternative: "a - b" or space-separated comparators. */
function rangeSetBounds(set: string): Bound[] | null {
  const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hyphen) {
    // 1.2.3 - 2.3 := >=1.2.3 <2.4.0-0 (a partial upper end includes its whole x-range)
    const from = comparatorBounds('>=' + hyphen[1]);
    const to = comparatorBounds('<=' + hyphen[2]);
    return from && to ? [...from, ...to] : null;
  }
  // "> = 1.2.3" / ">= 1.2.3": attach operators to their version
  const comps = set.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
  const bounds: Bound[] = [];
  for (const c of comps) {
    const b = comparatorBounds(c);
    if (!b) return null;
    bounds.push(...b);
  }
  return bounds;
}

/**
 * Check if version satisfies a range specification
 */
export function satisfiesRange(versionStr: string, rangeStr: string): boolean {
  rangeStr = rangeStr.trim();
  if (rangeStr === 'latest') return true;
  const version = parseSemVer(versionStr);
  if (!version) return false;
  return rangeStr.split('||').some((set) => {
    const bounds = rangeSetBounds(set.trim());
    if (!bounds) return false;
    if (!bounds.every((b) => satisfiesComparator(version, b.op, b.v))) return false;
    // Prereleases only match a range that names a prerelease of the same version
    if (!version.prerelease) return true;
    return bounds.some((b) => b.v.prerelease && b.v.prerelease !== '0'
      && b.v.major === version.major && b.v.minor === version.minor && b.v.patch === version.patch);
  });
}

/**
 * Find the maximum version from a list that satisfies a range
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  const satisfying = versions.filter(v => satisfiesRange(v, range));
  if (satisfying.length === 0) return null;

  // Parse and sort
  const parsed = satisfying
    .map(v => parseSemVer(v))
    .filter((v): v is SemVer => v !== null);

  if (parsed.length === 0) return null;

  parsed.sort((a, b) => compareSemVer(b, a)); // Descending order
  return parsed[0].raw;
}

/**
 * Coerce a version string to valid semver
 */
export function coerce(version: string): string {
  version = version.trim();

  // Remove leading 'v'
  if (version.startsWith('v')) {
    version = version.slice(1);
  }

  // Try to extract major.minor.patch from partial versions
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (match) {
    const major = match[1];
    const minor = match[2] || '0';
    const patch = match[3] || '0';
    return `${major}.${minor}.${patch}`;
  }

  // Default to 0.0.0 if can't parse
  return '0.0.0';
}

/**
 * Increment a version by type
 */
export function increment(version: string, type: 'major' | 'minor' | 'patch'): string {
  const semver = parseSemVer(version);
  if (!semver) return version;

  switch (type) {
    case 'major':
      return `${semver.major + 1}.0.0`;
    case 'minor':
      return `${semver.major}.${semver.minor + 1}.0`;
    case 'patch':
      return `${semver.major}.${semver.minor}.${semver.patch + 1}`;
    default:
      return version;
  }
}
