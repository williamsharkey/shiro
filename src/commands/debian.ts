import type { Command, CommandContext } from './index';

/**
 * Debian mode (docs/DEBIAN.md):
 *   debian install [--base URL]   stream Debian's root filesystem into this machine
 *   debian status                 what is installed, fetched and overlaid
 *   debian prefetch [PKG...]      fetch packages' files now (default: apt, dpkg, bash, coreutils)
 * and the overlay switch:
 *   shiro-alternatives --list | --display NAME | --set NAME shiro|debian | --auto NAME|all
 */

const PREFETCH_DEFAULT = ['libc6', 'bash', 'coreutils', 'dpkg', 'apt', 'libapt-pkg7.0', 'libstdc++6', 'dash', 'tar', 'gzip', 'sqv', 'debianutils'];

async function enableDebianMode(ctx: CommandContext): Promise<void> {
  const { DEBIAN_ENV } = await import('../debian/rootfs');
  for (const [k, v] of Object.entries(DEBIAN_ENV)) ctx.shell.env[k] ??= v;
  const { enableDebianShadows } = await import('../debian/overlay');
  await enableDebianShadows(ctx.fs, (n) => !!ctx.shell.commands.get(n));
}

export const debianCmd: Command = {
  name: 'debian',
  description: 'Install and manage the streamed Debian system',
  async exec(ctx) {
    const [sub, ...rest] = ctx.args;
    const rootfs = await import('../debian/rootfs');
    const out = (s: string) => { ctx.stdout += s + '\n'; };
    if (sub === 'install' || sub === 'init') {
      const already = await rootfs.installedRootfs(ctx.fs);
      if (already && !rest.includes('--force')) {
        out(`Debian ${already.version} is already installed (${already.id}); --force reinstalls the base files.`);
        return 0;
      }
      const bi = rest.indexOf('--base');
      const base = bi >= 0 ? rest[bi + 1] : undefined;
      const r = await rootfs.installRootfs(ctx.fs, { base, progress: (m) => out(m) });
      const { applyDefaults } = await import('../debian/overlay');
      await enableDebianMode(ctx);
      const changed = await applyDefaults(ctx.fs);
      await ctx.fs.sync();
      out(`Installed ${r.entries} paths in ${r.ms} ms; file contents are fetched on first use.`);
      for (const c of changed) out(`  overlay: ${c}`);
      if (r.moved.length) out(`  moved into Debian's directories: ${r.moved.join(', ')}`);
      out(`Try: sudo apt update && sudo apt install <package>`);
      return 0;
    }
    if (sub === 'status' || !sub) {
      const st = await rootfs.installedRootfs(ctx.fs);
      if (!st) {
        out('Debian is not installed. `debian install` streams it in (nothing is downloaded until a file is read).');
        return sub ? 1 : 0;
      }
      const s = rootfs.rootfsStats;
      out(`Debian ${st.version} (${st.suite}, ${st.arch}), snapshot ${st.snapshot}, rootfs ${st.id}`);
      out(`  base: ${st.packages} packages, ${st.entries} paths, ${(st.bytes / 1e6).toFixed(1)} MB (${(st.chunkBytes / 1e6).toFixed(1)} MB compressed in ${st.chunks} chunks)`);
      out(`  installed ${new Date(st.installedAt).toISOString()} from ${st.base}`);
      out(`  this session: ${s.chunksFetched} chunks fetched (${(s.chunkBytesFetched / 1e6).toFixed(1)} MB), ${s.chunksFromCache} from the browser cache, ${s.filesMaterialized} files filled`);
      try {
        const est = await (navigator as any)?.storage?.estimate?.();
        if (est?.usage) out(`  browser storage used: ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB`);
      } catch { /* no storage API */ }
      return 0;
    }
    if (sub === 'prefetch') {
      const pkgs = rest.length ? rest : PREFETCH_DEFAULT;
      const paths: string[] = [];
      for (const p of pkgs) {
        const list = await ctx.fs.readFile(`/var/lib/dpkg/info/${p}.list`, 'utf8').catch(() => ctx.fs.readFile(`/var/lib/dpkg/info/${p}:amd64.list`, 'utf8').catch(() => '')) as string;
        for (const f of list.split('\n')) if (f) paths.push(f);
      }
      const files: string[] = [];
      for (const p of paths) { try { if ((await ctx.fs.lstat(p)).type === 'file') files.push(p); } catch { /* excluded */ } }
      const t = Date.now();
      const n = await rootfs.prefetchPaths(ctx.fs, files);
      out(`prefetched ${n} files of ${pkgs.length} packages in ${Date.now() - t} ms`);
      return 0;
    }
    ctx.stderr += `usage: debian install [--base URL] | status | prefetch [PKG...]\n`;
    return 2;
  },
};

export const shiroAlternativesCmd: Command = {
  name: 'shiro-alternatives',
  description: "Choose Shiro's or Debian's implementation of a program",
  async exec(ctx) {
    const ov = await import('../debian/overlay');
    const a = ctx.args;
    const out = (s: string) => { ctx.stdout += s + '\n'; };
    const describe = (st: Awaited<ReturnType<typeof ov.programState>>) => {
      const name = st.path;
      const who = st.current === 'shiro' ? `shiro (${st.policy?.command ?? name.slice(name.lastIndexOf('/') + 1)})` : 'debian';
      const mode = st.manual ? 'manual' : 'auto';
      const dflt = st.policy ? `, default ${st.policy.default}` : '';
      const inst = st.debianInstalled ? '' : ' [Debian package not installed]';
      return `${name}\t${who}\t(${mode}${dflt})${inst}`;
    };
    try {
      if (!a.length || a[0] === '--list' || a[0] === '--get-selections') {
        const divs = await ov.readDiversions(ctx.fs);
        const paths = new Set(Object.keys(ov.POLICY));
        for (const d of divs) if (d.by === ':' && d.to === d.from + '.debian') paths.add(d.from);
        for (const p of [...paths].sort()) out(describe(await ov.programState(ctx.fs, p, divs)));
        return 0;
      }
      if (a[0] === '--display' || a[0] === '--query') {
        const p = ov.overlayPath(a[1] ?? '');
        if (!p) throw new Error('--display needs a name');
        const st = await ov.programState(ctx.fs, p);
        out(describe(st));
        if (st.policy?.why) out(`  ${st.policy.why}`);
        if (st.diversion) out(`  dpkg: diversion of ${st.diversion.from} to ${st.diversion.to} by ${st.diversion.by === ':' ? 'local' : st.diversion.by}`);
        return 0;
      }
      if (a[0] === '--set') {
        const p = ov.overlayPath(a[1] ?? '');
        const side = a[2];
        if (!p || (side !== 'shiro' && side !== 'debian')) throw new Error('usage: --set NAME shiro|debian');
        if (side === 'shiro' && !ov.POLICY[p] && !ctx.shell.commands.get(p.slice(p.lastIndexOf('/') + 1))) throw new Error(`Shiro has no ${p.slice(p.lastIndexOf('/') + 1)}`);
        out(await ov.setSide(ctx.fs, p, side, { manual: true }));
        return 0;
      }
      if (a[0] === '--auto') {
        if (a[1] === 'all' || a[1] === '--new') {
          for (const c of await ov.applyDefaults(ctx.fs)) out(c);
          return 0;
        }
        const p = ov.overlayPath(a[1] ?? '');
        if (!p || !ov.POLICY[p]) throw new Error(`no default policy for ${a[1]}`);
        const choices = JSON.parse(await ctx.fs.readFile('/var/lib/shiro/alternatives.json', 'utf8').catch(() => '{}') as string);
        delete choices[p];
        await ctx.fs.writeFile('/var/lib/shiro/alternatives.json', JSON.stringify(choices, null, 2) + '\n');
        const changed = await ov.applyDefaults(ctx.fs, [p]);
        out(changed.length ? changed.join('\n') : `${p}: ${ov.POLICY[p].default} (auto)`);
        return 0;
      }
      ctx.stderr += 'usage: shiro-alternatives --list | --display NAME | --set NAME shiro|debian | --auto NAME|all\n';
      return 2;
    } catch (e: any) {
      ctx.stderr += `shiro-alternatives: ${e?.message ?? e}\n`;
      return 1;
    }
  },
};

/** apt's http/https transport (src/debian/apt-method.ts); apt runs it through the stub its method path holds. */
export const shiroAptMethodCmd: Command = {
  name: 'shiro-apt-method',
  description: "apt transport that fetches from the page's Debian mirror",
  async exec(ctx) {
    ctx.stderr += 'shiro-apt-method: apt runs this as /usr/lib/apt/methods/http; it speaks apt\'s method protocol on stdin/stdout\n';
    return 100;
  },
  async program(proc, kernel) {
    const { aptMethodProgram } = await import('../debian/apt-method');
    return aptMethodProgram(proc, kernel);
  },
};
