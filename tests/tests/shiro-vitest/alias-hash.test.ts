/**
 * Aliases as bash's parser sees them (only a literal command word; a
 * function's body expands the aliases of its definition) and the `hash`
 * table (only commands found; -t -p -d -l -r; emptied when PATH changes).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { rawCommandWord } from '@shiro/shell';

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('aliases', () => {
  it('a command word that comes from an expansion or quoting is no alias', async () => {
    expect((await sh("alias ll='echo LL'; x=ll; $x; echo $?")).out).toMatch(/command not found: ll\n127\n$/);
    expect((await sh("alias ll='echo LL'; x=ll; \"$x\"; echo $?")).out).toMatch(/command not found: ll\n127\n$/);
    expect((await sh("alias ll='echo LL'; \\ll; 'll'; echo $?")).out).toMatch(/command not found: ll\n.*command not found: ll\n127\n$/s);
  });

  it('literal words, after assignments and redirections, and the trailing-blank chain', async () => {
    expect((await sh("alias ll='echo LL'; X=1 ll; 2>/dev/null ll")).out).toBe('LL\nLL\n');
    expect((await sh("alias s='echo S '; alias t='echo T'; s t")).out).toBe('S echo T\n');
    expect((await sh("alias ll='echo LL'; true | ll")).out).toBe('LL\n');
  });

  it("a function body expands the aliases of its definition", async () => {
    expect((await sh("alias e='echo'; f() { e in-func; }; unalias e; f")).out).toBe('in-func\n');
    const later = await sh("f() { e2 x; }; alias e2='echo'; f; echo $?");
    expect(later.out).toMatch(/command not found: e2\n127\n$/);
    // eval in the body parses then: today's aliases
    expect((await sh("g() { eval 'e3 via-eval'; }; alias e3='echo'; g")).out).toBe('via-eval\n');
  });

  it('rawCommandWord', () => {
    expect(rawCommandWord('ll -a')).toBe('ll');
    expect(rawCommandWord('A=1 B="x y" ll')).toBe('ll');
    expect(rawCommandWord('2>/dev/null >out ll')).toBe('ll');
    expect(rawCommandWord('$x')).toBeNull();
    expect(rawCommandWord('"ll"')).toBeNull();
    expect(rawCommandWord('\\ll')).toBeNull();
    expect(rawCommandWord('X=$(echo a b) ll')).toBe('ll');
  });
});

describe('hash', () => {
  it('holds commands found in PATH with their hits, not names that were not found', async () => {
    const r = await sh('ls >/dev/null; ls >/dev/null; nosuchcmd 2>/dev/null; hash');
    expect(r.out).toBe('hits\tcommand\n   2\t/usr/bin/ls\n');
  });

  it('-t prints the path; -d forgets; -r empties; a missing name is an error', async () => {
    expect((await sh('ls >/dev/null; hash -t ls')).out).toBe('/usr/bin/ls\n');
    expect((await sh('ls >/dev/null; cat </dev/null; hash -t ls cat')).out).toBe('ls\t/usr/bin/ls\ncat\t/usr/bin/cat\n');
    expect((await sh('ls >/dev/null; hash -d ls; hash -t ls; echo $?')).out).toMatch(/hash: ls: not found\n1\n$/);
    expect((await sh('ls >/dev/null; hash -r; hash')).out).toBe('hash: hash table empty\n');
    expect((await sh('hash nonexistentcmd; echo $?')).out).toMatch(/hash: nonexistentcmd: not found\n1\n$/);
  });

  it('-p pins a name to a path, which then runs; -l lists reusable lines', async () => {
    expect((await sh('hash -p /bin/echo myecho; myecho pinned; hash -t myecho')).out).toBe('pinned\n/bin/echo\n');
    expect((await sh('hash -p /bin/echo myecho; hash -l')).out).toBe('builtin hash -p /bin/echo myecho\n');
  });

  it('a new PATH empties the table', async () => {
    expect((await sh('ls >/dev/null; PATH=/usr/bin:/bin; hash')).out).toBe('hash: hash table empty\n');
  });
});

describe('command not found', () => {
  it("goes to the command's stderr, so its redirects apply", async () => {
    expect((await sh('nosuch 2>/dev/null; echo $?')).out).toBe('127\n');
    expect((await sh('nosuch 2>&1 | tr a-z A-Z')).out).toBe('TABCOMPUTER: COMMAND NOT FOUND: NOSUCH\n');
    expect((await sh('nosuch 2>/dev/null || echo fallback')).out).toBe('fallback\n');
  });

  it('the rest of the pipeline still runs', async () => {
    expect((await sh('nosuch 2>/dev/null | echo second; echo "${PIPESTATUS[@]}"')).out).toBe('second\n127 0\n');
    expect((await sh('echo hi | nosuch 2>/dev/null; echo $?')).out).toBe('127\n');
  });
});
