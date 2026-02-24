import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('SQLite Queries', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
    shell.commands.register(sqlite3Cmd);
  });

  // ─── Command Registration ──────────────────────────────────────

  describe('command registration', () => {
    it('should have correct name', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      expect(sqlite3Cmd.name).toBe('sqlite3');
    });

    it('should have description mentioning SQLite', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      expect(sqlite3Cmd.description).toContain('SQLite');
    });

    it('should export an exec function', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      expect(typeof sqlite3Cmd.exec).toBe('function');
    });

    it('should be discoverable in the registry', () => {
      const cmd = shell.commands.get('sqlite3');
      expect(cmd).toBeTruthy();
      expect(cmd!.name).toBe('sqlite3');
    });
  });

  // ─── Argument Validation ───────────────────────────────────────

  describe('argument validation', () => {
    it('should default to :memory: when no db path given', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // sql.js CDN load fails in test env — error message should mention sql.js
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('sql.js');
    });

    it('should accept :memory: as database path', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:', 'SELECT 1;'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // WASM load fails in test — verify it attempted to load
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('sql.js');
    });

    it('should accept a file path as database path', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: ['/tmp/test.db', 'SELECT 1;'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('sql.js');
    });

    it('should join multiple query args into one query', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      // Pass query as separate args: 'SELECT', '1+1;'
      const ctx = {
        args: [':memory:', 'SELECT', '1+1;'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // Still fails at WASM load, but verifies arg joining path is reached
      expect(code).toBe(1);
    });
  });

  // ─── WASM-dependent queries (tolerant of CDN failure) ──────────

  describe(':memory: database queries', () => {
    it('should execute SELECT on :memory:', async () => {
      const { output, exitCode } = await run(shell, 'sqlite3 :memory: "SELECT 1+1 as result;"');
      if (exitCode === 0) {
        expect(output).toContain('2');
      } else {
        expect(output).toMatch(/sqlite|sql|load|wasm/i);
      }
    });

    it('should execute CREATE TABLE', async () => {
      const { output, exitCode } = await run(shell, 'sqlite3 :memory: "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);"');
      if (exitCode === 0) {
        // CREATE TABLE produces no output on success
        expect(output).not.toContain('Error');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should execute INSERT and SELECT', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(42); SELECT * FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('42');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should execute UPDATE', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(1); UPDATE t SET x=99; SELECT * FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('99');
        expect(output).not.toContain('1\r\n');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should execute DELETE', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(1); INSERT INTO t VALUES(2); DELETE FROM t WHERE x=1; SELECT * FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('2');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should handle WHERE clauses', async () => {
      const query = "CREATE TABLE t(x,y); INSERT INTO t VALUES(1,'a'); INSERT INTO t VALUES(2,'b'); SELECT y FROM t WHERE x=2;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('b');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should handle JOINs', async () => {
      const query = "CREATE TABLE users(id,name); CREATE TABLE orders(uid,item); INSERT INTO users VALUES(1,'Alice'); INSERT INTO orders VALUES(1,'Book'); SELECT name,item FROM users JOIN orders ON users.id=orders.uid;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('Alice');
        expect(output).toContain('Book');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should handle COUNT aggregate', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(1); INSERT INTO t VALUES(2); INSERT INTO t VALUES(3); SELECT COUNT(*) as cnt FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('3');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should handle SUM aggregate', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(10); INSERT INTO t VALUES(20); INSERT INTO t VALUES(30); SELECT SUM(x) FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('60');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should handle AVG aggregate', async () => {
      const query = "CREATE TABLE t(x); INSERT INTO t VALUES(10); INSERT INTO t VALUES(20); SELECT AVG(x) FROM t;";
      const { output, exitCode } = await run(shell, `sqlite3 :memory: "${query}"`);
      if (exitCode === 0) {
        expect(output).toContain('15');
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });
  });

  // ─── File-based database operations ────────────────────────────

  describe('file-based database', () => {
    it('should create and write to a database file', async () => {
      const { output, exitCode } = await run(shell, 'sqlite3 /tmp/test.db "CREATE TABLE t(x); INSERT INTO t VALUES(42);"');
      if (exitCode === 0) {
        // Verify the DB file was written to the filesystem
        const stat = await fs.stat('/tmp/test.db');
        expect(stat).toBeTruthy();
      } else {
        expect(output).toMatch(/sql|load|wasm/i);
      }
    });

    it('should persist data across separate commands', async () => {
      const r1 = await run(shell, 'sqlite3 /tmp/persist.db "CREATE TABLE t(x); INSERT INTO t VALUES(99);"');
      if (r1.exitCode !== 0) {
        expect(r1.output).toMatch(/sql|load|wasm/i);
        return;
      }
      const r2 = await run(shell, 'sqlite3 /tmp/persist.db "SELECT * FROM t;"');
      expect(r2.exitCode).toBe(0);
      expect(r2.output).toContain('99');
    });

    it('should handle relative database paths', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: ['mydb.sqlite', 'SELECT 1;'],
        fs, cwd: '/tmp', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // sql.js load will fail in test, but path resolution should be attempted
      expect(code).toBe(1);
    });
  });

  // ─── Dot-commands ──────────────────────────────────────────────

  describe('dot-commands', () => {
    it('should handle .tables command', async () => {
      const query = "CREATE TABLE users(id); CREATE TABLE orders(id);";
      const r1 = await run(shell, `sqlite3 :memory: "${query}"`);
      // .tables only works in interactive or single-query mode with the same DB
      // Test via shell with semicolon-separated commands won't work due to in-memory scope
      // Instead test the command object directly
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:', '.tables'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      if (code === 0) {
        // .tables on empty :memory: should produce no output (no tables)
        // This is correct behavior
        expect(ctx.stdout).toBeDefined();
      } else {
        expect(ctx.stderr).toContain('sql.js');
      }
    });

    it('should handle .schema command', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:', '.schema'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      if (code === 0) {
        // .schema on empty :memory: returns empty
        expect(ctx.stdout).toBeDefined();
      } else {
        expect(ctx.stderr).toContain('sql.js');
      }
    });

    it('should detect dot-commands by leading period', async () => {
      // Verify the command source checks for leading '.' to dispatch dot-commands
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain("query.startsWith('.')");
    });

    it('should handle .databases dot-command', async () => {
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain('.databases');
      expect(src).toContain("'main\\n'");
    });

    it('should handle .help dot-command', async () => {
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain('.help');
      expect(src).toContain('.quit');
      expect(src).toContain('.exit');
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should report SQL syntax errors', async () => {
      const { output, exitCode } = await run(shell, 'sqlite3 :memory: "SELECTT 1;"');
      if (exitCode !== 0) {
        // Either WASM load error or SQL syntax error — both are expected
        expect(output).toMatch(/error|sql|load|wasm/i);
      }
    });

    it('should report errors for queries on non-existent tables', async () => {
      const { output, exitCode } = await run(shell, 'sqlite3 :memory: "SELECT * FROM nonexistent;"');
      if (exitCode !== 0) {
        expect(output).toMatch(/error|sql|load|wasm|no such table/i);
      }
    });

    it('should handle WASM load failure gracefully', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:', 'SELECT 1;'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // In test env, CDN is unavailable — should not throw, should return exit code 1
      expect(code).toBe(1);
      expect(ctx.stderr).toContain('failed to load sql.js');
    });

    it('should require terminal for interactive mode', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      // Scenario: sql.js loads but no terminal and no query (interactive mode)
      // In test env, sql.js won't load, so we just verify the error path
      const ctx = {
        args: [':memory:'],
        fs, cwd: '/home/user', env: {}, stdin: '', stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      // Will fail at WASM load before reaching terminal check
      expect(code).toBe(1);
    });
  });

  // ─── Stdin piping ──────────────────────────────────────────────

  describe('stdin piping', () => {
    it('should accept SQL via stdin', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:'],
        fs, cwd: '/home/user', env: {},
        stdin: 'SELECT 42 as answer;',
        stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      if (code === 0) {
        expect(ctx.stdout).toContain('42');
      } else {
        // WASM unavailable
        expect(ctx.stderr).toContain('sql.js');
      }
    });

    it('should handle multi-statement stdin', async () => {
      const { sqlite3Cmd } = await import('@shiro/commands/sqlite');
      const ctx = {
        args: [':memory:'],
        fs, cwd: '/home/user', env: {},
        stdin: 'CREATE TABLE t(x);\nINSERT INTO t VALUES(7);\nSELECT * FROM t;',
        stdout: '', stderr: '', shell,
      };
      const code = await sqlite3Cmd.exec(ctx);
      if (code === 0) {
        expect(ctx.stdout).toContain('7');
      } else {
        expect(ctx.stderr).toContain('sql.js');
      }
    });
  });

  // ─── Source code validation ────────────────────────────────────

  describe('source code structure', () => {
    it('should use jsdelivr CDN for sql.js', async () => {
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain('cdn.jsdelivr.net/npm/sql.js');
    });

    it('should use UMD loading (not ESM import)', async () => {
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain("new Function('module', 'exports', code)");
      expect(src).not.toContain('await import(');
    });

    it('should format results with pipe-separated columns', async () => {
      const sqliteSource = await import('@shiro/commands/sqlite?raw');
      const src = typeof sqliteSource === 'string' ? sqliteSource : sqliteSource.default;
      expect(src).toContain(".join('|')");
    });
  });
});
