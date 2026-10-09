/**
 * File and misc utilities vs GNU coreutils/diffutils/findutils/tar/patch:
 * regressions from the busybox testsuite conformance run
 * (tests/conformance/utils-busybox.conf.ts). Every expected output was
 * produced by the GNU tools (bash, TZ=UTC, LC_ALL=C) on the same script.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

let n = 0;
async function sh(script: string) {
  const { shell } = await createTestShell();
  const dir = `/tmp/fileutils-${++n}`;
  Object.assign(shell.env, { TZ: 'UTC', LC_ALL: 'C', USER: 'user' });
  let out = '';
  let err = '';
  await shell.execute(`mkdir -p ${dir} && cd ${dir}`, () => {});
  await shell.execute(script, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('file utilities conformance (GNU)', () => {
  it("diff: GNU hunks in normal, unified and context formats", async () => {
    const r = await sh("printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\ni\\nj\\nk\\n' > x; printf 'a\\nB\\nc\\nd\\ne\\nf\\ng\\nh\\ni\\nj\\nk\\nl\\n' > y\ndiff x y; echo \"st=$?\"; diff -u -L x -L y x y; diff -C1 -L x -L y x y; diff x x; echo \"st=$?\"\nprintf 'c\\na\\nd\\na\\nc\\nb\\nc\\n' > p; printf 'c\\nz\\na\\nd\\na\\nc\\nb\\nc\\nc\\n' > q; diff -U2 p q | tail -n +3");
    expect(r.out).toBe("2c2\n< b\n---\n> B\n11a12\n> l\nst=1\n--- x\n+++ y\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n@@ -9,3 +9,4 @@\n i\n j\n k\n+l\n*** x\n--- y\n***************\n*** 1,3 ****\n  a\n! b\n  c\n--- 1,3 ----\n  a\n! B\n  c\n***************\n*** 11 ****\n--- 11,12 ----\n  k\n+ l\nst=0\n@@ -1,3 +1,4 @@\n c\n+z\n a\n d\n@@ -6,2 +7,3 @@\n b\n c\n+c\n");
    expect(r.err).toBe("");
  });

  it("diff: stdin, missing newline, -b -w -B -i -q -s", async () => {
    const r = await sh("printf 'qwe\\nasd\\nzxc' > in; echo asd | diff -u - in | sed 's/\\t.*//'; echo \"st=$?\"\nprintf 'abc' > n1; printf 'abc \\n' > n2; diff n1 n2; diff -b n1 n2; echo \"b=$?\"\nprintf 'a \\t c\\n' > w1; printf 'a\\t \\tc\\n' > w2; diff -w w1 w2; echo \"w=$?\"\nprintf '\\n1\\n' > b1; printf '1\\n' > b2; diff -qB b1 b2; echo \"B=$?\"; diff -q b1 b2; echo \"q=$?\"\nprintf 'A\\n' > c1; printf 'a\\n' > c2; diff -i c1 c2; echo \"i=$?\"; diff -s c1 c1; diff c1 nope; echo \"st=$?\" ");
    expect(r.out).toBe("--- -\n+++ in\n@@ -1 +1,3 @@\n+qwe\n asd\n+zxc\n\\ No newline at end of file\nst=0\n1c1\n< abc\n\\ No newline at end of file\n---\n> abc \nb=0\nw=0\nB=0\nFiles b1 and b2 differ\nq=1\ni=0\nFiles c1 and c1 are identical\nst=2\n");
    expect(r.err).toBe("diff: nope: No such file or directory\n");
  });

  it("diff: directories with -r and -N", async () => {
    const r = await sh("mkdir -p d1/sub d2/sub; echo 1 > d1/a; echo 2 > d2/a; echo x > d1/only; echo y > d1/sub/z; echo w > d2/sub/z\ndiff d1 d2; echo \"st=$?\"; diff -r d1 d2; diff -ruN d1 d2 | sed 's/\\t.*//'; diff -q d1 d2; diff -u d1 d2/a | sed 's/\\t.*//'");
    expect(r.out).toBe("diff d1/a d2/a\n1c1\n< 1\n---\n> 2\nOnly in d1: only\nCommon subdirectories: d1/sub and d2/sub\nst=1\ndiff -r d1/a d2/a\n1c1\n< 1\n---\n> 2\nOnly in d1: only\ndiff -r d1/sub/z d2/sub/z\n1c1\n< y\n---\n> w\ndiff -ruN d1/a d2/a\n--- d1/a\n+++ d2/a\n@@ -1 +1 @@\n-1\n+2\ndiff -ruN d1/only d2/only\n--- d1/only\n+++ d2/only\n@@ -1 +0,0 @@\n-x\ndiff -ruN d1/sub/z d2/sub/z\n--- d1/sub/z\n+++ d2/sub/z\n@@ -1 +1 @@\n-y\n+w\nFiles d1/a and d2/a differ\nOnly in d1: only\nCommon subdirectories: d1/sub and d2/sub\n--- d1/a\n+++ d2/a\n@@ -1 +1 @@\n-1\n+2\n");
    expect(r.err).toBe("");
  });

  it("xargs: batching, quoting, delimiters, EOF string, exit statuses", async () => {
    const r = await sh("printf '1 2 3 4 5\\n' | xargs -n2 echo\nprintf '\"a b\" c\\\\ d '\"'\"'e f'\"'\"'\\n' | xargs -n1 echo\nprintf 'x\\0y z\\0' | xargs -0 -n1 echo; printf 'x,y,z' | xargs -d, echo\nprintf 'a\\n_\\nb\\n' | xargs -E _ echo; printf 'a\\n_\\nb\\n' | xargs echo\nprintf 'a b\\nc d e\\nf\\n' | xargs -L 2 echo; printf 'a b \\nc\\n' | xargs -L 1 echo\nprintf ' \\n2\\n\\n 6 6 \\n \\v \\t 7\\n' | xargs -I% echo '[%]'\nprintf '' | xargs echo empty; printf '' | xargs -r echo never; echo \"r=$?\"\necho 1 | xargs false; echo \"st=$?\"; echo 1 | xargs sh -c 'exit 255'; echo \"st=$?\"\necho a | xargs no-such-cmd; echo \"st=$?\"; echo \"a 'b\" | xargs echo; echo \"st=$?\"\nprintf '1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 00\\n' | xargs -s25 echo");
    expect(r.out).toBe("1 2\n3 4\n5\na b\nc d\ne f\nx\ny z\nx y z\na\na _ b\na b c d e\nf\na b c\n[2]\n[6 6 ]\n[7]\nempty\nr=0\nst=123\nst=124\nst=127\na\nst=1\n1 2 3 4 5 6 7 8 9 0\n1 2 3 4 5 6 7 8 9\n00\n");
    expect(r.err).toBe("xargs: sh: exited with status 255; aborting\nxargs: no-such-cmd: No such file or directory\nxargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n");
  });

  it("find: GNU expressions, actions and start-point names", async () => {
    const r = await sh("mkdir -p d/sub/deep d/e; echo hi > d/a.txt; echo > d/sub/b.ts; touch d/empty; ln -s a.txt d/link\ncd d; find . | sort; find . -name '*.txt' -o -name '*.ts' | sort; find . ! -name '*.ts' -type f | sort\nfind . -empty | sort; find . -maxdepth 1 -type l; find . -path './sub' -prune -o -type f -print | sort\nfind sub -printf '%p|%f|%h|%P|%d|%y\\n' | sort; find . -type f -exec echo X {} \\; | sort\nfind . -name 'a*' -quit; find . -regex '.*\\.t[sx]t*' | sort; find . -regextype posix-extended -regex '.*/(a|b)\\..*' | sort\nfind . -size +0c -type f | sort; find nope; echo \"st=$?\"; find . -type f -name e -o -name x -print; find ./// -name . ; find / -maxdepth 0 -name /\nfind . -name sub -a -print , -name e -print | sort; find a.txt -exec false {} \\; ; echo \"st=$?\"; find a.txt -exec false {} + ; echo \"st=$?\"\nfind . -xtype f | sort; find . -depth -type d | head -2; find . -mindepth 2 | sort");
    expect(r.out).toBe(".\n./a.txt\n./e\n./empty\n./link\n./sub\n./sub/b.ts\n./sub/deep\n./a.txt\n./sub/b.ts\n./a.txt\n./empty\n./e\n./empty\n./sub/deep\n./link\n./a.txt\n./empty\nsub/b.ts|b.ts|sub|b.ts|1|f\nsub/deep|deep|sub|deep|1|d\nsub|sub|.||0|d\nX ./a.txt\nX ./empty\nX ./sub/b.ts\n./a.txt\n./sub/b.ts\n./a.txt\n./sub/b.ts\n./a.txt\n./sub/b.ts\nst=1\n.///\n/\n./e\n./sub\nst=0\nst=1\n./a.txt\n./empty\n./link\n./sub/b.ts\n./e\n./sub/deep\n./sub/b.ts\n./sub/deep\n");
    expect(r.err).toBe("find: 'nope': No such file or directory\n");
  });

  it("realpath, dirname, basename edge cases", async () => {
    const r = await sh("P=$(pwd -P); mkdir -p a/b; touch a/f; ln -s a/b lb; ln -s ../f a/b/up; ln -s nowhere dang; ln -s loop1 loop2; ln -s loop2 loop1\nfor x in a a/b/../f lb/up lb/.. dang /not_file/ //x; do realpath \"$x\" | sed \"s|$P|P|\"; done\nrealpath -L lb/.. | sed \"s|$P|P|\"; realpath -s lb/up | sed \"s|$P|P|\"; realpath -e dang; echo \"st=$?\"; realpath a/f/x; realpath -m a/f/x/../y | sed \"s|$P|P|\"\nrealpath loop1; realpath --relative-to=a/b a/f; realpath --relative-base=a a/b /tmp | sed \"s|$P|P|\"; realpath -q nope/x; echo \"st=$?\"\ndirname / // //a/b a a/ foo/bar///baz ''; dirname; echo \"st=$?\"\nbasename foo foo; basename /a/b/ b; basename -a /x/y z/; basename -s .c a.c b.c; basename /; basename a b c; echo \"st=$?\" ");
    expect(r.out).toBe("P/a\nP/a/f\nP/a/f\nP/a\nP/nowhere\n/not_file\n/x\nP\nP/lb/up\nst=1\nP/a/f/y\n../f\nb\n/tmp\nst=1\n/\n/\n//a\n.\n.\nfoo/bar\n.\nst=1\nfoo\nb\ny\nz\na\nb\n/\nst=1\n");
    expect(r.err).toBe("realpath: dang: No such file or directory\nrealpath: a/f/x: Not a directory\nrealpath: loop1: Too many levels of symbolic links\ndirname: missing operand\nTry 'dirname --help' for more information.\nbasename: extra operand 'c'\nTry 'basename --help' for more information.\n");
  });

  it("cp, mv, ln: links, directories, errors", async () => {
    const r = await sh("echo one > f1; echo two > f2; mkdir d; ln -s f1 s1\ncp -d s1 s2; readlink s2; cp s1 s3; test -L s3 || cat s3; cp -a s1 s4; readlink s4\ncp d e; echo \"st=$?\"; cp -r d e; cp -r d d/x; echo \"st=$?\"; cp f1 f1; echo \"st=$?\"; cp f1 f2 nod; echo \"st=$?\"\ncp -v f1 c1; cp -n f2 c1 2>/dev/null; cat c1; mkdir -p p/q; touch p/q/r; mkdir pd; cp --parents p/q/r pd; ls pd/p/q\nln f1 h1; cat h1; ln f1 h1; echo \"st=$?\"; ln -sf f2 s1; readlink s1; ln -s f1 s1; echo \"st=$?\"; ln d dd; echo \"st=$?\"\nln -s d sd; ln -sfn f1 sd; readlink sd; ln -t d -s ../f2; readlink d/f2; ln -sr f1 d/rel; readlink d/rel\nmv f1 m1; cat m1; mv m1 d; ls d; mv d d/sub; echo \"st=$?\"; mv nope x; echo \"st=$?\"\nmkdir e2 e3 e3/e2; touch e3/e2/x; mv e2 e3; echo \"st=$?\"; mv -t e3 c1; ls e3; mv -v h1 h2");
    expect(r.out).toBe("f1\none\nf1\nst=1\nst=1\nst=1\nst=1\n'f1' -> 'c1'\none\nr\none\nst=1\nf2\nst=1\nst=1\nf1\n../f2\n../f1\none\nf2\nm1\nrel\nx\nst=1\nst=1\nst=1\nc1\ne2\nrenamed 'h1' -> 'h2'\n");
    expect(r.err).toBe("cp: -r not specified; omitting directory 'd'\ncp: cannot copy a directory, 'd', into itself, 'd/x'\ncp: 'f1' and 'f1' are the same file\ncp: target 'nod': No such file or directory\nln: failed to create hard link 'h1': File exists\nln: failed to create symbolic link 's1': File exists\nln: d: hard link not allowed for directory\nmv: cannot move 'd' to a subdirectory of itself, 'd/sub'\nmv: cannot stat 'nope': No such file or directory\nmv: cannot overwrite 'e3/e2': Directory not empty\n");
  });

  it("du sizes, depth and totals", async () => {
    const r = await sh("mkdir -p d/s/t; printf 'hello' > d/a; printf '%3000s' x > d/s/b; printf '%20000s' y > d/s/t/c\ndu -ab d | sort -k2; du -sb d; du -cb d d/s; du -b --max-depth=1 d | sort -k2; du -bS d | sort -k2\ndu --apparent-size -h d/s/t/c d/a; du --apparent-size -BK d/a; du nope; echo \"st=$?\" ");
    expect(r.out).toBe("23005\td\n5\td/a\n23000\td/s\n3000\td/s/b\n20000\td/s/t\n20000\td/s/t/c\n23005\td\n20000\td/s/t\n23000\td/s\n23005\td\n23005\ttotal\n23005\td\n23000\td/s\n5\td\n3000\td/s\n20000\td/s/t\n20K\td/s/t/c\n5\td/a\n1K\td/a\nst=1\n");
    expect(r.err).toBe("du: cannot access 'nope': No such file or directory\n");
  });

  it("ls one-per-line output, indicators, sorting and errors", async () => {
    const r = await sh("mkdir -p d/sub e; printf 'hello' > d/a; printf 'xyz' > d/b.txt; touch d/.hid; ln -s a d/la; chmod 755 d/a\nls d; ls -a d; ls -A d; ls -F d; ls -p d; ls -r d; ls -d d e; ls e; ls -1 d e; ls -m d\nls nope d/a; echo \"st=$?\"; ls -I '*.txt' d; ls -X d; ls -R d");
    expect(r.out).toBe("a\nb.txt\nla\nsub\n.\n..\n.hid\na\nb.txt\nla\nsub\n.hid\na\nb.txt\nla\nsub\na*\nb.txt\nla@\nsub/\na\nb.txt\nla\nsub/\nsub\nla\nb.txt\na\nd\ne\nd:\na\nb.txt\nla\nsub\n\ne:\na, b.txt, la, sub\nd/a\nst=2\na\nla\nsub\na\nla\nsub\nb.txt\nd:\na\nb.txt\nla\nsub\n\nd/sub:\n");
    expect(r.err).toBe("ls: cannot access 'nope': No such file or directory\n");
  });

  it("tar create, list, extract, exclude and errors", async () => {
    const r = await sh("mkdir -p d/s; echo hi > d/f; ln -s f d/l; echo x > d/s/g\ntar cvf a.tar d; tar tf a.tar; mkdir out; tar xvf a.tar -C out; cat out/d/f out/d/s/g; readlink out/d/l\ntar xf a.tar nope; echo \"st=$?\"; tar cf b.tar nope d/f; echo \"st=$?\"; tar tf b.tar; cat a.tar | tar tf -\ntar xOf a.tar d/f; tar czf c.tgz d; tar tzf c.tgz; mkdir o2; tar xzf c.tgz -C o2 --strip-components=1; ls o2\necho s > ex; tar cf e.tar --exclude=s d; tar tf e.tar; mkdir o3; tar xf a.tar -X ex -C o3; find o3 | sort\ntar rf a.tar ex; tar tf a.tar | tail -1; tar; echo \"st=$?\" ");
    expect(r.out).toBe("d/\nd/f\nd/l\nd/s/\nd/s/g\nd/\nd/f\nd/l\nd/s/\nd/s/g\nd/\nd/f\nd/l\nd/s/\nd/s/g\nhi\nx\nf\nst=2\nst=2\nd/f\nd/\nd/f\nd/l\nd/s/\nd/s/g\nhi\nd/\nd/f\nd/l\nd/s/\nd/s/g\nf\nl\ns\nd/\nd/f\nd/l\no3\no3/d\no3/d/f\no3/d/l\nex\nst=2\n");
    expect(r.err).toBe("tar: nope: Not found in archive\ntar: Exiting with failure status due to previous errors\ntar: nope: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\ntar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.\n");
  });

  it("dd byte counts, offsets and conversions", async () => {
    const r = await sh("echo I WANT | dd count=3 iflag=count_bytes 2>/dev/null; echo\nprintf 'hello world' | dd bs=4 skip=1 count=1 2>/dev/null; echo\nprintf 'abcdefgh' > f; printf 'XY' | dd of=f bs=1 seek=2 conv=notrunc 2>/dev/null; cat f; echo\nprintf 'XY' | dd of=f bs=1 seek=2 2>/dev/null; cat f; echo; printf 'abc' | dd conv=ucase 2>/dev/null; echo\nprintf 'abcd' | dd conv=swab status=none; echo; printf 'abcde' | dd bs=2 status=noxfer of=g; cat g; echo\ndd if=/dev/zero bs=512 count=2 status=none | wc -c; dd bad; echo \"st=$?\" ");
    expect(r.out).toBe("I W\no wo\nabXYefgh\nabXY\nABC\nbadc\nabcde\n1024\nst=1\n");
    expect(r.err).toBe("2+1 records in\n2+1 records out\ndd: unrecognized operand 'bad'\nTry 'dd --help' for more information.\n");
  });

  it("date: POSIX TZ rules, -d forms and formats", async () => {
    const r = await sh("TZ=EET-2EEST,M3.5.0/3,M10.5.0/4 date -d @1288486799; TZ=EET-2EEST,M3.5.0/3,M10.5.0/4 date -d @1288486801\nTZ=GMT0BST,M3.5.0/1,M10.5.0/2 date -d '2021-03-28 01:00:01 +0000'; TZ=GMT0BST,M3.5.0/1,M10.5.0/2 date -d '2021-10-31 01:00:01 +0000'\nTZ=UTC0 date -d '1999-1-2 3:4:5 +0600'; TZ=UTC0 date -d '1999-1-2 3:4:5Z'; TZ=EST5EDT date -d @1700000000; TZ='<+03>-3' date -d @0\ndate -u -d 'Sat Jan  2 03:04:05 UTC 1999'; date -u -d '5 Jan 2020 12:00'; date -u -d '12/31/2020'; date -u -d @1.5 +%s.%N\ndate -u -d '2020-01-05 3 days ago' +%F; date -u -d '2020-01-31 1 month' +%F; date -u -d '2020-01-05 +2 hours' +%T\ndate -u -I -d @0; date -u -Iseconds -d @0; date -u --rfc-3339=ns -d @0; date -u -R -d @0\ndate -u -d @0 '+%-d|%_m|%^a|%10Y|%:z|%j|%U|%V|%G|%C|%q|%k|%l|%e|%P|%I|%u|%w|%W|%D|%r|%3N|%Z'\ndate -u -d garbage; echo \"st=$?\"; for d in 2020-12-28 2021-01-03 2027-01-01; do date -u -d $d +'%G-W%V'; done");
    expect(r.out).toBe("Sun Oct 31 03:59:59 EEST 2010\nSun Oct 31 03:00:01 EET 2010\nSun Mar 28 02:00:01 BST 2021\nSun Oct 31 01:00:01 GMT 2021\nFri Jan  1 21:04:05 UTC 1999\nSat Jan  2 03:04:05 UTC 1999\nTue Nov 14 17:13:20 EST 2023\nThu Jan  1 03:00:00 +03 1970\nSat Jan  2 03:04:05 UTC 1999\nSun Jan  5 12:00:00 UTC 2020\nThu Dec 31 00:00:00 UTC 2020\n1.500000000\n2020-01-02\n2020-03-02\n02:00:00\n1970-01-01\n1970-01-01T00:00:00+00:00\n1970-01-01 00:00:00.000000000+00:00\nThu, 01 Jan 1970 00:00:00 +0000\n1| 1|THU|0000001970|+00:00|001|00|01|1970|19|1| 0|12| 1|am|12|4|4|00|01/01/70|12:00:00 AM|000|UTC\nst=1\n2020-W53\n2020-W53\n2026-W53\n");
    expect(r.err).toBe("date: invalid date 'garbage'\n");
  });

  it("patch: offsets, fuzz, reversed hunks, -R, -o and new files", async () => {
    const r = await sh("printf 'abc\\n123\\n' > p0; printf -- '--- input.old\\n+++ input\\n@@ -1,2 +1,3 @@\\n abc\\n+def\\n 123\\n' > p1\nprintf '0\\n1\\n2\\nabc\\n123\\n' > input; patch < p1; echo \"st=$?\"; cat input\npatch < p1; echo \"st=$?\"; cat input.rej; rm input.rej; patch -N < p1; echo \"st=$?\"; rm -f input.rej\npatch -R < p1; cat input; patch -o out p0 < p1; cat out; cp p0 dry; patch --dry-run dry < p1; cat dry\nprintf 'l1\\nl2\\nl3\\nl4\\nl5\\nX\\nl7\\nl8\\n' > f2; printf -- '--- f2\\n+++ f2\\n@@ -3,5 +3,5 @@\\n l3\\n l4\\n-l5\\n+L5\\n l6\\n l7\\n' | patch; cat f2\nprintf -- '--- /dev/null\\n+++ newf\\n@@ -0,0 +1 @@\\n+qwerty\\n' | patch; cat newf\nprintf 'a\\nb\\nc\\nd\\n' > g1; printf 'a\\nB\\nc\\nd\\nX\\n' > g2; diff -c g1 g2 > gc; cp g2 g3; patch -R g3 < gc; cat g3\ndiff g1 g2 > gn; cp g1 g4; patch g4 gn; cat g4");
    expect(r.out).toBe("patching file input\nHunk #1 succeeded at 4 (offset 3 lines).\nst=0\n0\n1\n2\nabc\ndef\n123\npatching file input\nReversed (or previously applied) patch detected!  Assume -R? [n] \nApply anyway? [n] \nSkipping patch.\n1 out of 1 hunk ignored -- saving rejects to file input.rej\nst=1\n--- input.old\n+++ input\n@@ -1,2 +1,3 @@\n abc\n+def\n 123\npatching file input\nReversed (or previously applied) patch detected!  Skipping patch.\n1 out of 1 hunk ignored -- saving rejects to file input.rej\nst=1\npatching file input\nHunk #1 succeeded at 4 (offset 3 lines).\n0\n1\n2\nabc\n123\npatching file out (read from p0)\nabc\ndef\n123\nchecking file dry\nabc\n123\npatching file f2\nHunk #1 succeeded at 3 with fuzz 2.\nl1\nl2\nl3\nl4\nL5\nX\nl7\nl8\npatching file newf\nqwerty\npatching file g3\na\nb\nc\nd\npatching file g4\na\nB\nc\nd\nX\n");
    expect(r.err).toBe("");
  });

  it("expr: arbitrary precision, string functions and errors", async () => {
    const r = await sh("expr 9223372036854775807 + 1; expr -9223372036854775800 = -9223372036854775800; expr 7 / -2; expr -7 % 2\nexpr 1 \\| 0; expr 0 \\& 1; echo \"st=$?\"; expr 2 \\* 3 + 1; expr '(' 1 + 2 ')' \\* 3; expr 10 \\>= 9; expr 010 + 1\nexpr length abc; expr substr hello 2 3; expr index hello l; expr match abc 'a\\(b\\)'; expr abc : 'a.'\nexpr abc : 'x*'; echo \"st=$?\"; expr + length; expr 00; echo \"st=$?\"; expr 5 / 0; echo \"st=$?\"; expr 1 + a; echo \"st=$?\"\nexpr 1 +; echo \"st=$?\"; expr 1 2; echo \"st=$?\"; expr '(' 1; echo \"st=$?\"; expr 0 \\| ''; echo \"st=$?\" ");
    expect(r.out).toBe("9223372036854775808\n1\n-3\n-1\n1\n0\nst=1\n7\n9\n1\n11\n3\nell\n3\nb\n2\n0\nst=1\nlength\n00\nst=1\nst=2\nst=2\nst=2\nst=2\nst=2\n0\nst=1\n");
    expect(r.err).toBe("expr: division by zero\nexpr: non-integer argument\nexpr: syntax error: missing argument after '+'\nexpr: syntax error: unexpected argument '2'\nexpr: syntax error: expecting ')' after '1'\n");
  });

});
