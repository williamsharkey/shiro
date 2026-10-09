/**
 * `claude install --native [VERSION]`: install Anthropic's native Claude
 * Code build for `claude --native` (experimental; docs/COMPAT.md "Agent
 * CLIs"). Everything is downloaded from inside the guest by the `curl`
 * package (x86-64, its own TLS, kernel sockets and the TCP relay), so CORS
 * doesn't apply and nothing goes through a Shiro proxy route:
 *
 * - the linux-x64-musl build (the glibc one still crashes in Blink), checked
 *   against the sha256 in the release's manifest.json, into the native path;
 * - musl's dynamic loader, from Debian's `musl` package (pinned by sha256),
 *   as /lib/ld-musl-x86_64.so.1.
 */
import type { CommandContext } from './index';
import { sha256Hex } from '../pkg-manager';

const RELEASES = 'https://downloads.claude.ai/claude-code-releases';
const PLATFORM = 'linux-x64-musl';
const CURL = '/usr/lib/pkg/curl/bin/curl';

/** Debian trixie's musl: the loader and libc are one file. */
export const MUSL_DEB = {
  urls: [
    'https://deb.debian.org/debian/pool/main/m/musl/musl_1.2.5-3.1~deb13u1_amd64.deb',
    // snapshot.debian.org keeps every file, by sha1, after the mirror drops it
    'https://snapshot.debian.org/file/d69cb80320535f4bcf59a1e7595c95ef0ce5ef99',
  ],
  sha256: 'fd4231e1c189c0ebe01182747f83817593fefa7f6b690c484410646288b60058',
  libc: 'usr/lib/x86_64-linux-musl/libc.so',
};
export const MUSL_LOADER = '/lib/ld-musl-x86_64.so.1';

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

// Proxy and CA settings given to `claude install` reach the curl it runs
const PASS_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export async function installNativeClaude(ctx: CommandContext, target: string, version?: string, muslDeb = MUSL_DEB): Promise<number> {
  const say = (s: string) => {
    if (ctx.terminal) ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n'));
    else ctx.stdout += s;
  };
  const sh = async (line: string, capture = false): Promise<{ code: number; out: string }> => {
    let out = '';
    const sink = capture ? (s: string) => { out += s; } : (s: string) => { ctx.stderr += s.replace(/\r\n/g, '\n'); };
    const code = await ctx.shell.execute(line, sink, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, capture ? undefined : ctx.terminal, true);
    return { code, out };
  };
  const envPrefix = PASS_ENV.filter((k) => ctx.env[k]).map((k) => `${k}=${quote(ctx.env[k])} `).join('');
  const curl = (args: string) => `${envPrefix}${CURL} -fsSL --retry 2 ${args}`;
  const fail = (msg: string) => { ctx.stderr += `claude install --native: ${msg}\n`; return 1; };

  say('Installing native Claude Code (experimental: about 2 minutes per request in Blink)\n');
  if (!(await ctx.fs.exists(CURL).catch(() => false))) {
    say('  pkg install curl\n');
    if ((await sh('pkg install curl')).code !== 0 || !(await ctx.fs.exists(CURL).catch(() => false))) return fail('could not install the curl package');
  }

  if (!version) {
    const r = await sh(curl(`${RELEASES}/latest`), true);
    version = r.out.trim();
    if (r.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) return fail(`could not read ${RELEASES}/latest`);
  }
  const m = await sh(curl(`${RELEASES}/${version}/manifest.json`), true);
  let entry: { checksum?: string; size?: number } | undefined;
  try { entry = JSON.parse(m.out).platforms?.[PLATFORM]; } catch { /* below */ }
  if (m.code !== 0 || !entry?.checksum) return fail(`no ${PLATFORM} build in ${RELEASES}/${version}/manifest.json`);

  const dir = target.slice(0, target.lastIndexOf('/')) || '/';
  await ctx.fs.mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = `${target}.download`;
  say(`  ${RELEASES}/${version}/${PLATFORM}/claude (${entry.size ? Math.round(entry.size / 2 ** 20) + ' MB' : 'size unknown'})\n`);
  if ((await sh(curl(`-o ${quote(tmp)} ${RELEASES}/${version}/${PLATFORM}/claude`))).code !== 0) return fail('download failed');
  const bin = await ctx.fs.readFile(tmp) as Uint8Array;
  const got = await sha256Hex(bin);
  if (got !== entry.checksum) {
    await ctx.fs.unlink(tmp).catch(() => {});
    return fail(`sha256 mismatch: manifest ${entry.checksum}, got ${got}`);
  }
  await ctx.fs.writeFile(target, bin, { mode: 0o755 });
  await ctx.fs.unlink(tmp).catch(() => {});

  if (!(await ctx.fs.exists(MUSL_LOADER).catch(() => false))) {
    say('  musl loader (Debian musl 1.2.5)\n');
    const debPath = '/tmp/musl.deb';
    let deb: Uint8Array | null = null;
    for (const url of muslDeb.urls) {
      if ((await sh(curl(`-o ${debPath} ${quote(url)}`))).code !== 0) continue;
      const data = await ctx.fs.readFile(debPath) as Uint8Array;
      if ((await sha256Hex(data)) === muslDeb.sha256) { deb = data; break; }
    }
    await ctx.fs.unlink(debPath).catch(() => {});
    if (!deb) return fail('could not download musl (sha256-checked)');
    const { debEntries } = await import('../gui/apps');
    const libc = (await debEntries(deb)).find((e) => e.path.replace(/^\.?\//, '') === muslDeb.libc);
    if (!libc) return fail('musl package has no libc.so');
    await ctx.fs.mkdir('/usr/lib/x86_64-linux-musl', { recursive: true }).catch(() => {});
    await ctx.fs.writeFile('/' + muslDeb.libc, libc.data, { mode: 0o755 });
    await ctx.fs.mkdir('/lib', { recursive: true }).catch(() => {});
    await ctx.fs.symlink('/' + muslDeb.libc, MUSL_LOADER).catch(() => {});
  }
  say(`Installed Claude Code ${version} (native, ${PLATFORM}) at ${target}.\nRun it with: claude --native   (plain \`claude\` stays the npm build)\n`);
  return 0;
}
