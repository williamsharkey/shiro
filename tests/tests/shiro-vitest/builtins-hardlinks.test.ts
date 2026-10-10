/**
 * The builtins on real hard links (FileSystem.link): ln without -s, cp -l,
 * tar's hard-link members both ways, and stat/ls/find seeing st_nlink.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '';
  const code = await shell.execute(`mkdir -p /tmp/hl && cd /tmp/hl && rm -rf /tmp/hl/* /tmp/hl-x; ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('hard links in the builtins', () => {
  it('ln makes a second name for the same file: shared data, nlink 2, one inode', async () => {
    const r = await sh('echo one > a; ln a b; echo two >> b; cat a; stat -c "%h" a b; [ "$(stat -c %i a)" = "$(stat -c %i b)" ] && echo same-ino; ls -l a | cut -d" " -f2');
    expect(r.out).toBe('one\ntwo\n2\n2\nsame-ino\n2\n');
  });

  it('ln refuses an existing name and directories; -f replaces', async () => {
    const r = await sh('echo x > a; echo y > b; ln a b; echo st=$?; ln -f a b; cat b; mkdir d; ln d e; echo st=$?');
    expect(r.out).toBe("ln: failed to create hard link 'b': File exists\nst=1\nx\nln: d: hard link not allowed for directory\nst=1\n");
  });

  it('rm drops one name; the other keeps the data', async () => {
    expect((await sh('echo keep > a; ln a b; rm a; cat b; stat -c %h b')).out).toBe('keep\n1\n');
  });

  it('cp -l links instead of copying; an existing name needs -f', async () => {
    const r = await sh('echo d > a; cp -l a c; stat -c %h a; cp -l a c; echo st=$?; cp -lf a c; echo st=$?; echo more >> c; cat a');
    expect(r.out).toBe("2\ncp: cannot create hard link 'c' to 'a': File exists\nst=1\nst=0\nd\nmore\n");
  });

  it('find -links sees them', async () => {
    expect((await sh('echo 1 > a; ln a b; echo 2 > c; find . -type f -links +1 | sort')).out).toBe('./a\n./b\n');
  });

  it('tar stores a second name as a hard-link member and extracts it as a link', async () => {
    const r = await sh('echo t > a; ln a c; tar cf /tmp/hl.tar a c; tar tvf /tmp/hl.tar | grep -c "c link to a"; ' +
      'mkdir /tmp/hl-x && cd /tmp/hl-x && tar xf /tmp/hl.tar && stat -c "%h %n" a c && echo z >> c && cat a');
    expect(r.out).toBe('1\n2 a\n2 c\nt\nz\n');
  });
});

describe('cp keeps links among what it copies', () => {
  it('cp -a (and -d, --preserve=links): two names of one file copy to two names of one copy', async () => {
    const r = await sh('mkdir src; echo s > src/a; ln src/a src/b; cp -a src dst; stat -c %h dst/a dst/b; ' +
      '[ "$(stat -c %i dst/a)" = "$(stat -c %i dst/b)" ] && echo linked; [ "$(stat -c %i dst/a)" != "$(stat -c %i src/a)" ] && echo a-copy');
    expect(r.out).toBe('2\n2\nlinked\na-copy\n');
    expect((await sh('echo s > a; ln a b; mkdir out; cp --preserve=links a b out; stat -c %h out/a')).out).toBe('2\n');
  });

  it('plain cp copies each name separately', async () => {
    expect((await sh('echo s > a; ln a b; mkdir out; cp a b out; stat -c %h out/a out/b')).out).toBe('1\n1\n');
  });
});
