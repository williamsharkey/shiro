import type { Command, CommandContext } from './index';

/**
 * Prebuilt toolchains (docs/DEBIAN.md "Toolchain layers"):
 *   toolchain list                 the sets, their size, whether installed
 *   toolchain install ID... [--check] [--apt]
 *                                  apply prebuilt layers (Debian packages, so apt and
 *                                  dpkg know them); --apt installs with apt instead
 *   toolchain check ID...          run each set's smoke test
 * Debian is installed first if it isn't.
 */

export interface ToolchainEntry {
  id: string;
  title: string;
  description: string;
  packages: string[];
  /** Compressed bytes streamed as programs are first used (0: no prebuilt layer). */
  size: number;
  /** A prebuilt layer for this machine's Debian is on the server. */
  prebuilt: boolean;
  installed: boolean;
  check?: string;
  /** A known limitation, shown by `toolchain list`. */
  note?: string;
}

/** Every toolchain set, for `toolchain list` and the desktop's Settings. */
export async function listToolchains(fs: CommandContext['fs']): Promise<ToolchainEntry[]> {
  const [{ fetchLayerCatalog, appliedLayers }, { installedRootfs }, spec] = await Promise.all([
    import('../debian/layers'), import('../debian/rootfs'), import('../debian/toolchains.json'),
  ]);
  const [catalog, applied, rootfs] = await Promise.all([fetchLayerCatalog(), appliedLayers(fs), installedRootfs(fs)]);
  const status = await fs.readFile('/var/lib/dpkg/status', 'utf8').catch(() => '') as string;
  const have = new Set<string>();
  for (const s of status.split(/\n\n+/)) {
    const name = s.match(/^Package: (.*)$/m)?.[1];
    if (name && /^Status: .* installed$/m.test(s)) have.add(name);
  }
  const sets = (spec as any).default?.layers ?? (spec as any).layers;
  return Object.entries(sets as Record<string, { title: string; description: string; packages: string[]; check?: string; note?: string }>).map(([id, s]) => {
    const layer = catalog.find((l) => l.name === id && (!rootfs || l.base === rootfs.id));
    return {
      id, title: s.title, description: s.description, packages: s.packages, check: s.check, note: s.note,
      size: layer?.chunkBytes ?? 0,
      prebuilt: !!layer,
      installed: !!applied[id] || (s.packages.length > 0 && s.packages.every((p) => have.has(p))),
    };
  });
}

async function runShell(ctx: CommandContext, script: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  return ctx.shell.fork().runScriptText(script, ctx.terminal, out, err);
}

export const toolchainCmd: Command = {
  name: 'toolchain',
  description: 'Install prebuilt compilers and runtimes (C, Python, Node, Java, LaTeX, ...) in seconds',
  async exec(ctx) {
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
    const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };
    const [sub = 'list', ...rest] = ctx.args;
    const flags = new Set(rest.filter((a) => a.startsWith('-')));
    const ids = rest.filter((a) => !a.startsWith('-'));
    const mb = (b: number) => b ? `${(b / 1e6).toFixed(0)} MB` : '-';

    if (sub === 'list' || sub === 'ls') {
      const list = await listToolchains(ctx.fs);
      out(`${'ID'.padEnd(8)} ${'INSTALLED'.padEnd(9)} ${'SIZE'.padStart(7)}  DESCRIPTION\n`);
      for (const t of list) {
        out(`${t.id.padEnd(8)} ${(t.installed ? 'yes' : 'no').padEnd(9)} ${(t.prebuilt ? mb(t.size) : 'apt').padStart(7)}  ${t.title}: ${t.description}\n`);
        if (t.note) out(`${''.padEnd(28)}note: ${t.note}\n`);
      }
      out(`\ntoolchain install ID installs one; SIZE is fetched only as programs are first used ("apt": no prebuilt layer here, apt installs it).\n`);
      return 0;
    }

    if (sub === 'install' || sub === 'add') {
      if (!ids.length) { err('usage: toolchain install ID... [--check] [--apt]   (toolchain list shows the IDs)\n'); return 2; }
      const all = await listToolchains(ctx.fs);
      for (const id of ids) if (!all.some((t) => t.id === id)) { err(`toolchain: no toolchain named ${id} (toolchain list)\n`); return 1; }

      const rootfs = await import('../debian/rootfs');
      if (!await rootfs.installedRootfs(ctx.fs)) {
        out('Installing Debian first (debian install)...\n');
        const code = await runShell(ctx, 'debian install', out, err);
        if (code) return code;
      }
      const layers = await import('../debian/layers');
      const overlay = await import('../debian/overlay');
      let status = 0;
      for (const id of ids) {
        const t = (await listToolchains(ctx.fs)).find((x) => x.id === id)!;
        const t0 = Date.now();
        if (t.note) out(`note: ${t.note}\n`);
        if (t.prebuilt && !flags.has('--apt')) {
          try {
            const r = await layers.applyLayer(ctx.fs, id, { progress: (m) => out(m + '\n') });
            out(`${t.title}: ${r.installed.length} packages installed in ${((Date.now() - t0) / 1000).toFixed(1)} s (${r.paths} paths; files load on first use).\n`);
          } catch (e: any) {
            err(`toolchain: prebuilt ${id} failed (${e?.message ?? e}); installing with apt instead\n`);
            if (await aptInstall(ctx, t.packages, out, err)) { status = 1; continue; }
          }
        } else {
          if (!flags.has('--apt')) out(`No prebuilt ${id} layer on this server for this Debian base; installing with apt (this takes minutes).\n`);
          if (await aptInstall(ctx, t.packages, out, err)) { status = 1; continue; }
          out(`${t.title}: installed with apt in ${((Date.now() - t0) / 1000).toFixed(0)} s.\n`);
        }
        await overlay.enableDebianShadows(ctx.fs, (n) => !!ctx.shell.commands.get(n));
        for (const c of await overlay.applyDefaults(ctx.fs)) out(`  overlay: ${c}\n`);
        await overlay.refreshShadows(ctx.fs);
        if (flags.has('--check') && t.check) status ||= await check(ctx, t, out, err);
      }
      await ctx.fs.sync();
      return status;
    }

    if (sub === 'check') {
      const all = await listToolchains(ctx.fs);
      let status = 0;
      for (const id of ids.length ? ids : all.filter((t) => t.installed).map((t) => t.id)) {
        const t = all.find((x) => x.id === id);
        if (!t) { err(`toolchain: no toolchain named ${id}\n`); status = 1; continue; }
        status ||= await check(ctx, t, out, err);
      }
      return status;
    }

    err('usage: toolchain list | install ID... [--check] [--apt] | check [ID...]\n');
    return 2;
  },
};

async function check(ctx: CommandContext, t: ToolchainEntry, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!t.check) return 0;
  const t0 = Date.now();
  const code = await runShell(ctx, t.check, out, err);
  out(`${t.id}: check ${code ? `failed (exit ${code})` : 'passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  return code ? 1 : 0;
}

/** apt-get update when there are no package lists yet, then install. Returns the exit status. */
async function aptInstall(ctx: CommandContext, packages: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const lists = await ctx.fs.readdir('/var/lib/apt/lists').catch(() => [] as string[]);
  if (!lists.some((f) => f.endsWith('_Packages'))) {
    const code = await runShell(ctx, 'sudo apt-get update', out, err);
    if (code) return code;
  }
  return runShell(ctx, `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages.join(' ')}`, out, err);
}
