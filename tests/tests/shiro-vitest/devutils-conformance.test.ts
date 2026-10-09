/**
 * GNU behaviour of cmp, chmod, head/dd/od on /dev/zero and /dev/urandom,
 * tr with NUL bytes, and wc/cat with binary data. Expected outputs are the
 * host GNU tools' (coreutils, diffutils 3.10; LC_ALL=C, umask 022).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '';
  let err = '';
  await shell.execute('rm -rf /tmp/devutils && mkdir -p /tmp/devutils && cd /tmp/devutils', () => {}, () => {});
  const status = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status };
}

describe('cmp, chmod, /dev devices, tr and NUL bytes behave like GNU', () => {
  it("cmp: - is stdin (as FILE1, FILE2, or a missing FILE2)", async () => {
    const r = await sh("printf 'abc\\nxyz\\n' > a; printf 'abc\\nxYz\\nmore\\n' > b; cat a | cmp a -; echo \"st=$?\"; cat b | cmp - a; echo \"st=$?\"; cat a | cmp b; echo \"st=$?\"; echo x | cmp - -; echo \"st=$?\"");
    expect(r.out).toBe("st=0\n- a differ: char 6, line 2\nst=1\nb - differ: char 6, line 2\nst=1\nst=0\n");
  });

  it("cmp: differ message, -b, -l, -lb, -s and exit statuses", async () => {
    const r = await sh("printf 'abc\\nxyz\\n' > a; printf 'abc\\nxYz\\nmore\\n' > b; cmp a b; echo \"st=$?\"; cmp -b a b; cmp -l a b 2>/dev/null; cmp -lb a b 2>/dev/null; cmp -s a b; echo \"st=$?\"; cmp a a; echo \"st=$?\"; cmp -s a nope; echo \"st=$?\"; printf '\\0\\001' > b1; printf '\\0\\177' > b2; cmp -b b1 b2; cmp -lb b1 b2");
    expect(r.out).toBe("a b differ: char 6, line 2\nst=1\na b differ: byte 6, line 2 is 171 y 131 Y\n6 171 131\n6 171 y    131 Y\nst=1\nst=0\nst=2\nb1 b2 differ: byte 2, line 1 is   1 ^A 177 ^?\n2   1 ^A   177 ^?\n");
  });

  it("cmp: EOF messages", async () => {
    const r = await sh("printf 'abc\\nxyz\\n' > a; printf 'abc\\n' > c; : > e; printf 'abc' > p1; printf 'abcd' > p2; cmp a c 2>&1; echo \"st=$?\"; cmp e a 2>&1; cmp p1 p2 2>&1; cmp -l c a 2>&1; cmp -s a c; echo \"st=$?\"");
    expect(r.out).toBe("cmp: EOF on c after byte 4, line 1\nst=1\ncmp: EOF on e which is empty\ncmp: EOF on p1 after byte 3, in line 1\ncmp: EOF on c after byte 4\nst=1\n");
  });

  it("cmp: -n, -i, SKIP operands, size suffixes, -l offset width", async () => {
    const r = await sh("printf 'abc\\nxyz\\n' > a; printf 'abc\\nxYz\\nmore\\n' > b; cmp -n 5 a b; echo \"st=$?\"; cmp -n 6 a b; cmp -i 2 a b; cmp -i 2:3 a b; cmp a b 2 3; cmp --bytes=2 --ignore-initial=1:2 a b; cmp -i 1k a b; echo \"st=$?\"; printf '%0130d1' 0 > l1; printf '%0130d2' 0 > l2; cmp -l l1 l2; cmp -l -n 20 l1 l2; cat l1 | cmp -l l2 -");
    expect(r.out).toBe("st=0\na b differ: char 6, line 2\na b differ: char 4, line 2\na b differ: char 1, line 1\na b differ: char 1, line 1\na b differ: char 1, line 1\nst=0\n131  61  62\n131  62  61\n");
  });

  it("cmp: usage errors exit 2", async () => {
    const r = await sh("printf 'abc\\n' > a; cmp a nope 2>&1; echo \"st=$?\"; cmp 2>&1; echo \"st=$?\"; cmp -l -s a a 2>&1; echo \"st=$?\"; cmp -n 1x a a 2>&1; echo \"st=$?\"; cmp -z a a 2>&1; echo \"st=$?\"");
    expect(r.out).toBe("cmp: nope: No such file or directory\nst=2\ncmp: missing operand after 'cmp'\ncmp: Try 'cmp --help' for more information.\nst=2\ncmp: options -l and -s are incompatible\ncmp: Try 'cmp --help' for more information.\nst=2\ncmp: invalid --bytes value '1x'\ncmp: Try 'cmp --help' for more information.\nst=2\ncmp: invalid option -- 'z'\ncmp: Try 'cmp --help' for more information.\nst=2\n");
  });

  it("chmod: symbolic modes (who, ops, perms, copies, comma lists, umask)", async () => {
    const r = await sh("umask 022; touch f; for m in 640:a-r 755:u-r 644:g=u,o+t 644:u+x,g=u,o-r 644:+X 744:+X 644:a+rw-x+t 2755:ug+s 6755:-s 755:-r 000:=r 644:o=u 640:go=u-w 600:a=,u=rw 644:u=rwx,g+s 755:=,o+x 2744:g-s; do chmod \"${m%%:*}\" f; chmod \"${m#*:}\" f; echo \"$m $(ls -l f | cut -c1-10)\"; done");
    expect(r.out).toBe("640:a-r --w-------\n755:u-r --wxr-xr-x\n644:g=u,o+t -rw-rw-r-T\n644:u+x,g=u,o-r -rwxrwx---\n644:+X -rw-r--r--\n744:+X -rwxr-xr-x\n644:a+rw-x+t -rw-rw-rwT\n2755:ug+s -rwsr-sr-x\n6755:-s -rwxr-xr-x\n755:-r --wx--x--x\n000:=r -r--r--r--\n644:o=u -rw-r--rw-\n640:go=u-w -rw-r--r--\n600:a=,u=rw -rw-------\n644:u=rwx,g+s -rwxr-Sr--\n755:=,o+x ---------x\n2744:g-s -rwxr--r--\n");
  });

  it("chmod: directories keep set-ID bits for short octal modes; X on directories", async () => {
    const r = await sh("mkdir d; chmod 2755 d; chmod 755 d; ls -ld d | cut -c1-10; chmod 00755 d; ls -ld d | cut -c1-10; chmod g+s d; chmod u=g d; ls -ld d | cut -c1-10; chmod 755 d; chmod a-x,+X d; ls -ld d | cut -c1-10");
    expect(r.out).toBe("drwxr-sr-x\ndrwxr-xr-x\ndr-xr-sr-x\ndrwxr-sr-x\n");
  });

  it("chmod: umask surprise warning, -v/-c/-f, errors", async () => {
    const r = await sh("umask 022; touch f; chmod 777 f; chmod -w f 2>&1; echo \"st=$?\"; chmod 644 f; chmod -v 644 f; chmod -c 644 f; chmod -c 600 f; chmod -v u+x f; chmod -v a+x nope 2>/dev/null; chmod a+x nope 2>&1; echo \"st=$?\"; chmod -f 644 nope; echo \"st=$?\"; chmod 9 f 2>&1; echo \"st=$?\"; chmod u+q f 2>&1; chmod 2>&1; chmod 644 2>&1; echo \"st=$?\"");
    expect(r.out).toBe("chmod: f: new permissions are r-xrwxrwx, not r-xr-xr-x\nst=1\nmode of 'f' retained as 0644 (rw-r--r--)\nmode of 'f' changed from 0644 (rw-r--r--) to 0600 (rw-------)\nmode of 'f' changed from 0600 (rw-------) to 0700 (rwx------)\n'nope' could not be accessed\nchmod: cannot access 'nope': No such file or directory\nst=1\nst=1\nchmod: invalid mode: '9'\nTry 'chmod --help' for more information.\nst=1\nchmod: invalid mode: 'u+q'\nTry 'chmod --help' for more information.\nchmod: missing operand\nTry 'chmod --help' for more information.\nchmod: missing operand after '644'\nTry 'chmod --help' for more information.\nst=1\n");
  });

  it("chmod: --reference and -R", async () => {
    const r = await sh("mkdir d; touch f; chmod 2750 d; chmod --reference=d f; ls -l f | cut -c1-10; mkdir -p r/s; touch r/s/y; chmod -R 700 r; ls -l r/s/y | cut -c1-10; ls -ld r/s | cut -c1-10; chmod -R go+rX r; ls -l r/s/y | cut -c1-10; ls -ld r/s | cut -c1-10; chmod -Rv u-w r/s");
    expect(r.out).toBe("-rwxr-s---\n-rwx------\ndrwx------\n-rwxr-xr-x\ndrwxr-xr-x\nmode of 'r/s' changed from 0755 (rwxr-xr-x) to 0555 (r-xr-xr-x)\nmode of 'r/s/y' changed from 0755 (rwxr-xr-x) to 0555 (r-xr-xr-x)\n");
  });

  it("head/dd/od read real bytes from /dev/zero and stop", async () => {
    const r = await sh("head -c 4 /dev/zero | od -An -tx1; cat /dev/zero | head -c 10 | od -An -tx1; head -c 10000 /dev/zero | wc -c; head -c 100000 /dev/zero | od -An -tx1 | tail -2; head -c 0 /dev/zero | wc -c; head -c 1K /dev/zero | wc -c; dd if=/dev/zero bs=4 count=3 2>/dev/null | od -An -tx1; dd if=/dev/zero bs=1K count=10 2>/dev/null | wc -c; od -An -tx1 -N 5 /dev/zero; od -An -tx1 -N 20000 /dev/zero | tail -2; od -c -N 3 -j 2 /dev/zero; head -c 8 /dev/urandom | od -An -tx1 | wc -w; head -n 2 /dev/urandom | wc -l");
    expect(r.out).toBe(" 00 00 00 00\n 00 00 00 00 00 00 00 00 00 00\n10000\n 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n*\n0\n1024\n 00 00 00 00 00 00 00 00 00 00 00 00\n10240\n 00 00 00 00 00\n 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n*\n0000002  \\0  \\0  \\0\n0000005\n8\n2\n");
  });

  it("tr: NUL and octal escapes in both sets, -d and -s", async () => {
    const r = await sh("printf 'a\\0b' | tr \"\\0\" \"\\n\"; printf 'a\\0b' | tr -d '\\0' | od -c; printf 'a\\0b' | tr '\\000' 'X'; echo; printf 'aXb' | tr 'X' '\\0' | od -c; printf 'a\\0b\\001' | tr '\\0\\1' '\\101\\102'; echo; printf 'abc' | tr 'a-c' '\\0-\\2' | od -c; printf 'a\\0\\0b' | tr -s '\\0' | od -c");
    expect(r.out).toBe("a\nb0000000   a   b\n0000002\naXb\n0000000   a  \\0   b\n0000003\naAbB\n0000000  \\0 001 002\n0000003\n0000000   a  \\0   b\n0000003\n");
  });

  it("wc and cat keep NUL bytes", async () => {
    const r = await sh("printf 'a\\0b\\n' | wc -c; printf 'a\\0b\\n' | cat | wc -c; printf 'a\\0b\\n' | cat -v; printf 'a\\0b\\n' > nul.txt; wc -c nul.txt; cat nul.txt | od -c; cat -A nul.txt; head -c 2 nul.txt | od -c; tail -c 3 nul.txt | od -c");
    expect(r.out).toBe("4\n4\na^@b\n4 nul.txt\n0000000   a  \\0   b  \\n\n0000004\na^@b$\n0000000   a  \\0\n0000002\n0000000  \\0   b  \\n\n0000003\n");
  });
});
