/**
 * GNU coreutils behaviour of the text utilities (busybox testsuite and
 * GNU-compared regressions): comm, nl, expand/unexpand, fold, factor,
 * tsort, cut, paste, uniq, sort, seq, tr, od, sum. Expected outputs are
 * GNU coreutils 9.4's (LC_ALL=C).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string) {
  const { fs, shell } = await createTestShell();
  let out = '';
  let err = '';
  await shell.execute('mkdir -p /tmp/textutils && cd /tmp/textutils', () => {}, () => {});
  const status = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status, fs };
}

describe('text utilities behave like GNU coreutils', () => {
  it("comm reads - as stdin; -1/-2/-3 and --output-delimiter", async () => {
    const r = await sh("printf 'abc\\ndef\\n' > c1; printf 'abc\\nxyz\\n' | comm c1 -; printf 'abc\\nxyz\\n' | comm -12 - c1; printf 'a\\nb\\n' | comm --output-delimiter=: - c1");
    expect(r.out).toBe("\t\tabc\ndef\n\txyz\nabc\na\n:abc\nb\n:def\n");
  });

  it("nl: no extra line for the final newline; unnumbered lines are width+sep spaces; sections", async () => {
    const r = await sh("printf 'a\\n\\nb\\n' | nl; printf 'line 1\\n\\nline 3\\n' | nl -b n; printf 'x\\ny' | nl -ba -s: -w3 -nrz; printf 'h\\n\\\\:\\\\:\\\\:\\nhead\\n\\\\:\\\\:\\nbody\\n' | nl -ha");
    expect(r.out).toBe("     1\ta\n       \n     2\tb\n       line 1\n       \n       line 3\n001:x\n002:y\n     1\th\n\n     1\thead\n\n     1\tbody\n");
  });

  it("expand/unexpand: no extra line, tab lists, leading-only by default", async () => {
    const r = await sh("printf '\\t12345678\\t12345678\\n' | expand; printf 'ab\\tc\\td\\n' | expand -t 2,5,9; printf '        12345678\\n' | unexpand; printf '       \\t12345678\\n' | unexpand; printf '123 \\t 45678\\n' | unexpand; printf '        a       b    c\\n' | unexpand | od -c; printf '        a       b    c\\n' | unexpand -t4 | od -c; printf '        a       b    c\\n' | unexpand -t4 --first-only | od -c");
    expect(r.out).toBe("        12345678        12345678\nab   c   d\n\t12345678\n\t12345678\n123 \t 45678\n0000000  \\t   a                               b                   c  \\n\n0000020\n0000000  \\t  \\t   a  \\t  \\t   b  \\t       c  \\n\n0000012\n0000000  \\t  \\t   a                               b                   c\n0000020  \\n\n0000021\n");
  });

  it("fold: tab columns, -s breaks after the last blank, keeps a missing final newline missing", async () => {
    const r = await sh("printf '123456\\tasdf' | fold -w 7 -s | od -c; printf 'qq w eee' | fold -w1 | od -c; printf 'abc de fghij klm\\n' | fold -sw5");
    expect(r.out).toBe("0000000   1   2   3   4   5   6  \\n  \\t  \\n   a   s   d   f\n0000015\n0000000   q  \\n   q  \\n      \\n   w  \\n      \\n   e  \\n   e  \\n   e\n0000017\nabc \nde \nfghij\n klm\n");
  });

  it("factor: blanks and + accepted, 0 and 1, 64-bit and larger numbers", async () => {
    const r = await sh("factor '  0' +1 ' +2' 18446744073709551615 18446743988964486098 6144867742934288163; factor 340282366920938463463374607431768211455; factor -h 360; factor x; echo \"st=$?\" ");
    expect(r.out).toBe("0:\n1:\n2: 2\n18446744073709551615: 3 5 17 257 641 65537 6700417\n18446743988964486098: 2 3037000493 3037000493\n6144867742934288163: 3 37831 37831 37831 37831\n340282366920938463463374607431768211455: 3 5 17 257 641 65537 274177 6700417 67280421310721\n360: 2^3 3^2 5\nst=1\n");
  });

  it("tsort: self pairs, empty input, GNU order, odd tokens, loops", async () => {
    const r = await sh("printf 'a a\\n' | tsort; printf '\\n\\n \\t\\n ' | tsort; echo \"st=$?\"; printf 'a b c c d e g g f g e f h h\\n' | tsort; printf 'a\\n' | tsort 2>/dev/null; echo \"st=$?\"; printf 'a b b a\\n' | tsort 2>/dev/null; echo \"st=$?\" ");
    expect(r.out).toBe("a\nst=0\na\nc\nd\nh\nb\ne\nf\ng\nst=1\na\nb\nst=1\n");
  });

  it("cut: merged ranges in input order, open ranges, whole lines without the delimiter, -s, --complement", async () => {
    const r = await sh("printf 'one:two:three:four\\nalpha beta\\n' > cf; cut -b 3,3,3 cf; cut -b 1-3,2-5,7-9 cf; cut -c 6- cf; cut -d : -f 2- cf; cut -d : -f 3 -s cf; cut -d: --complement -f2 cf; cut --output-delimiter=. -b 1-2,4-5 cf; printf 'a::b\\n' | cut -d: -f1-3; printf 'x y\\n' | cut -d' ' -f2 - cf; cut -b 3-1 cf; echo \"st=$?\" ");
    expect(r.out).toBe("e\np\none:to:t\nalphabet\nwo:three:four\n beta\ntwo:three:four\nalpha beta\nthree\none:three:four\nalpha beta\non.:t\nal.ha\na::b\ny\none:two:three:four\nbeta\nst=1\n");
  });

  it("paste: - operands share stdin, \\0 delimiter, -s with a delimiter list", async () => {
    const r = await sh("printf 'l1\\nl2\\nl3\\nl4\\nl5\\n' | paste - - -; printf 'abc\\ndef\\n' > p1; printf 'X\\nY\\n' > p2; paste -d '\\0' p1 p2; printf 'a\\nb\\nc\\nd\\ne\\n' | paste -s -d '\\t\\n'; paste -s p1 p2; printf '1\\n' | paste p1 -");
    expect(r.out).toBe("l1\tl2\tl3\nl4\tl5\t\nabcX\ndefY\na\tb\nc\td\ne\nabc\tdef\nX\tY\nabc\t1\ndef\t\n");
  });

  it("uniq: - is stdin, OUTPUT operand, -f/-s/-w, -D/--group", async () => {
    const r = await sh("printf 'one\\ntwo\\ntwo\\nthree\\n' > u1; uniq u1 uout; cat uout; uniq - < u1; printf 'cc\\tdd\\tee8\\nbb\\tcc\\tdd8\\naa\\tbb\\tcc9\\n' | uniq -f2 -s 3; printf 'aaa1\\naaa2\\nbbb1\\n' | uniq -w3 -c; uniq -D u1; uniq --group=both u1");
    expect(r.out).toBe("one\ntwo\nthree\none\ntwo\nthree\ncc\tdd\tee8\naa\tbb\tcc9\n      2 aaa1\n      1 bbb1\ntwo\ntwo\n\none\n\ntwo\ntwo\n\nthree\n\n");
  });

  it("sort: per-key options, global -r only reverses the tie-break, -s, -u, -h, -M, -V, -z, -o in place", async () => {
    const r = await sh("printf '42\\t1\\t3\\twoot\\n42\\t1\\t010\\tzoology\\negg\\t1\\t2\\tpapyrus\\n7\\t3\\t42\\tsoup\\n999\\t3\\t0\\talgebra\\n' > sd; sort -k2,3n sd; sort -k2,3n -r sd; sort -k2,3rn sd; printf 'a 1\\nb 2\\nc 1\\nd 2\\n' | sort -k2 -r -s; printf 'z b\\na b\\nz a\\na a\\n' | sort -s -u -k 2; printf '1Y\\n5y\\n1M\\n2E\\n3k\\n2K\\n1023\\n' | sort -h; printf '2 April\\n1  May\\n3 March\\n' | sort -k2,2M; printf '1.10\\n1.9\\n1.2\\n' | sort -V; printf 'one\\0two\\0three\\0' | sort -z | od -c; printf '222\\n111\\n' > so; sort -o so so; cat so; printf 'B\\na\\nC\\n' | sort; printf 'b\\na\\n' | sort -c; echo \"st=$?\" ");
    expect(r.out).toBe("42\t1\t010\tzoology\n42\t1\t3\twoot\negg\t1\t2\tpapyrus\n7\t3\t42\tsoup\n999\t3\t0\talgebra\negg\t1\t2\tpapyrus\n42\t1\t3\twoot\n42\t1\t010\tzoology\n999\t3\t0\talgebra\n7\t3\t42\tsoup\n7\t3\t42\tsoup\n999\t3\t0\talgebra\n42\t1\t010\tzoology\n42\t1\t3\twoot\negg\t1\t2\tpapyrus\nb 2\nd 2\na 1\nc 1\nz a\nz b\n5y\n1023\n2K\n3k\n1M\n2E\n1Y\n3 March\n2 April\n1  May\n1.2\n1.9\n1.10\n0000000   o   n   e  \\0   t   h   r   e   e  \\0   t   w   o  \\0\n0000016\n111\n222\nB\nC\na\nst=1\n");
  });

  it("seq -w pads to the operands' widths", async () => {
    const r = await sh("seq -w 003; seq -w 005 7; seq -w 8 -3 04; seq -w 03 .3 0004; seq -w -1 1");
    expect(r.out).toBe("001\n002\n003\n005\n006\n007\n08\n05\n0003.0\n0003.3\n0003.6\n0003.9\n-1\n00\n01\n");
  });

  it("tr: [:xdigit:] order, classes, repeats, escapes, squeeze", async () => {
    const r = await sh("printf '19AFH\\n' | tr -cd '[:xdigit:]'; echo; echo '#0123456789ABCDEFGabcdefg' | tr '[:xdigit:]Gg' 1111111151242222333330xX; echo '[qwe]' | tr '[q-z]' '_Q-Z+'; echo hello | tr 'a-z' 'A[x*3]'; echo 'aabbcc  dd' | tr -s ' '; echo hello | tr -s lo xy; printf 'a\\tb\\n' | tr '\\t' _; echo hello | tr z-a x; echo \"st=$?\" ");
    expect(r.out).toBe("19AF\n#1111111151242222x333330X\n_QWe+\nxxxxx\naabbcc dd\nhexy\na_b\nst=1\n");
  });

  it("od: little-endian units, named chars, floats, -A/-j/-N/-w, * for repeats", async () => {
    const r = await sh("printf '\\001\\002\\003\\nABC\\376' > ob; od ob; od -d ob; od -D ob; od -f ob; od -x ob; od -l ob; od -a ob; od -c ob; od -tx1z ob; od -Ad -j2 -N3 -tx1 ob; printf '%032d' 0 | od -c");
    expect(r.out).toBe("0000000 001001 005003 041101 177103\n0000010\n0000000   513  2563 16961 65091\n0000010\n0000000  167969281 4265820737\n0000010\n0000000   6.3077975e-33  -6.4885867e+37\n0000010\n0000000 0201 0a03 4241 fe43\n0000010\n0000000  -125183517527965183\n0000010\n0000000 soh stx etx  nl   A   B   C   ~\n0000010\n0000000 001 002 003  \\n   A   B   C 376\n0000010\n0000000 01 02 03 0a 41 42 43 fe                          >....ABC.<\n0000010\n0000002 03 0a 41\n0000005\n0000000   0   0   0   0   0   0   0   0   0   0   0   0   0   0   0   0\n*\n0000040\n");
  });

  it("sum: BSD and System V checksums", async () => {
    const r = await sh("printf 'hello world\\n' > sf; sum sf; sum -s sf; sum < sf; sum sf sf");
    expect(r.out).toBe("03762     1 sf\n1126 1 sf\n03762     1\n03762     1 sf\n03762     1 sf\n");
  });
});
