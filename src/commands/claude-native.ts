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
import { activeProfile } from '../profile';
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

/** Versions of installed native binaries, by path (with size and mtime, so a replaced file isn't trusted). */
const VERSIONS_FILE = '/var/lib/tabcomputer/claude-native.json';
type VersionRecord = Record<string, { version: string; size: number; mtime: number }>;

async function readVersions(fs: CommandContext['fs']): Promise<VersionRecord> {
  try { return JSON.parse(await fs.readFile(VERSIONS_FILE, 'utf8') as string) ?? {}; } catch { return {}; }
}

/** Remember the version of the binary at `path` (claude install writes it). */
export async function recordNativeVersion(fs: CommandContext['fs'], path: string, version: string): Promise<void> {
  try {
    const st = await fs.stat(path);
    const all = await readVersions(fs);
    all[path] = { version, size: st.size, mtime: st.mtime.getTime() };
    await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
    await fs.writeFile(VERSIONS_FILE, JSON.stringify(all, null, 2) + '\n');
  } catch { /* only a cache */ }
}

/** The bundle's own `,VERSION:"x.y.z"` (Claude Code's build constants), from the binary's bytes. */
export function versionInBinary(bin: Uint8Array): string | null {
  const pat = new TextEncoder().encode(',VERSION:"');
  for (let i = bin.indexOf(pat[0]); i >= 0; i = bin.indexOf(pat[0], i + 1)) {
    let j = 1;
    while (j < pat.length && bin[i + j] === pat[j]) j++;
    if (j < pat.length) continue;
    let v = '';
    for (let k = i + j; k < i + j + 32 && bin[k] !== 0x22; k++) v += String.fromCharCode(bin[k]);
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  }
  return null;
}

/**
 * The installed native build's version: from the record `claude install`
 * keeps, else read once from the binary (`bin`, when the caller has it) and
 * recorded. null when neither works.
 */
export async function nativeClaudeVersion(fs: CommandContext['fs'], path: string, bin?: Uint8Array): Promise<string | null> {
  try {
    const st = await fs.stat(path);
    const rec = (await readVersions(fs))[path];
    if (rec && rec.size === st.size && rec.mtime === st.mtime.getTime()) return rec.version;
  } catch { return null; }
  const v = bin ? versionInBinary(bin) : null;
  if (v) await recordNativeVersion(fs, path, v);
  return v;
}

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
  // Small text fetches go through a file too: in the page terminal a guest
  // program's stdout reaches the terminal, not a capture sink
  const fetchText = async (url: string): Promise<{ code: number; out: string }> => {
    const tmp = `/tmp/claude-native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const r = await sh(curl(`-o ${quote(tmp)} ${quote(url)}`));
    let out = '';
    if (r.code === 0) {
      try {
        const data = await ctx.fs.readFile(tmp);
        out = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      } catch { /* empty */ }
    }
    await ctx.fs.unlink(tmp).catch(() => {});
    return { code: r.code, out };
  };

  say('Installing native Claude Code (experimental: about 2 minutes per request in Blink)\n');
  if (!(await ctx.fs.exists(CURL).catch(() => false))) {
    say('  pkg install curl\n');
    if ((await sh('pkg install curl')).code !== 0 || !(await ctx.fs.exists(CURL).catch(() => false))) return fail('could not install the curl package');
  }

  if (!version) {
    const r = await fetchText(`${RELEASES}/latest`);
    version = r.out.trim();
    if (r.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
      return fail(`could not reach ${RELEASES}/latest (curl exit ${r.code}).\n`
        + 'It downloads from inside the VM through the server\'s TCP relay; this server may not offer one\n'
        + '(check with `curl -sI https://example.com`), or the network sign-in was declined.');
    }
  }
  const m = await fetchText(`${RELEASES}/${version}/manifest.json`);
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
  await recordNativeVersion(ctx.fs, target, version);

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
  say(`Installed Claude Code ${version} (native, ${PLATFORM}) at ${target}.\n`
    + (activeProfile().shims.claude === 'native' ? 'Run it with: claude   (claude --npm runs the npm build)\n' : 'Run it with: claude --native   (plain `claude` stays the npm build)\n'));
  return 0;
}
