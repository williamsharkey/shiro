/**
 * Built-in utilities as their GNU/util-linux counterparts behave
 * (williamsharkey/tabcomputer#7): column -t, bc's scale and the math
 * library, touch -d/-t/-r, iconv //TRANSLIT, declare -f/-F, and named
 * pipes read or written by name.
 */
import { describe, expect, it } from 'vitest';
import { createTestShell } from './helpers';

async function shellWith() {
  const { shell, fs } = await createTestShell();
  const sh = async (cmd: string) => {
    let out = '', err = '';
    const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
    return { code, out: out.replace(/\r\n/g, '\n').replace(/^\[\d+\] \d+\n/gm, ''), err: err.replace(/\r\n/g, '\n') };
  };
  return { shell, fs, sh };
}

describe('column', () => {
  it('-t aligns the columns (the last one unpadded); -s, -o; without -t, tab-aligned columns down first', async () => {
    const { sh } = await shellWith();
    expect((await sh('printf "a b\\ncc d\\n" | column -t')).out).toBe('a   b\ncc  d\n');
    expect((await sh('printf "name  size\\nlonger-name 1\\n\\nx 22\\n" | column -t')).out).toBe('name         size\nlonger-name  1\nx            22\n');
    expect((await sh('printf "a:b\\ncc:d\\n" | column -t -s: -o " | "')).out).toBe('a  | b\ncc | d\n');
    expect((await sh('seq 1 12 | column -c 40')).out).toBe('1\t4\t7\t10\n2\t5\t8\t11\n3\t6\t9\t12\n');
    expect((await sh('seq 1 5 | column -x -c 24')).out).toBe('1\t2\t3\n4\t5\n');
  });
});

describe('bc', () => {
  it('scale, statements on one line, and the scale of each result', async () => {
    const { sh } = await shellWith();
    expect((await sh('echo "scale=3;10/3" | bc')).out).toBe('3.333\n');
    expect((await sh("printf 'scale=2\\n1/4\\n' | bc")).out).toBe('.25\n');
    expect((await sh("echo '3.5*2' | bc")).out).toBe('7.0\n');
    expect((await sh("echo '3.5^2; 10/3; -7/2; 7%3; scale=2; 10%3; -1/4' | bc")).out).toBe('12.2\n3\n-3\n1\n.01\n-.25\n');
    expect((await sh("echo '2^100' | bc")).out).toBe('1267650600228229401496703205376\n');
    expect((await sh("echo 'scale=20; sqrt(2)' | bc")).out).toBe('1.41421356237309504880\n');
    // long numbers wrap at 70 columns, as GNU bc
    expect((await sh("echo '2^300' | bc")).out).toBe('203703597633448608626844568840937816105146839366593625063614044935438\\\n1299763336706183397376\n');
  });

  it('-l: the math library at scale 20', async () => {
    const { sh } = await shellWith();
    expect((await sh("echo 's(1); c(1); a(1)*4; l(10); e(1)' | bc -l")).out)
      .toBe('.84147098480789650665\n.54030230586813971740\n3.14159265358979323844\n2.30258509299404568401\n2.71828182845904523536\n');
    expect((await sh("echo '1/3' | bc -l")).out).toBe('.33333333333333333333\n');
  });

  it('the language: define, recursion, auto, arrays, loops, if, print, strings, ibase/obase, quit', async () => {
    const { sh } = await shellWith();
    expect((await sh("printf 'define f(n) { if (n <= 1) return (1); return (n * f(n-1)); }\\nf(30)\\n' | bc")).out).toBe('265252859812191058636308480000000\n');
    expect((await sh("printf 'define s(a[], n) { auto i, t; for (i = 0; i < n; i++) t += a[i]; return t; }\\nfor (i = 0; i < 4; i++) x[i] = i * i\\ns(x[], 4)\\n' | bc")).out).toBe('14\n');
    expect((await sh(`printf 'i = 0\\nwhile (i < 3) { print "i=", i, "\\\\n"; i += 1 }\\n"done\\n"\\n' | bc`)).out).toBe('i=0\ni=1\ni=2\ndone\n');
    expect((await sh("printf 'obase=16; 255\\nobase=2; 10\\nobase=10; ibase=16; FF\\n' | bc")).out).toBe('FF\n1010\n255\n');
    expect((await sh("echo 'a = 5; a; quit; 9' | bc")).out).toBe('5\n');
    const z = await sh("echo '1/0; 2' | bc");
    expect(z.out).toBe('2\n');
    expect(z.err).toContain('Divide by zero');
  });
});

describe('touch', () => {
  it('-d DATE, -t STAMP, -r FILE, @SECONDS, -m/-a, -c', async () => {
    const { sh, fs } = await shellWith();
    await sh('mkdir -p /tmp/tt && cd /tmp/tt && touch -d "2020-01-01 00:00" a && touch -t 202001010000 b && touch -d @86400 c');
    const local = new Date(2020, 0, 1).getTime();
    expect((await fs.stat('/tmp/tt/a')).mtime.getTime()).toBe(local);
    expect((await fs.stat('/tmp/tt/b')).mtime.getTime()).toBe(local);
    expect((await fs.stat('/tmp/tt/c')).mtime.getTime()).toBe(86_400_000);
    await sh('cd /tmp/tt && touch -d "2021-06-01T12:00:00Z" d && touch -r d e');
    expect((await fs.stat('/tmp/tt/e')).mtime.getTime()).toBe(Date.UTC(2021, 5, 1, 12));
    await sh('cd /tmp/tt && touch -a -d @0 e');
    expect((await fs.stat('/tmp/tt/e')).mtime.getTime()).toBe(Date.UTC(2021, 5, 1, 12)); // -a leaves mtime
    await sh('cd /tmp/tt && touch -c nothere');
    expect(await fs.exists('/tmp/tt/nothere')).toBe(false);
    const bad = await sh('cd /tmp/tt && touch -d "not a date" f');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid date format 'not a date'");
    // plain touch of an existing file: now, content kept
    await fs.writeFile('/tmp/tt/g', 'keep');
    await sh('cd /tmp/tt && touch -d @0 g && touch g');
    expect(Date.now() - (await fs.stat('/tmp/tt/g')).mtime.getTime()).toBeLessThan(60_000);
    expect(await fs.readFile('/tmp/tt/g', 'utf8')).toBe('keep');
  });
});

describe('iconv', () => {
  it('//TRANSLIT, //IGNORE, -c, an error for what the target lacks, latin1 and UTF-16 to a file', async () => {
    const { sh, fs } = await shellWith();
    expect((await sh('echo hé | iconv -f utf-8 -t ascii//TRANSLIT')).out).toBe('he\n');
    expect((await sh("echo 'naïve “quote” — ß €' | iconv -f UTF-8 -t ASCII//TRANSLIT")).out).toBe('naive "quote" - ss EUR\n');
    expect((await sh('echo hé | iconv -f utf-8 -t ascii//IGNORE')).out).toBe('h\n');
    expect((await sh('echo hé | iconv -c -f utf-8 -t ascii')).out).toBe('h\n');
    const e = await sh('echo hé | iconv -f utf-8 -t ascii');
    expect(e.code).toBe(1);
    expect(e.err).toContain('cannot convert');
    await sh('mkdir -p /tmp/ic && echo café | iconv -f utf-8 -t latin1 -o /tmp/ic/l1 && iconv -f utf-16 -t utf-16le /dev/null');
    expect([...(await fs.readFile('/tmp/ic/l1')) as Uint8Array]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    expect((await sh('iconv -f latin1 -t utf-8 /tmp/ic/l1')).out).toBe('café\n');
    await sh('echo hi | iconv -t UTF-16LE -o /tmp/ic/u16');
    expect([...(await fs.readFile('/tmp/ic/u16')) as Uint8Array]).toEqual([0x68, 0, 0x69, 0, 0x0a, 0]);
    expect((await sh('iconv -f utf-16le -t utf-8 /tmp/ic/u16')).out).toBe('hi\n');
  });
});

describe('declare -f / -F', () => {
  it('prints function definitions and names', async () => {
    const { sh } = await shellWith();
    const r = await sh('ff(){ echo hi; }; gg(){ echo a; echo b; }; declare -f ff; declare -F ff; declare -F; declare -F nope; echo rc=$?');
    expect(r.out).toBe('ff () \n{ \n    echo hi\n}\nff\ndeclare -f ff\ndeclare -f gg\nrc=1\n');
    expect((await sh('hh(){ echo x; }; eval "$(declare -f hh | sed s/hh/hh2/)"; hh2')).out).toBe('x\n');
  });
});

describe('named pipes by name', () => {
  it('cat FIFO waits for the writer and reads to its EOF; tee FIFO writes into it', async () => {
    const { sh } = await shellWith();
    const r = await sh('mkdir -p /tmp/nf && cd /tmp/nf && mkfifo ff && (echo via > ff) & cat /tmp/nf/ff; echo done');
    expect(r.out).toContain('via\ndone\n');
    const w = await sh('cd /tmp/nf && (sleep 0.2; echo late > ff) & wc -c < /dev/null; wc -c ff');
    expect(w.out).toContain('5 ff\n');
    const t = await sh('cd /tmp/nf && (echo teed | tee ff > /dev/null) & cat ff');
    expect(t.out).toContain('teed\n');
  });
});
