/**
 * The node_modules tree `npm install` lays out, as npm does: each package as
 * high as it can go, a version that conflicts nested under the package that
 * needs it. Dependencies, optionalDependencies and (as npm 7+) peer
 * dependencies are followed; `npm:` aliases resolve to the named package.
 *
 * Native packages can't run here, so:
 *  - an optional dependency that names a platform (`os`/`cpu`, like
 *    @esbuild/linux-x64 or @rollup/rollup-linux-x64-gnu) is left out, as npm
 *    leaves out other platforms' builds, except a WebAssembly one
 *    (`cpu: ["wasm32"]`, napi-rs's -wasm32-wasi: @rolldown/binding-wasm32-wasi);
 *  - a package with a WebAssembly build of the same API and versions
 *    (WASM_ALTERNATES) gets that build under its own name: esbuild is
 *    esbuild-wasm, rollup is @rollup/wasm-node.
 */
import { maxSatisfying, satisfiesRange } from '../utils/semver-utils';

export interface VersionData {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  dist: { tarball: string; shasum?: string; integrity?: string };
}

export interface PackageMetadata {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, VersionData>;
}

/** Packages that run as their WebAssembly build (same API, same version numbers) */
export const WASM_ALTERNATES: Record<string, string> = {
  esbuild: 'esbuild-wasm',
  rollup: '@rollup/wasm-node',
  // its browser build (node-compat runs it as page code: browser-packages.ts)
  rolldown: '@rolldown/browser',
};

/**
 * WebAssembly bindings a package loads when its native one is missing but
 * doesn't depend on (rolldown leaves its -wasm32-wasi binding to an explicit
 * install): added beside it, at its version.
 */
export const WASM_COMPANIONS: Record<string, string> = {};

export interface TreeNode {
  /** The name it is installed as (node_modules/<name>) */
  name: string;
  version: string;
  /** The registry package the files come from (an alias's or alternate's target) */
  source: string;
  tarball: string;
  /** Relative to the install root: node_modules/a, node_modules/a/node_modules/b; '' for the root */
  dir: string;
  parent: TreeNode | null;
  children: Map<string, TreeNode>;
  /** Where each of its dependencies resolved */
  resolved: Map<string, TreeNode>;
  bin?: string | Record<string, string>;
  data?: VersionData;
}

export interface Wanted { name: string; range: string; optional?: boolean }

const PLATFORM = { os: 'linux', cpu: 'x64' };

/** Does a package's os/cpu list allow this platform? (`!x` excludes x) */
function allows(list: string[] | undefined, value: string): boolean {
  if (!list?.length) return true;
  const neg = list.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
  const pos = list.filter((x) => !x.startsWith('!'));
  if (neg.includes(value)) return false;
  return pos.length === 0 || pos.includes(value);
}

/** A version of `meta` for `range` (a dist-tag, a semver range, or a version) */
export function pickVersion(meta: PackageMetadata, range: string): string | null {
  const r = (range || '').trim();
  if (r === '' || r === '*' || r === 'latest' || r === 'x') return meta['dist-tags'].latest ?? null;
  if (meta['dist-tags'][r]) return meta['dist-tags'][r];
  if (meta.versions[r]) return r;
  const versions = Object.keys(meta.versions);
  const best = maxSatisfying(versions, r);
  // Like npm, the latest tag wins when it satisfies the range
  const latest = meta['dist-tags'].latest;
  if (latest && best && latest !== best && satisfiesRange(latest, r)) return latest;
  return best;
}

const isUnder = (node: TreeNode, ancestor: TreeNode): boolean => {
  for (let n: TreeNode | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
};

function* subtree(node: TreeNode): Generator<TreeNode> {
  for (const c of node.children.values()) { yield c; yield* subtree(c); }
}

export interface BuildResult { root: TreeNode; nodes: TreeNode[]; skipped: string[]; warnings: string[] }

/**
 * Resolve `wanted` (the root's dependencies) into a tree. `fetchMeta` gets a
 * package's registry document; requests for one level go out together.
 */
export async function buildTree(wanted: Wanted[], fetchMeta: (name: string) => Promise<PackageMetadata>): Promise<BuildResult> {
  const root: TreeNode = { name: '', version: '', source: '', tarball: '', dir: '', parent: null, children: new Map(), resolved: new Map() };
  const nodes: TreeNode[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  let level: { from: TreeNode; want: Wanted }[] = wanted.map((w) => ({ from: root, want: w }));

  while (level.length) {
    // The registry documents this level needs, fetched together
    const sources = new Set<string>();
    const targetOf = (w: Wanted) => {
      let source = w.name, range = w.range;
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(range);
      if (alias) { source = alias[1]; range = alias[2] ?? 'latest'; }
      if (WASM_ALTERNATES[source]) source = WASM_ALTERNATES[source];
      return { source, range };
    };
    for (const { want } of level) {
      if (/^(file:|link:|git\+|git:|github:|https?:|workspace:)/.test(want.range) || /^[^@/]+\/[^@/]+(#.*)?$/.test(want.range)) continue;
      sources.add(targetOf(want).source);
    }
    const metas = new Map<string, PackageMetadata | Error>();
    await Promise.all([...sources].map(async (s) => {
      try { metas.set(s, await fetchMeta(s)); } catch (e: any) { metas.set(s, e instanceof Error ? e : new Error(String(e))); }
    }));

    const next: { from: TreeNode; want: Wanted }[] = [];
    for (const { from, want } of level) {
      const { name } = want;
      if (/^(file:|link:|git\+|git:|github:|https?:|workspace:)/.test(want.range) || /^[^@/]+\/[^@/]+(#.*)?$/.test(want.range)) {
        warnings.push(`${name}@${want.range}: only registry packages are installed`);
        continue;
      }
      const { source, range } = targetOf(want);

      // Already reachable from here with a version that fits?
      let conflictAt: TreeNode | null = null;
      let reuse: TreeNode | null = null;
      for (let cur: TreeNode | null = from; cur; cur = cur.parent) {
        const have = cur.children.get(name);
        if (!have) continue;
        if (have.source === source && (have.version === range || satisfiesRange(have.version, range) || range === 'latest' || range === '*' || range === '')) reuse = have;
        else conflictAt = cur;
        break;
      }
      if (reuse) { from.resolved.set(name, reuse); continue; }

      const meta = metas.get(source);
      if (!meta || meta instanceof Error) {
        if (!want.optional) warnings.push(`${name}@${want.range}: ${meta instanceof Error ? meta.message : 'not found'}`);
        continue;
      }
      const version = pickVersion(meta, range);
      const data = version ? meta.versions[version] : undefined;
      if (!version || !data) {
        if (!want.optional) warnings.push(`${name}@${want.range}: no matching version`);
        continue;
      }
      // A WebAssembly build (napi-rs's -wasm32-wasi bindings: rolldown, oxc) runs here
      const wasm = !!data.cpu?.includes('wasm32');
      if (!wasm && (!allows(data.os, PLATFORM.os) || !allows(data.cpu, PLATFORM.cpu) || (want.optional && (data.os?.length || data.cpu?.length)))) {
        // A native build for some platform: these can't run in the tab
        skipped.push(`${name}@${version}`);
        continue;
      }

      // As high as it goes: up from the package that needs it, stopping
      // below a conflicting version...
      const chain: TreeNode[] = [];
      for (let cur: TreeNode | null = from; cur; cur = cur.parent) {
        chain.push(cur);
        if (cur === conflictAt) { chain.pop(); break; }
      }
      if (!chain.length) {
        // The package itself already holds another version (placed for something under it)
        warnings.push(`${name}@${version}: ${from.name} keeps ${from.children.get(name)!.version}`);
        from.resolved.set(name, from.children.get(name)!);
        continue;
      }
      // ...and not where it would hide another version from a package that already uses it
      let at = chain[chain.length - 1];
      for (let i = chain.length - 1; i > 0; i--) {
        at = chain[i];
        let shadows = false;
        for (const d of subtree(at)) {
          const r = d.resolved.get(name);
          if (r && !isUnder(r, at)) { shadows = true; break; }
        }
        if (!shadows) break;
        at = chain[i - 1];
      }

      const node: TreeNode = {
        name, version, source, tarball: data.dist.tarball,
        dir: `${at.dir ? at.dir + '/' : ''}node_modules/${name}`,
        parent: at, children: new Map(), resolved: new Map(), bin: data.bin, data,
      };
      at.children.set(name, node);
      from.resolved.set(name, node);
      nodes.push(node);

      for (const [n, r] of Object.entries(data.dependencies ?? {})) next.push({ from: node, want: { name: n, range: r } });
      if (WASM_COMPANIONS[source]) next.push({ from: node, want: { name: WASM_COMPANIONS[source], range: version, optional: true } });
      for (const [n, r] of Object.entries(data.optionalDependencies ?? {})) next.push({ from: node, want: { name: n, range: r, optional: true } });
      for (const [n, r] of Object.entries(data.peerDependencies ?? {})) {
        if (data.peerDependenciesMeta?.[n]?.optional) continue;
        if (data.dependencies?.[n] || data.optionalDependencies?.[n]) continue;
        // A peer is the parent's to provide: resolved from where the package sits
        next.push({ from: at, want: { name: n, range: r } });
      }
    }
    level = next;
  }
  return { root, nodes, skipped, warnings };
}

/** The directory a node's bins are linked in (its own node_modules/.bin level) */
export function binDirOf(node: TreeNode): string {
  const i = node.dir.lastIndexOf('node_modules/');
  return node.dir.slice(0, i) + 'node_modules/.bin';
}

/** name → path inside the package, for a package.json `bin` */
export function binEntries(name: string, bin: VersionData['bin']): [string, string][] {
  if (!bin) return [];
  if (typeof bin === 'string') return [[name.replace(/^@[^/]+\//, ''), bin]];
  return Object.entries(bin);
}
