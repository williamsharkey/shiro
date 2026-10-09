/**
 * awk conformance regressions (src/commands/awk/): POSIX awk with the gawk
 * extensions busybox's testsuite uses. Every expected output was produced by
 * running the same command line under bash with GNU awk (gawk 5.2).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '';
  const status = await shell.execute(cmd, (s) => { out += s; }, () => {});
  return { out: out.replace(/\r\n/g, '\n'), status };
}

describe('awk conformance', () => {
  it("string literals print without quotes; v (a) is concatenation; \"str\" ++i", async () => {
    const r = await sh("awk 'BEGIN { print \"x\"; print \"a\" \"b\", \"c\"; v = 1; a = 2; print v (a) }'; awk -v i=1 'BEGIN { print \"str\" ++i }'");
    expect(r.out).toBe("x\nab c\n12\nstr2\n");
  });

  it("length with and without parens, length(array)", async () => {
    const r = await sh("echo qwe | awk '{ print length; print length(); print length(\"ab\"), length(99+9); print length 1; A[1]; A[\"x\"]; print length(A) }'; echo | awk 'length == 0 { print \"empty\" }'");
    expect(r.out).toBe("3\n3\n2 3\n31\n2\nempty\n");
  });

  it("user functions: empty bodies, recursion, array params by reference, scalars by value, extra args evaluated", async () => {
    const r = await sh("awk 'function e(){} function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) } function fill(a) { a[\"k\"] = 1 } function inc(x) { x++; return x } func f(){print \"F\"} func g(){print \"G\"}\nBEGIN { e(); print fact(10); fill(arr); print arr[\"k\"]; y = 5; print inc(y), y; f(g(), g()) }'");
    expect(r.out).toBe("3628800\n1\n6 5\nG\nG\nF\n");
  });

  it("getline forms: plain, var, < file, var < file, cmd |, cmd | var; close() rereads", async () => {
    const r = await sh("printf 'l1\\nl2\\nl3\\n' > /tmp/awkt_f; printf 'a\\nb\\nc\\n' | awk 'NR == 1 { getline; print \"plain\", $0, NR; getline v; print \"var\", v, NR, $0\n while ((getline line < \"/tmp/awk\"t\"_f\") > 0) n++; print n, line; close(\"/tmp/awkt_f\"); getline < \"/tmp/awkt_f\"; print $0, NF\n \"echo x y\" | getline; print $2, NF; \"echo z\" | getline w; print w; print (getline q < \"/nonexistent\") }' t=t");
    expect(r.out).toBe("plain b 2\nvar c 3 b\n \nl1 1\ny 2\nz\n-1\n");
  });

  it("print | cmd, system(), close() return status, output order", async () => {
    const r = await sh("awk 'BEGIN { print \"b\" | \"sort\"; print \"a\" | \"sort\"; r = close(\"sort\"); print \"closed\", r; s = system(\"exit 3\"); print \"sys\", s; system(\"echo from-system\") }'");
    expect(r.out).toBe("a\nb\nclosed 0\nsys 3\nfrom-system\n");
  });

  it("print > file, >> append, /dev/stderr", async () => {
    const r = await sh("awk 'BEGIN { print \"one\" > \"/tmp/awkt_o\"; print \"two\" > \"/tmp/awkt_o\"; close(\"/tmp/awkt_o\"); print \"three\" >> \"/tmp/awkt_o\"; print \"STDERR %s\" > \"/dev/stderr\" }' 2>&1; cat /tmp/awkt_o");
    expect(r.out).toBe("STDERR %s\none\ntwo\nthree\n");
  });

  it("printf conversions, flags, width/precision, *, %c with NUL", async () => {
    const r = await sh("awk 'BEGIN { printf \"%5d|%-5d|%05d|%+d|% d|%x|%X|%o|%u\\n\", 42, 42, 42, 42, 42, 255, 255, 8, -1\n printf \"%e|%E|%g|%G|%.3f|%10.3f|%-10s|%.2s|%c|%c\\n\", 1234.5, 1234.5, 0.0001234, 1e10, 3.14159, 3.14159, \"left\", \"abc\", 65, \"hello\"\n printf \"%*d|%-*d|%.*f|%i|%%|%5%|\\n\", 5, 42, 4, 7, 2, 3.14159, 7.9\n printf \"%.0f %.1f %.2f %#o %#x %#.3g\\n\", 2.5, 0.25, 1.005, 8, 255, 1 }'; awk 'BEGIN { printf \"[%-4c]\", 0 }' | od -An -tx1");
    expect(r.out).toBe("   42|42   |00042|+42| 42|ff|FF|10|18446744073709551615\n1.234500e+03|1.234500E+03|0.0001234|1E+10|3.142|     3.142|left      |ab|A|h\n   42|7   |3.14|7|%|%|\n2 0.2 1.00 010 0xff 1.00\n 5b 00 20 20 20 5d\n");
  });

  it("-F: escapes, regex, single char, long separators; FS regex never matches empty", async () => {
    const r = await sh("echo 'a!b' | awk -F'\\x21' '{ print $1 }'; echo 'z##abc##zz' | awk -F '[#]' '{ print NF }'; echo 'a|b|c' | awk -F '|' '{ print $2 }'; echo 'a.b' | awk -F. '{ print $2 }'; printf 'a--b--\\n' | awk -F-- '{ print NF, length($NF) }'; echo 'foo--bar' | awk -F '-*' '{ print $1 \"-\" $2 \"=\" $3 }'; echo 'a=====123=' | awk -F '=+' '{ print \"[\" $NF \"]\" }'");
    expect(r.out).toBe("a\n5\nb\nb\n3 0\nfoo-bar=\n[]\n");
  });

  it("FS assignment applies from the next record; NF and fields in BEGIN; default FS does not split on CR", async () => {
    const r = await sh("printf 'a:b c:d\\ne:f g:h\\n' | awk '{ FS = \":\"; print $1 }'; awk 'BEGIN { print \":\" NF \":\" $0 \":\" $1 \":\" }'; printf 'w1 w2\\r\\n' | awk '{ print NF }'");
    expect(r.out).toBe("a:b\ne\n:0:::\n2\n");
  });

  it("exit N from BEGIN survives END's bare exit; next; END sees last record", async () => {
    const r = await sh("awk 'BEGIN { exit 42 } END { exit }'; echo \"st=$?\"; printf 'a\\nb\\nc\\n' | awk 'NR == 2 { next } { print } END { print NR, $0 }'; echo x | awk '{ exit 3 } END { print \"end ran\" }'; echo \"st=$?\" ");
    expect(r.out).toBe("st=42\na\nc\n3 c\nend ran\nst=3\n");
  });

  it("uninitialized and strnum comparisons", async () => {
    const r = await sh("printf '10 9\\n1.0 1\\nabc abd\\n 10  10.0\\n' | awk '{ print ($1 < $2), ($1 == $2) }'; printf 'a\\nb\\n' | awk '$2 != 0'; awk 'BEGIN { if (x == 0 && x == \"\") print \"uninit both\"; y = \"10\"; print (y < 9) }'; echo 0.0 | awk '{ print ($1 == 0), ($1 ? \"t\" : \"f\") }'");
    expect(r.out).toBe("0 0\n0 1\n1 0\n0 1\na\nb\nuninit both\n1\n1 f\n");
  });

  it("CONVFMT and OFMT number formatting, integers, 2^31 and beyond", async () => {
    const r = await sh("awk 'BEGIN { n = (2^31) - 1; print n, int(n), n % 1, ++n, int(n), n % 1; print 2^53, 1e6, 1e16, 0.1 + 0.2, 100 / 3; CONVFMT = \"%.2f\"; a = 3.14159; b = a \"\"; print b; OFMT = \"%.3f\"; print a, 17; x[a] = 1; for (k in x) print k }'");
    expect(r.out).toBe("2147483647 2147483647 0 2147483648 2147483648 0\n9007199254740992 1000000 10000000000000000 0.3 33.3333\n3.14\n3.142 17\n3.14\n");
  });

  it("delete a[v--] evaluates the subscript once; = and ?: precedence; regex vs division", async () => {
    const r = await sh("awk 'BEGIN { cnt = 0; a[cnt] = \"zeroth\"; a[++cnt] = \"first\"; delete a[cnt--]; print cnt, \"[\" a[0] \"]\", \"[\" a[1] \"]\"; b = 0 ? \"bug\" : \"ok\"; print b; x = 8; print x / 2 / 2, x /2/ 1 }'; printf 'cat\\ndog\\n' | awk '{ print /a/ ? \"has a\" : \"no a\" }'");
    expect(r.out).toBe("0 [zeroth] []\nok\n2 4\nhas a\nno a\n");
  });

  it("backslash-newline is removed, comments, newlines after && and ,", async () => {
    const r = await sh("awk 'BEGIN { printf \"Hello\\\n world\\n\" # comment\n if (1 &&\n 1) print \"a\",\n \"b\" }'");
    expect(r.out).toBe("Hello world\na b\n");
  });

  it("-f progfile, -f - (program on stdin) and ARGC/ARGV", async () => {
    const r = await sh("echo 'do re mi' > /tmp/awkt_in; echo '{ print $2; print ARGC }' | awk -f - /tmp/awkt_in; printf '# comment\\n{ print \"P:\" $0 }\\n' > /tmp/awkt_p.awk; awk -f /tmp/awkt_p.awk /tmp/awkt_in; awk 'BEGIN { for (i = 1; i < ARGC; i++) print i, ARGV[i] }' x y");
    expect(r.out).toBe("re\n2\nP:do re mi\n1 x\n2 y\n");
  });

  it("command-line var=value operands, -v escapes, ENVIRON", async () => {
    const r = await sh("printf 'l\\n' > /tmp/awkt_l; awk '{ print v }' v=1 /tmp/awkt_l v=2 /tmp/awkt_l; awk -v 's=a\\tb' 'BEGIN { print s }'; FOO=bar awk 'BEGIN { print ENVIRON[\"FOO\"] }'");
    expect(r.out).toBe("1\n2\na\tb\nbar\n");
  });

  it("RS paragraph mode and regex RS", async () => {
    const r = await sh("printf '\\n\\na b\\nc\\n\\n\\nd e\\nf\\n\\n' | awk 'BEGIN { RS = \"\" } { print NR \": \" $1 \"/\" $NF \" (\" NF \")\" }'; printf 'a1b22c' | awk 'BEGIN { RS = \"[0-9]+\" } { print NR, $0 }'; printf 'a:b\\nc' | awk 'BEGIN { RS = \"\"; FS = \":\" } { print NF, $3 }'");
    expect(r.out).toBe("1: a/c (3)\n2: d/f (3)\n1 a\n2 b\n3 c\n3 c\n");
  });

  it("sub/gsub with & and backslashes, empty matches, match/RSTART/RLENGTH", async () => {
    const r = await sh("awk 'BEGIN { s = \"hello world\"; n = sub(/o/, \"[&]\", s); print n, s; n = gsub(/o/, \"\\\\&\", s); print n, s; t = \"abc\"; gsub(/b*/, \"-\", t); print t; u = \"abc\"; sub(/b/, \"[\\\\\\\\&]\", u); print u\n a = \"abc\"; gsub(/\\<b*/, \"\", a); print a; if (match(\"foobarbaz\", /ba[rz]/)) print RSTART, RLENGTH; print match(\"abc\", /z/), RSTART, RLENGTH }'; echo 'Hi' | awk 'gsub(\"@(samp|code|file)\\{\", \"\")'; echo \"st=$?\" ");
    expect(r.out).toBe("1 hell[o] world\n2 hell[&] w&rld\n-a-c-\na[\\b]c\nabc\n4 3\n0 0 -1\nst=0\n");
  });

  it("split with regex/char/default, substr edge cases, index, in, SUBSEP", async () => {
    const r = await sh("awk 'BEGIN { n = split(\"a1b22c\", p, /[0-9]+/); print n, p[2], p[3]; n = split(\"  x  y  \", p); print n, p[1]; n = split(\"a:b\", p, \":\"); print n, p[2]; print split(\"\", p), length(p)\n s = \"hello\"; print substr(s, 0), substr(s, -1, 3), substr(s, 2, 100), \"[\" substr(s, 10) \"]\", substr(s, 1.5, 2.3); print index(\"hello\", \"ll\"), index(\"hello\", \"z\")\n b[1, 2] = 3; for (k in b) { split(k, q, SUBSEP); print q[1], q[2] } if ((1, 2) in b) print \"multi\"; if (!(\"x\" in b)) print \"absent\" }'");
    expect(r.out).toBe("3 b c\n2 x\n2 b\n0 0\nhello hel ello [] he\n3 0\n1 2\nmulti\nabsent\n");
  });

  it("field assignment rebuilds $0; NF assignment; $(expr); negative field is fatal", async () => {
    const r = await sh("echo 'a b c' | awk '{ $5 = \"e\"; print; print NF; NF = 2; print; $1 = $1; print $NF, $(NF-1) }'; echo 'a b c d e f' | awk '$5=$$5=$0'; echo x | awk '{ $(-1) }'; echo \"st=$?\" ");
    expect(r.out).toBe("a b c  e\n5\na b\nb a\na b c d a b c d e f f\nst=2\n");
  });

  it("int, tolower/toupper, sprintf, srand/rand, math, bitwise", async () => {
    const r = await sh("awk 'BEGIN { print int(3.9), int(-3.9), int(\"4x\"), toupper(\"abC\"), tolower(\"ABc\"), sprintf(\"%03d-%s\", 7, \"x\"); srand(1); a = rand(); srand(1); b = rand(); print (a == b), (a >= 0 && a < 1), srand(2); print sqrt(16), exp(0), log(1), atan2(0, 1), or(4294967295, 1), and(12, 10), xor(12, 10) }'");
    expect(r.out).toBe("3 -3 4 ABC abc 007-x\n1 1 1\n4 1 0 0 4294967295 8 6\n");
  });

  it("range patterns, !seen[$0]++, regex dynamic strings and bracket classes", async () => {
    const r = await sh("printf 'a\\nb\\nc\\nd\\ne\\nb\\nf\\n' | awk '/b/,/d/ { print NR \": \" $0 }'; printf 'a\\nb\\na\\n' | awk '!seen[$0]++'; awk 'BEGIN { re = \"^[[:digit:]]+$\"; print (\"123\" ~ re), (\"12a\" ~ re), (\"a.c\" ~ /a\\.c/), (\"abc\" ~ \"a\\\\.c\"), (\"]\" ~ /[]]/) }'");
    expect(r.out).toBe("2: b\n3: c\n4: d\n6: b\n7: f\na\nb\n1 0 1 0 1\n");
  });

  it("syntax errors exit 1; division by zero exits 1; printf with too few args is fatal", async () => {
    const r = await sh("awk 'BEGIN { print 1 > 2 ? \"y\" : \"n\" }' 2>/dev/null; echo \"st=$?\"; awk 'BEGIN { print 1/0 }' 2>/dev/null; echo \"st=$?\"; awk 'BEGIN { printf \"%s %s\\n\", \"a\" }' 2>/dev/null; echo \"st=$?\" ");
    expect(r.out).toBe("st=1\nst=1\nst=2\n");
  });
});
