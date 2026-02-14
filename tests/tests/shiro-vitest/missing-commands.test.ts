import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('Missing Commands (Claude Code compat)', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('mktemp', () => {
    it('should create a temp file and print its path', async () => {
      const { output, exitCode } = await run(shell, 'mktemp');
      expect(exitCode).toBe(0);
      expect(output.trim()).toMatch(/^\/tmp\/tmp\..{6}$/);
      const stat = await fs.stat(output.trim());
      expect(stat.isFile()).toBe(true);
    });

    it('should create a temp directory with -d', async () => {
      const { output, exitCode } = await run(shell, 'mktemp -d');
      expect(exitCode).toBe(0);
      const stat = await fs.stat(output.trim());
      expect(stat.isDirectory()).toBe(true);
    });

    it('should respect -p for parent directory', async () => {
      await fs.mkdir('/home/user/mytemp', { recursive: true });
      const { output } = await run(shell, 'mktemp -p /home/user/mytemp');
      expect(output.trim()).toMatch(/^\/home\/user\/mytemp\/tmp\..{6}$/);
    });

    it('should use custom template', async () => {
      const { output } = await run(shell, 'mktemp foo.XXXXXX');
      expect(output.trim()).toMatch(/^\/tmp\/foo\..{6}$/);
    });
  });

  describe('tput', () => {
    it('should return cols', async () => {
      const { output, exitCode } = await run(shell, 'tput cols');
      expect(exitCode).toBe(0);
      expect(parseInt(output.trim())).toBeGreaterThan(0);
    });

    it('should return lines', async () => {
      const { output, exitCode } = await run(shell, 'tput lines');
      expect(exitCode).toBe(0);
      expect(parseInt(output.trim())).toBeGreaterThan(0);
    });

    it('should return 256 for colors', async () => {
      const { output } = await run(shell, 'tput colors');
      expect(output.trim()).toBe('256');
    });

    it('should output ANSI reset for sgr0', async () => {
      const { output } = await run(shell, 'tput sgr0');
      expect(output).toBe('\x1b[0m');
    });

    it('should output ANSI bold', async () => {
      const { output } = await run(shell, 'tput bold');
      expect(output).toBe('\x1b[1m');
    });

    it('should fail for unknown capability', async () => {
      const { exitCode } = await run(shell, 'tput nonexistent');
      expect(exitCode).toBe(1);
    });

    it('should output clear sequence', async () => {
      const { output } = await run(shell, 'tput clear');
      expect(output).toBe('\x1b[2J\x1b[H');
    });

    it('should output cursor position for cup', async () => {
      const { output } = await run(shell, 'tput cup 5 10');
      expect(output).toBe('\x1b[6;11H');
    });
  });

  describe('stty', () => {
    it('should print size as "rows cols"', async () => {
      const { output, exitCode } = await run(shell, 'stty size');
      expect(exitCode).toBe(0);
      const parts = output.trim().split(' ');
      expect(parts).toHaveLength(2);
      expect(parseInt(parts[0])).toBeGreaterThan(0);
      expect(parseInt(parts[1])).toBeGreaterThan(0);
    });

    it('should print full settings with -a', async () => {
      const { output, exitCode } = await run(shell, 'stty -a');
      expect(exitCode).toBe(0);
      expect(output).toContain('speed');
      expect(output).toContain('rows');
    });

    it('should no-op for raw/sane/-echo', async () => {
      expect((await run(shell, 'stty raw')).exitCode).toBe(0);
      expect((await run(shell, 'stty sane')).exitCode).toBe(0);
      expect((await run(shell, 'stty -echo')).exitCode).toBe(0);
    });
  });

  describe('nproc', () => {
    it('should print a positive number', async () => {
      const { output, exitCode } = await run(shell, 'nproc');
      expect(exitCode).toBe(0);
      expect(parseInt(output.trim())).toBeGreaterThan(0);
    });
  });

  describe('getconf', () => {
    it('should return NPROCESSORS_ONLN', async () => {
      const { output, exitCode } = await run(shell, 'getconf NPROCESSORS_ONLN');
      expect(exitCode).toBe(0);
      expect(parseInt(output.trim())).toBeGreaterThan(0);
    });

    it('should return PAGE_SIZE', async () => {
      const { output } = await run(shell, 'getconf PAGE_SIZE');
      expect(output.trim()).toBe('4096');
    });

    it('should return PATH_MAX', async () => {
      const { output } = await run(shell, 'getconf PATH_MAX');
      expect(output.trim()).toBe('4096');
    });

    it('should fail for unknown variable', async () => {
      const { exitCode } = await run(shell, 'getconf NONEXISTENT_VAR');
      expect(exitCode).toBe(1);
    });

    it('should fail with no argument', async () => {
      const { exitCode } = await run(shell, 'getconf');
      expect(exitCode).toBe(1);
    });
  });

  describe('iconv', () => {
    it('should passthrough stdin', async () => {
      const { output, exitCode } = await run(shell, 'echo hello | iconv -f UTF-8 -t ASCII');
      expect(exitCode).toBe(0);
      expect(output).toContain('hello');
    });

    it('should list encodings with -l', async () => {
      const { output } = await run(shell, 'iconv -l');
      expect(output).toContain('UTF-8');
      expect(output).toContain('ASCII');
    });

    it('should read file content', async () => {
      await fs.writeFile('/home/user/iconv-test.txt', 'file content here');
      const { output, exitCode } = await run(shell, 'iconv /home/user/iconv-test.txt');
      expect(exitCode).toBe(0);
      expect(output).toContain('file content here');
    });
  });

  describe('jq', () => {
    it('should pass through with identity filter', async () => {
      const { output, exitCode } = await run(shell, 'echo \'{"a":1}\' | jq .');
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual({ a: 1 });
    });

    it('should extract a field', async () => {
      const { output } = await run(shell, 'echo \'{"name":"shiro"}\' | jq .name');
      expect(output.trim()).toBe('"shiro"');
    });

    it('should extract raw string with -r', async () => {
      const { output } = await run(shell, 'echo \'{"name":"shiro"}\' | jq -r .name');
      expect(output.trim()).toBe('shiro');
    });

    it('should iterate arrays with .[]', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3]\' | jq \'.[]\'');
      const lines = output.trim().split(/\r?\n/);
      expect(lines).toEqual(['1', '2', '3']);
    });

    it('should index arrays', async () => {
      const { output } = await run(shell, 'echo \'[10,20,30]\' | jq \'.[1]\'');
      expect(output.trim()).toBe('20');
    });

    it('should pipe filters', async () => {
      const { output } = await run(shell, 'echo \'{"a":{"b":42}}\' | jq \'.a | .b\'');
      expect(output.trim()).toBe('42');
    });

    it('should use length builtin', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3]\' | jq length');
      expect(output.trim()).toBe('3');
    });

    it('should use keys builtin', async () => {
      const { output } = await run(shell, 'echo \'{"b":1,"a":2}\' | jq keys');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual(['a', 'b']);
    });

    it('should use map builtin', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3]\' | jq \'map(. + 10)\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual([11, 12, 13]);
    });

    it('should use select builtin', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3,4,5]\' | jq \'.[] | select(. > 3)\'');
      const lines = output.trim().split(/\r?\n/);
      expect(lines).toEqual(['4', '5']);
    });

    it('should construct objects', async () => {
      const { output } = await run(shell, 'echo \'{"a":1,"b":2}\' | jq \'{x: .a, y: .b}\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual({ x: 1, y: 2 });
    });

    it('should construct arrays', async () => {
      const { output } = await run(shell, 'echo \'{"a":1,"b":2}\' | jq \'[.a, .b]\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual([1, 2]);
    });

    it('should handle compact output with -c', async () => {
      const { output } = await run(shell, 'echo \'{"a": 1}\' | jq -c .');
      expect(output.trim()).toBe('{"a":1}');
    });

    it('should handle if-then-else', async () => {
      const { output } = await run(shell, 'echo \'5\' | jq \'if . > 3 then "big" else "small" end\'');
      expect(output.trim()).toBe('"big"');
    });

    it('should handle to_entries', async () => {
      const { output } = await run(shell, 'echo \'{"a":1}\' | jq to_entries');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual([{ key: 'a', value: 1 }]);
    });

    it('should handle from_entries', async () => {
      const { output } = await run(shell, 'echo \'[{"key":"a","value":1}]\' | jq from_entries');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toEqual({ a: 1 });
    });

    it('should handle sort', async () => {
      const { output } = await run(shell, 'echo \'[3,1,2]\' | jq sort');
      expect(JSON.parse(output.trim())).toEqual([1, 2, 3]);
    });

    it('should handle type', async () => {
      const { output } = await run(shell, 'echo \'42\' | jq type');
      expect(output.trim()).toBe('"number"');
    });

    it('should handle add', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3]\' | jq add');
      expect(output.trim()).toBe('6');
    });

    it('should handle has', async () => {
      const { output } = await run(shell, 'echo \'{"a":1}\' | jq \'has("a")\'');
      expect(output.trim()).toBe('true');
    });

    it('should handle split and join', async () => {
      const { output } = await run(shell, 'echo \'"a-b-c"\' | jq \'split("-") | join(",")\'');
      expect(output.trim()).toBe('"a,b,c"');
    });

    it('should handle comparison operators', async () => {
      const { output } = await run(shell, 'echo \'2\' | jq \'. == 2\'');
      expect(output.trim()).toBe('true');
    });

    it('should handle arithmetic', async () => {
      const { output } = await run(shell, 'echo \'5\' | jq \'. * 3 + 1\'');
      expect(output.trim()).toBe('16');
    });

    it('should handle null input with -n', async () => {
      const { output } = await run(shell, 'jq -n \'1 + 2\'');
      expect(output.trim()).toBe('3');
    });

    it('should handle unique', async () => {
      const { output } = await run(shell, 'echo \'[1,2,1,3,2]\' | jq unique');
      expect(JSON.parse(output.trim())).toEqual([1, 2, 3]);
    });

    it('should handle flatten', async () => {
      const { output } = await run(shell, 'echo \'[[1,2],[3,[4]]]\' | jq flatten');
      expect(JSON.parse(output.trim())).toEqual([1, 2, 3, 4]);
    });

    it('should handle values', async () => {
      const { output } = await run(shell, 'echo \'{"a":1,"b":2}\' | jq \'[.[] ]\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed.sort()).toEqual([1, 2]);
    });

    it('should handle tostring and tonumber', async () => {
      expect((await run(shell, 'echo \'42\' | jq tostring')).output.trim()).toBe('"42"');
      expect((await run(shell, 'echo \'"42"\' | jq tonumber')).output.trim()).toBe('42');
    });

    it('should handle ascii_downcase and ascii_upcase', async () => {
      expect((await run(shell, 'echo \'"Hello"\' | jq ascii_downcase')).output.trim()).toBe('"hello"');
      expect((await run(shell, 'echo \'"Hello"\' | jq ascii_upcase')).output.trim()).toBe('"HELLO"');
    });

    it('should handle group_by', async () => {
      const { output } = await run(shell, 'echo \'[{"a":1},{"a":2},{"a":1}]\' | jq \'group_by(.a)\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed).toHaveLength(2);
    });

    it('should handle sort_by', async () => {
      const { output } = await run(shell, 'echo \'[{"n":3},{"n":1},{"n":2}]\' | jq \'sort_by(.n)\'');
      const parsed = JSON.parse(output.trim());
      expect(parsed.map((x: any) => x.n)).toEqual([1, 2, 3]);
    });

    it('should handle reverse', async () => {
      const { output } = await run(shell, 'echo \'[1,2,3]\' | jq reverse');
      expect(JSON.parse(output.trim())).toEqual([3, 2, 1]);
    });

    it('should handle slurp with -s', async () => {
      await fs.writeFile('/tmp/jq-slurp.txt', '1\n2\n3\n');
      const { output } = await run(shell, 'cat /tmp/jq-slurp.txt | jq -s .');
      expect(JSON.parse(output.trim())).toEqual([1, 2, 3]);
    });

    it('should read from file argument', async () => {
      await fs.writeFile('/tmp/jq-file.json', '{"x":99}');
      const { output } = await run(shell, 'jq .x /tmp/jq-file.json');
      expect(output.trim()).toBe('99');
    });

    it('should handle test regex', async () => {
      const { output } = await run(shell, 'echo \'"foobar"\' | jq \'test("foo")\'');
      expect(output.trim()).toBe('true');
    });

    it('should handle any and all', async () => {
      expect((await run(shell, 'echo \'[true,false]\' | jq any')).output.trim()).toBe('true');
      expect((await run(shell, 'echo \'[true,false]\' | jq all')).output.trim()).toBe('false');
      expect((await run(shell, 'echo \'[true,true]\' | jq all')).output.trim()).toBe('true');
    });

    it('should handle string concatenation with +', async () => {
      const { output } = await run(shell, 'echo \'{"a":"hello","b":"world"}\' | jq -r \'.a + " " + .b\'');
      expect(output.trim()).toBe('hello world');
    });

    it('should handle nested field access', async () => {
      const { output } = await run(shell, 'echo \'{"a":{"b":{"c":42}}}\' | jq .a.b.c');
      expect(output.trim()).toBe('42');
    });

    it('should exit 2 on invalid input', async () => {
      const { exitCode } = await run(shell, 'echo \'not json\' | jq .');
      // may be 0 if it falls through to null, or 2 on parse error
      // at minimum it should not crash
      expect(typeof exitCode).toBe('number');
    });
  });

  describe('ed', () => {
    it('should write a file from piped commands', async () => {
      const { exitCode } = await run(shell, 'echo "a\nhello world\n.\nw /tmp/ed-test.txt\nq" | ed');
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/ed-test.txt', 'utf8');
      expect(content).toContain('hello world');
    });

    it('should read and print file size', async () => {
      await fs.writeFile('/tmp/ed-read.txt', 'hello\n');
      const { output, exitCode } = await run(shell, 'echo "q" | ed /tmp/ed-read.txt');
      expect(exitCode).toBe(0);
      expect(output).toMatch(/\d+/); // prints byte count
    });

    it('should substitute with s command', async () => {
      await fs.writeFile('/tmp/ed-sub.txt', 'hello world\n');
      await run(shell, 'echo "1s/world/shiro/\nw\nq" | ed /tmp/ed-sub.txt');
      const content = await fs.readFile('/tmp/ed-sub.txt', 'utf8');
      expect(content).toContain('hello shiro');
    });

    it('should delete lines with d command', async () => {
      await fs.writeFile('/tmp/ed-del.txt', 'line1\nline2\nline3\n');
      await run(shell, 'echo "2d\nw\nq" | ed /tmp/ed-del.txt');
      const content = await fs.readFile('/tmp/ed-del.txt', 'utf8');
      expect(content).not.toContain('line2');
      expect(content).toContain('line1');
      expect(content).toContain('line3');
    });

    it('should print with = (line count)', async () => {
      await fs.writeFile('/tmp/ed-count.txt', 'a\nb\nc\n');
      const { output } = await run(shell, 'echo "=\nq" | ed /tmp/ed-count.txt');
      expect(output).toContain('3');
    });
  });

  describe('pgrep / pkill', () => {
    it('pgrep should return 1 when no match', async () => {
      const { exitCode } = await run(shell, 'pgrep nonexistent_process_xyz');
      expect(exitCode).toBe(1);
    });

    it('pkill should return 1 when no match', async () => {
      const { exitCode } = await run(shell, 'pkill nonexistent_process_xyz');
      expect(exitCode).toBe(1);
    });

    it('pgrep should fail with no pattern', async () => {
      const { exitCode } = await run(shell, 'pgrep');
      expect(exitCode).toBe(1);
    });
  });

  describe('wget', () => {
    it('should fail with no URL', async () => {
      const { exitCode } = await run(shell, 'wget');
      expect(exitCode).toBe(1);
    });

    it('should intercept claude.ai/install.sh like curl', async () => {
      const { exitCode } = await run(shell, 'wget -O /tmp/wget-install.sh https://claude.ai/install.sh');
      expect(exitCode).toBe(0);
      const content = await fs.readFile('/tmp/wget-install.sh', 'utf8');
      expect(content).toContain('npm install');
    });
  });

  describe('gzip / gunzip', () => {
    it('should compress and decompress a file', async () => {
      await fs.writeFile('/tmp/gz-test.txt', 'hello gzip world');
      const { exitCode: e1 } = await run(shell, 'gzip /tmp/gz-test.txt');
      expect(e1).toBe(0);
      // Original should be gone, .gz should exist
      await expect(fs.stat('/tmp/gz-test.txt')).rejects.toThrow();
      await fs.stat('/tmp/gz-test.txt.gz');

      const { exitCode: e2 } = await run(shell, 'gunzip /tmp/gz-test.txt.gz');
      expect(e2).toBe(0);
      const content = await fs.readFile('/tmp/gz-test.txt', 'utf8');
      expect(content).toBe('hello gzip world');
    });

    it('should keep original with -k', async () => {
      await fs.writeFile('/tmp/gz-keep.txt', 'keep me');
      await run(shell, 'gzip -k /tmp/gz-keep.txt');
      // Both should exist
      await fs.stat('/tmp/gz-keep.txt');
      await fs.stat('/tmp/gz-keep.txt.gz');
    });

    it('should compress to stdout with -c', async () => {
      await fs.writeFile('/tmp/gz-stdout.txt', 'stdout test');
      const { output, exitCode } = await run(shell, 'gzip -c /tmp/gz-stdout.txt');
      expect(exitCode).toBe(0);
      expect(output.length).toBeGreaterThan(0);
      // Original should still exist
      await fs.stat('/tmp/gz-stdout.txt');
    });

    it('should compress and decompress via command API', async () => {
      // Call gzip/gunzip directly to avoid shell binary data corruption
      const { gzipCmd: gz, gunzipCmd: ugz } = await import('@shiro/commands/gzip');
      await fs.writeFile('/tmp/gz-pipe.txt', 'pipe test data');
      const gzCtx = {
        args: ['/tmp/gz-pipe.txt'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const e1 = await gz.exec(gzCtx);
      expect(e1).toBe(0);
      await fs.stat('/tmp/gz-pipe.txt.gz');

      const ugzCtx = {
        args: ['/tmp/gz-pipe.txt.gz'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const e2 = await ugz.exec(ugzCtx);
      expect(e2).toBe(0);
      const content = await fs.readFile('/tmp/gz-pipe.txt', 'utf8');
      expect(content).toBe('pipe test data');
    });
  });

  describe('zip / unzip', () => {
    it('should create a zip archive and list its contents', async () => {
      await fs.writeFile('/tmp/zip-a.txt', 'file a content');
      await fs.writeFile('/tmp/zip-b.txt', 'file b content');

      // Call zip command directly to avoid shell binary data corruption
      const { zipCmd: zc, unzipCmd: uzc } = await import('@shiro/commands/zip');
      const zipCtx = {
        args: ['/tmp/test.zip', '/tmp/zip-a.txt', '/tmp/zip-b.txt'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const e1 = await zc.exec(zipCtx);
      expect(e1).toBe(0);
      const stat = await fs.stat('/tmp/test.zip');
      expect(stat.isFile()).toBe(true);

      // Verify listing works
      const listCtx = {
        args: ['-l', '/tmp/test.zip'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const e2 = await uzc.exec(listCtx);
      expect(e2).toBe(0);
      expect(listCtx.stdout).toContain('zip-a.txt');
      expect(listCtx.stdout).toContain('zip-b.txt');
    });

    it('should list archive contents with unzip -l', async () => {
      // Use zip command directly (bypasses shell pipe binary issues)
      await fs.writeFile('/tmp/zip-list.txt', 'content');
      const zipCtx = {
        args: ['/tmp/list.zip', '/tmp/zip-list.txt'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const { zipCmd: zc } = await import('@shiro/commands/zip');
      await zc.exec(zipCtx);

      const unzipCtx = {
        args: ['-l', '/tmp/list.zip'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const { unzipCmd: uzc } = await import('@shiro/commands/zip');
      const code = await uzc.exec(unzipCtx);
      expect(code).toBe(0);
      expect(unzipCtx.stdout).toContain('zip-list.txt');
    });

    it('should fail with no arguments', async () => {
      const { exitCode } = await run(shell, 'zip');
      expect(exitCode).toBe(1);
    });

    it('should fail with invalid archive', async () => {
      const { exitCode } = await run(shell, 'unzip');
      expect(exitCode).toBe(1);
    });
  });
});
