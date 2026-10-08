/**
 * Parser and judge for oils-for-unix spec tests (spec/*.test.sh).
 *
 * Format: each case starts with `#### name`, followed by shell code, then
 * `## key: value` lines or `## KEY:` ... `## END` blocks. A key may be
 * qualified for particular shells: `## OK bash/dash stdout: x`,
 * `## N-I mksh status: 2`, `## BUG zsh STDOUT:`.
 *
 * We judge against bash: a result passes when it matches the unqualified
 * expectation, or an OK/BUG/N-I expectation that names bash.
 */

const KEY_LINE = /^## (?:(OK|BUG|N-I|BUG-2) ([A-Za-z0-9/._-]+) )?([A-Za-z-]+):\s?(.*)$/;

export function parseSpecFile(text) {
  const lines = text.split('\n');
  const cases = [];
  let cur = null;
  let block = null; // { target, key }
  for (const line of lines) {
    if (block) {
      if (line === '## END' || line.startsWith('## END')) { finishBlock(cur, block); block = null; continue; }
      // A new key line also ends a block (oils allows omitting END before another key)
      const m = KEY_LINE.exec(line);
      if (m) {
        finishBlock(cur, block); block = null;
      } else if (line.startsWith('#### ')) {
        finishBlock(cur, block); block = null;
      } else {
        block.lines.push(line);
        continue;
      }
    }
    if (line.startsWith('#### ')) {
      cur = { name: line.slice(5).trim(), code: [], expect: { default: {}, bash: {} }, inCode: true };
      cases.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = KEY_LINE.exec(line);
    if (m) {
      cur.inCode = false;
      const [, qual, shells, key, value] = m;
      const forBash = !qual || shells.split('/').some((s) => s === 'bash');
      if (qual && !forBash) {
        if (key === 'STDOUT' || key === 'STDERR') block = { target: null, key, lines: [] };
        continue;
      }
      const target = qual ? cur.expect.bash : cur.expect.default;
      if (key === 'STDOUT' || key === 'STDERR') {
        block = { target, key: key.toLowerCase(), lines: [] };
      } else if (key === 'stdout') target.stdout = value + '\n';
      else if (key === 'stderr') target.stderr = value + '\n';
      else if (key === 'stdout-json') target.stdout = JSON.parse(value);
      else if (key === 'stderr-json') target.stderr = JSON.parse(value);
      else if (key === 'status' || key === 'code') target.status = parseInt(value, 10);
      continue;
    }
    if (cur.inCode) cur.code.push(line);
  }
  if (block) finishBlock(cur, block);
  for (const c of cases) {
    // Drop trailing blank lines from code
    while (c.code.length && c.code[c.code.length - 1].trim() === '') c.code.pop();
    c.code = c.code.join('\n') + '\n';
    delete c.inCode;
  }
  return cases;
}

function finishBlock(cur, block) {
  if (!block.target) return;
  block.target[block.key] = block.lines.length ? block.lines.join('\n') + '\n' : '';
}

/** Is this case's expected bash behavior satisfied by (stdout, status)? */
export function judge(c, stdout, status) {
  const d = c.expect.default;
  const b = c.expect.bash;
  const candidates = [d];
  if (Object.keys(b).length) candidates.push({ ...d, ...b });
  return candidates.some((e) => {
    const wantStatus = e.status ?? 0;
    if (status !== wantStatus) return false;
    if (e.stdout !== undefined && stdout !== e.stdout) return false;
    return true;
  });
}

/** Python 3 repr() of a str, as argv.py prints it. */
export function pyRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0x80 && cp < 0xa0) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0xdc80 && cp <= 0xdcff) out += '\\udc' + cp.toString(16).slice(2);
    else out += ch;
  }
  return out + quote;
}

export function argvPy(args) {
  return '[' + args.map(pyRepr).join(', ') + ']\n';
}
