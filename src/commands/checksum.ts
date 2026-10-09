/**
 * md5sum, sha1sum, sha256sum, sha384sum, sha512sum (GNU coreutils):
 * FILE... (- or none is stdin), -b/-t (marker only), --tag, -z,
 * -c/--check with --quiet, --status, --warn, --strict, --ignore-missing.
 * MD5 is computed here (WebCrypto has no MD5); the SHAs use crypto.subtle.
 */
import type { Command, CommandContext } from './index';
import { stdinBytes } from './compress/bytes';

/** MD5 of bytes (RFC 1321) as hex */
export function md5Hex(data: Uint8Array): string {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = data.length;
  const total = ((len + 8) >> 6) + 1 << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + M[g]) >>> 0;
      const s = S[(i >> 4) * 4 + (i & 3)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
  return Array.from(out, (x) => x.toString(16).padStart(2, '0')).join('');
}

type Algo = { name: string; tag: string; hexLen: number; digest: (b: Uint8Array) => Promise<string> };

const subtle = (alg: string) => async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest(alg, b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');

const ALGOS: Algo[] = [
  { name: 'md5sum', tag: 'MD5', hexLen: 32, digest: async (b) => md5Hex(b) },
  { name: 'sha1sum', tag: 'SHA1', hexLen: 40, digest: subtle('SHA-1') },
  { name: 'sha256sum', tag: 'SHA256', hexLen: 64, digest: subtle('SHA-256') },
  { name: 'sha384sum', tag: 'SHA384', hexLen: 96, digest: subtle('SHA-384') },
  { name: 'sha512sum', tag: 'SHA512', hexLen: 128, digest: subtle('SHA-512') },
];

async function readInput(ctx: CommandContext, file: string): Promise<Uint8Array> {
  if (file === '-') return stdinBytes(ctx.stdin ?? '', false);
  const p = ctx.fs.resolvePath(file, ctx.cwd);
  const st = await ctx.fs.stat(p);
  if (st.isDirectory()) throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
  const data = await ctx.fs.readFile(p);
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as Uint8Array);
}

const errText = (e: any) => (e?.code === 'EISDIR' || /EISDIR/.test(e?.message) ? 'Is a directory'
  : /ENOENT/.test(e?.message ?? '') || e?.code === 'ENOENT' ? 'No such file or directory' : (e?.message ?? String(e)));

/** GNU escapes a name with \ or newline and marks the line with a leading \ */
const escapeName = (n: string) => (/[\\\n\r]/.test(n) ? { esc: true, name: n.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r') } : { esc: false, name: n });

function makeCommand(algo: Algo): Command {
  return {
    name: algo.name,
    description: `Compute and check ${algo.tag} message digests`,
    async exec(ctx) {
      let check = false, binary = false, tag = false, zero = false;
      let quiet = false, status = false, warn = false, strict = false, ignoreMissing = false;
      const files: string[] = [];
      let opts = true;
      for (const a of ctx.args) {
        if (!opts || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
        if (a === '--') { opts = false; continue; }
        switch (a) {
          case '--check': check = true; continue;
          case '--binary': binary = true; continue;
          case '--text': binary = false; continue;
          case '--tag': tag = true; continue;
          case '--zero': zero = true; continue;
          case '--quiet': quiet = true; continue;
          case '--status': status = true; continue;
          case '--warn': warn = true; continue;
          case '--strict': strict = true; continue;
          case '--ignore-missing': ignoreMissing = true; continue;
        }
        if (a.startsWith('--')) { ctx.stderr += `${algo.name}: unrecognized option '${a}'\nTry '${algo.name} --help' for more information.\n`; return 1; }
        for (const c of a.slice(1)) {
          if (c === 'c') check = true; else if (c === 'b') binary = true; else if (c === 't') binary = false;
          else if (c === 'z') zero = true; else if (c === 'w') warn = true;
          else { ctx.stderr += `${algo.name}: invalid option -- '${c}'\nTry '${algo.name} --help' for more information.\n`; return 1; }
        }
      }
      if (!files.length) files.push('-');

      if (!check) {
        let rc = 0;
        for (const f of files) {
          try {
            const hex = await algo.digest(await readInput(ctx, f));
            const { esc, name } = zero ? { esc: false, name: f } : escapeName(f);
            const line = tag ? `${algo.tag} (${name}) = ${hex}` : `${hex} ${binary ? '*' : ' '}${name}`;
            ctx.stdout += (esc ? '\\' : '') + line + (zero ? '\0' : '\n');
          } catch (e) {
            ctx.stderr += `${algo.name}: ${f}: ${errText(e)}\n`;
            rc = 1;
          }
        }
        return rc;
      }

      // --check: verify the sums listed in each FILE
      let rc = 0;
      let bad = 0, unreadable = 0, malformed = 0, verified = 0;
      for (const list of files) {
        let text: string;
        try {
          text = list === '-' ? (ctx.stdin ?? '') : new TextDecoder().decode(await readInput(ctx, list));
        } catch (e) {
          ctx.stderr += `${algo.name}: ${list}: ${errText(e)}\n`;
          rc = 1;
          continue;
        }
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        let properLines = 0;
        for (const [n, raw] of lines.entries()) {
          let lineText = raw;
          const esc = lineText.startsWith('\\');
          if (esc) lineText = lineText.slice(1);
          // (one space between sum and name is accepted too)
          const re1 = new RegExp(`^([0-9a-fA-F]{${algo.hexLen}}) [ *]?(.*)$`);
          const re2 = new RegExp(`^${algo.tag} \\((.*)\\) = ([0-9a-fA-F]{${algo.hexLen}})$`);
          let want: string, file: string;
          const m1 = re1.exec(lineText), m2 = re2.exec(lineText);
          if (m1) { want = m1[1]; file = m1[2]; } else if (m2) { want = m2[2]; file = m2[1]; } else {
            malformed++;
            if (warn) ctx.stderr += `${algo.name}: ${list}: ${n + 1}: improperly formatted ${algo.tag} checksum line\n`;
            continue;
          }
          if (esc) file = file.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
          properLines++;
          let hex: string;
          try {
            hex = await algo.digest(await readInput(ctx, file));
          } catch (e) {
            if (ignoreMissing && /No such file/.test(errText(e))) continue;
            unreadable++;
            if (!status) {
              ctx.stderr += `${algo.name}: ${file}: ${errText(e)}\n`;
              ctx.stdout += `${file}: FAILED open or read\n`;
            }
            continue;
          }
          verified++;
          if (hex.toLowerCase() === want.toLowerCase()) { if (!quiet && !status) ctx.stdout += `${file}: OK\n`; }
          else { bad++; if (!status) ctx.stdout += `${file}: FAILED\n`; }
        }
        if (!properLines) {
          ctx.stderr += `${algo.name}: ${list}: no properly formatted ${algo.tag} checksum lines found\n`;
          rc = 1;
        } else if (ignoreMissing && !verified) {
          ctx.stderr += `${algo.name}: ${list}: no file was verified\n`;
          rc = 1;
        }
      }
      if (!status) {
        const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);
        if (malformed) ctx.stderr += `${algo.name}: WARNING: ${malformed} ${plural(malformed, 'line is', 'lines are')} improperly formatted\n`;
        if (unreadable) ctx.stderr += `${algo.name}: WARNING: ${unreadable} listed ${plural(unreadable, 'file', 'files')} could not be read\n`;
        if (bad) ctx.stderr += `${algo.name}: WARNING: ${bad} computed ${plural(bad, 'checksum', 'checksums')} did NOT match\n`;
      }
      if (bad || unreadable || (strict && malformed)) rc = 1;
      return rc;
    },
  };
}

export const [md5sumCmd, sha1sumCmd, sha256sumCmd, sha384sumCmd, sha512sumCmd] = ALGOS.map(makeCommand);
