/**
 * Regressions found by the busybox testsuite conformance run
 * (tests/conformance/utils-busybox.conf.ts): utilities vs GNU behaviour.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string) {
  const { fs, shell } = await createTestShell();
  let out = '';
  let err = '';
  const status = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status, fs };
}

describe('utilities conformance regressions', () => {
  it('grep -o terminates on empty matches; a final newline is not an extra line', async () => {
    const r = await sh(`echo /var/test | grep -o '[^/]*$'; printf 'a\\n' | grep -c ''; echo test | grep -o '' | wc -l`);
    expect(r.out).toBe('test\n1\n0\n');
  });

  it('printf: * width/precision, length modifiers, flags, %b, %q, \\c, char args, errors', async () => {
    const r = await sh([
      `printf '|%*.*f|%-*d|%.*f|\\n' 20 12 5.25 -4 7 -1 5.25`,
      `printf '%ld %zd %x %o %#x %u %e %g\\n' -5 3 255 8 255 -1 12345.678 0.0001234`,
      `printf '% d|%+d|%.3d|%05.1f|%c|%5.2s\\n' 5 5 7 3.14159 xyz abcdef`,
      `printf '%d %b %q\\n' "'A" 'x\\ty' 'a b'`,
      `printf 'a\\cb'; printf '%b' 'c\\cd'; echo`,
      `printf '%d\\n' abc; echo "st=$?"`,
    ].join('; '));
    expect(r.out).toBe('|      5.250000000000|7   |5.250000|\n-5 3 ff 10 0xff 18446744073709551615 1.234568e+04 0.0001234\n 5|+5|007|003.1|x|   ab\n65 x\ty a\\ b\nac\n0\nst=1\n');
  });

  it('seq uses the operands\' precision, -w pads, empty ranges print nothing', async () => {
    const r = await sh(`seq 3 .3 4; seq -w 9 .3 10; seq -s : -1 1; seq 3 1; seq .7 -.9 -2; seq 1 2 3 4; echo "st=$?"`);
    expect(r.out).toBe('3.0\n3.3\n3.6\n3.9\n09.0\n09.3\n09.6\n09.9\n-1:0:1\n0.7\n-0.2\n-1.1\n-2.0\nst=1\n');
  });

  it('test / [: ! binds tighter than -a, parentheses, integer errors, quoted words', async () => {
    const r = await sh([
      `test ! a = b -a ! c = c; echo $?`,
      `[ \\( 1 -lt 2 \\) -o x = y ]; echo $?`,
      `test 1 -lt abc; echo $?`,
      `[ a = a; echo $?`,
      `a="b c"; if [ "$a" = "b c" ]; then echo eq; fi`,
      `test ! = x; echo $?`,
    ].join('; '));
    expect(r.out).toBe('1\n0\n2\n2\neq\n1\n');
  });

  it('${x:-0} is a default (not a substring); $(( )) expands ${…} inside', async () => {
    const r = await sh(`unset q; s=abcdef; echo "\${q:-0}" \${s: -2} \${s:(-3):2} \${s:1:2}; m=0; m=$(( \${m:-0} + 1 )); echo $m $(( $((1+2)) * 2 )) '$((1+1))'`);
    expect(r.out).toBe('0 ef de bc\n1 6 $((1+1))\n');
  });

  it('grep: BRE vs ERE, multiple -e, -w, -x, -c, -l, -L, empty -f file, egrep/fgrep', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/g1', 'foo bar\nfoobar\nbaz\n');
    await fs.writeFile('/tmp/g2', 'nothing\n');
    await fs.writeFile('/tmp/empty', '');
    let out = '';
    await shell.execute([
      `grep 'fo\\{2\\}' /tmp/g1 | head -1`,
      `grep -E 'ba(r|z)$' /tmp/g1`,
      `grep 'a\\|z' /tmp/g2; echo "s=$?"`,
      `grep -e baz -e bar -c /tmp/g1`,
      `grep -w foo /tmp/g1`,
      `grep -x baz /tmp/g1`,
      `grep -l foo /tmp/g1 /tmp/g2; grep -L foo /tmp/g1 /tmp/g2`,
      `grep -f /tmp/empty /tmp/g1; echo "e=$?"`,
      `egrep 'z|q' /tmp/g1; fgrep 'a.' /tmp/g1; echo "f=$?"`,
      `printf 'x[y]\\n' | grep '[[:alpha:]]\\[y\\]'`,
    ].join('; '), (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('foo bar\nfoo bar\nfoobar\nbaz\ns=1\n3\nfoo bar\nbaz\n/tmp/g1\n/tmp/g2\ne=1\nbaz\nf=1\nx[y]\n');
  });

  it('sed: scripts, addresses, ranges, hold space, a/i/c, y, labels, -n/-E/-i, last line without newline', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/s1', 'one\ntwo\nthree\nfour\n');
    let out = '';
    await shell.execute([
      `sed -n '2,3p' /tmp/s1`,
      `sed -e '1d' -e 's/o/0/g' /tmp/s1 | head -2`,
      `sed -E 's/(t)(w|h)/\\2\\1/' /tmp/s1 | sed -n '/^[wh]t/p'`,
      `sed '/two/,/three/d; $a end' /tmp/s1`,
      `sed -n '1h;1!H;\${x;s/\\n/,/g;p}' /tmp/s1`,
      `sed '2i before' /tmp/s1 | sed -n 2p`,
      `sed 'y/ot/OT/;3q' /tmp/s1`,
      `printf 'a\\nb' | sed 's/b/B/'; echo`,
      `sed ':a;N;$!ba;s/\\n/+/g' /tmp/s1`,
      `sed -i.bak 's/one/ONE/' /tmp/s1; head -1 /tmp/s1 /tmp/s1.bak`,
      `echo hello | sed 's/l/L/2'`,
      `echo abc | sed 's/b*/-/g'`,
    ].join('; '), (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe(
      'two\nthree\ntw0\nthree\nwto\nhtree\none\nfour\nend\none,two,three,four\nbefore\n'
      + 'One\nTwO\nThree\na\nB\none+two+three+four\n==> /tmp/s1 <==\nONE\n\n==> /tmp/s1.bak <==\none\nhelLo\n-a-c-\n');
  });

  it('cat -n/-b/-E/-s and - for stdin; head/tail counts, -c, +N, headers, no invented newline', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/c1', 'a\n\n\nb\n');
    await fs.writeFile('/tmp/n1', '1\n2\n3\n4');
    let out = '';
    await shell.execute([
      `cat -n /tmp/c1`, `cat -bsE /tmp/c1`, `echo mid | cat /tmp/c1 - /tmp/c1 | wc -l`,
      `head -n 2 /tmp/n1`, `tail -n 1 /tmp/n1; echo`, `tail -n +3 /tmp/n1; echo`, `head -n -2 /tmp/n1`,
      `tail -n 0 /tmp/n1`, `printf '' | head -n1 | wc -c`, `tail -c 2 /tmp/n1; echo`, `seq 20 | tail -3`,
    ].join('; '), (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe(
      '     1\ta\n     2\t\n     3\t\n     4\tb\n     1\ta$\n$\n     2\tb$\n9\n'
      + '1\n2\n4\n3\n4\n1\n2\n0\n\n4\n18\n19\n20\n');
  });

  it('echo: -ne combined, \\c, \\x; wc widths like GNU', async () => {
    const r = await sh(`echo -ne 'a\\tb\\x41\\n'; echo -e 'x\\cy'; echo -n -- -n; echo; printf 'a b\\nc\\n' > /tmp/w1; echo hi | wc -l; echo hi | wc; wc -l /tmp/w1; wc -c /tmp/w1 /tmp/w1`);
    expect(r.out).toBe('a\tbA\nx-- -n\n1\n      1       1       3\n2 /tmp/w1\n 6 /tmp/w1\n 6 /tmp/w1\n12 total\n');
  });

  it('md5sum/sha*sum are real digests with -c, --tag (md5sum was a placeholder hash)', async () => {
    const r = await sh('cd /tmp; echo hello | md5sum; printf "" | md5sum; echo hi > ck.txt; sha1sum ck.txt; sha256sum ck.txt > ck.sum; sha256sum -c ck.sum; echo bye > ck.txt; sha256sum -c ck.sum 2>/dev/null; echo st=$?; md5sum --tag ck.txt');
    expect(r.out).toBe('b1946ac92492d2347c6235b4d2611184  -\nd41d8cd98f00b204e9800998ecf8427e  -\n55ca6286e3e4f4fba5d0448333fa99fc5a404a73  ck.txt\n'
      + 'ck.txt: OK\nck.txt: FAILED\nst=1\nMD5 (ck.txt) = 91fc14ad02afd60985bb8165bda320a6\n');
  });
});
