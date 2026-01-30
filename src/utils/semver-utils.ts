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
    return a.prerelease.localeCompare(b.prerelease);
  }

  return 0;
}

/**
 * Check if version satisfies a caret range (^1.2.3)
 * Allows changes that do not modify the left-most non-zero digit
 */
function satisfiesCaret(version: SemVer, range: SemVer): boolean {
  if (version.major !== range.major) return false;

  if (range.major > 0) {
    // ^1.2.3 := >=1.2.3 <2.0.0
    return version.minor > range.minor ||
           (version.minor === range.minor && version.patch >= range.patch);
  }

  if (range.minor > 0) {
    // ^0.2.3 := >=0.2.3 <0.3.0
    return version.minor === range.minor && version.patch >= range.patch;
  }

  // ^0.0.3 := >=0.0.3 <0.0.4
  return version.minor === range.minor && version.patch === range.patch;
}

/**
 * Check if version satisfies a tilde range (~1.2.3)
 * Allows patch-level changes
 */
function satisfiesTilde(version: SemVer, range: SemVer): boolean {
  // ~1.2.3 := >=1.2.3 <1.3.0
  return version.major === range.major &&
         version.minor === range.minor &&
         version.patch >= range.patch;
}

/**
 * Check if version satisfies a comparator (>=, >, <, <=, =)
 */
function satisfiesComparator(version: SemVer, operator: string, target: SemVer): boolean {
  const cmp = compareSemVer(version, target);

  switch (operator) {
    case '=':
    case '==':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    default:
      return false;
  }
}

/**
 * Check if version satisfies a range specification
 */
export function satisfiesRange(versionStr: string, rangeStr: string): boolean {
  rangeStr = rangeStr.trim();

  // Wildcard or "latest"
  if (rangeStr === '*' || rangeStr === 'latest' || rangeStr === '') {
    return true;
  }

  const version = parseSemVer(versionStr);
  if (!version) return false;

  // Exact version
  if (!rangeStr.match(/[\^~><]/)) {
    const target = parseSemVer(rangeStr);
    return target ? compareSemVer(version, target) === 0 : false;
  }

  // Caret range: ^1.2.3
  if (rangeStr.startsWith('^')) {
    const target = parseSemVer(rangeStr.slice(1));
    return target ? satisfiesCaret(version, target) : false;
  }

  // Tilde range: ~1.2.3
  if (rangeStr.startsWith('~')) {
    const target = parseSemVer(rangeStr.slice(1));
    return target ? satisfiesTilde(version, target) : false;
  }

  // Comparator range: >=1.2.3 <2.0.0
  const comparatorMatch = rangeStr.match(/^(>=?|<=?|=)\s*(.+)$/);
  if (comparatorMatch) {
    const operator = comparatorMatch[1];
    const target = parseSemVer(comparatorMatch[2]);
    return target ? satisfiesComparator(version, operator, target) : false;
  }

  // Space-separated AND ranges: >=1.2.3 <2.0.0
  if (rangeStr.includes(' ')) {
    const parts = rangeStr.split(/\s+/);
    for (let i = 0; i < parts.length; i += 2) {
      const operator = parts[i];
      const targetStr = parts[i + 1];
      if (!targetStr) continue;

      const target = parseSemVer(targetStr);
      if (!target) return false;
      if (!satisfiesComparator(version, operator, target)) return false;
    }
    return true;
  }

  return false;
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
