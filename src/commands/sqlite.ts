import { Command, CommandContext } from './index';

/**
 * sqlite3: SQLite database engine via sql.js (WebAssembly)
 *
 * Downloads sql.js (~1MB WASM) on first use, caches in IndexedDB.
 * Database files persist as blobs in Shiro's virtual filesystem.
 *
 * Usage:
 *   sqlite3 :memory: "SELECT 1+1;"          # in-memory query
 *   sqlite3 test.db "CREATE TABLE t(x);"    # persistent DB
 *   sqlite3 test.db                          # interactive REPL
 *   sqlite3 test.db ".tables"               # dot-commands
 *   sqlite3 test.db < query.sql             # stdin piping
 */

const SQLJS_CDN = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist';

let SQL: any = null;
let loadPromise: Promise<any> | null = null;

async function ensureSQLjs(ctx: CommandContext): Promise<any> {
  if (SQL) return SQL;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading SQLite (sql.js)... ';

    // sql.js uses a UMD pattern: module.exports = initSqlJs
    // Provide mock CommonJS objects so the UMD export works
    let initSqlJs = (globalThis as any).initSqlJs;
    if (!initSqlJs) {
      const resp = await fetch(`${SQLJS_CDN}/sql-wasm.js`);
      if (!resp.ok) throw new Error(`Failed to download sql.js: ${resp.status}`);
      const code = await resp.text();
      const mod: any = { exports: {} };
      new Function('module', 'exports', code)(mod, mod.exports);
      initSqlJs = mod.exports.default || mod.exports;
      if (typeof initSqlJs === 'function') {
        (globalThis as any).initSqlJs = initSqlJs;
      }
    }
    if (typeof initSqlJs !== 'function') throw new Error('Failed to load initSqlJs from sql-wasm.js');

    SQL = await initSqlJs({
      locateFile: (file: string) => `${SQLJS_CDN}/${file}`,
    });

    ctx.stdout += 'done.\n';
    return SQL;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/** Load a database from Shiro FS, or create new */
async function openDB(sql: any, ctx: CommandContext, dbPath: string): Promise<any> {
  if (dbPath === ':memory:') return new sql.Database();

  const fullPath = ctx.fs.resolvePath(dbPath, ctx.cwd);
  try {
    const data = await ctx.fs.readFile(fullPath);
    if (data instanceof Uint8Array) {
      return new sql.Database(data);
    }
    // String data — encode to Uint8Array
    return new sql.Database(new TextEncoder().encode(data as string));
  } catch {
    // New database
    return new sql.Database();
  }
}

/** Save database back to Shiro FS */
async function saveDB(db: any, ctx: CommandContext, dbPath: string) {
  if (dbPath === ':memory:') return;
  const fullPath = ctx.fs.resolvePath(dbPath, ctx.cwd);
  const data = db.export();
  await ctx.fs.writeFile(fullPath, new Uint8Array(data));
}

/** Format query results as table */
function formatResults(results: any[]): string {
  if (!results || results.length === 0) return '';
  let output = '';
  for (const result of results) {
    if (result.columns && result.columns.length > 0) {
      output += result.columns.join('|') + '\n';
      for (const row of result.values) {
        output += row.map((v: any) => v === null ? 'NULL' : String(v)).join('|') + '\n';
      }
    }
  }
  return output;
}

/** Handle dot-commands (.tables, .schema, .quit, etc.) */
function handleDotCommand(db: any, cmd: string): { output: string; quit: boolean } {
  const parts = cmd.trim().split(/\s+/);
  const dotCmd = parts[0].toLowerCase();

  switch (dotCmd) {
    case '.tables': {
      const results = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      if (results.length > 0) {
        return { output: results[0].values.map((r: any) => r[0]).join('  ') + '\n', quit: false };
      }
      return { output: '', quit: false };
    }
    case '.schema': {
      const table = parts[1];
      const query = table
        ? `SELECT sql FROM sqlite_master WHERE name='${table.replace(/'/g, "''")}'`
        : "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
      const results = db.exec(query);
      if (results.length > 0) {
        return { output: results[0].values.map((r: any) => r[0] + ';').join('\n') + '\n', quit: false };
      }
      return { output: '', quit: false };
    }
    case '.databases':
      return { output: 'main\n', quit: false };
    case '.quit':
    case '.exit':
      return { output: '', quit: true };
    case '.help':
      return {
        output: '.databases  List databases\n.exit       Exit\n.help       Show this help\n.quit       Exit\n.schema     Show CREATE statements\n.tables     List tables\n',
        quit: false,
      };
    default:
      return { output: `Error: unknown command: "${dotCmd}"\n`, quit: false };
  }
}

export const sqlite3Cmd: Command = {
  name: 'sqlite3',
  description: 'SQLite database engine',
  async exec(ctx: CommandContext) {
    let sql: any;
    try {
      sql = await ensureSQLjs(ctx);
    } catch (err: any) {
      ctx.stderr = `error: failed to load sql.js: ${err.message}\n`;
      return 1;
    }

    const args = ctx.args;
    const dbPath = args[0] || ':memory:';
    const query = args.slice(1).join(' ');

    let db: any;
    try {
      db = await openDB(sql, ctx, dbPath);
    } catch (err: any) {
      ctx.stderr = `Error: unable to open database "${dbPath}": ${err.message}\n`;
      return 1;
    }

    // Handle stdin piping
    if (ctx.stdin) {
      try {
        const results = db.exec(ctx.stdin);
        ctx.stdout += formatResults(results);
        await saveDB(db, ctx, dbPath);
        db.close();
        return 0;
      } catch (err: any) {
        ctx.stderr = `Error: ${err.message}\n`;
        db.close();
        return 1;
      }
    }

    // Single query or dot-command from args
    if (query) {
      if (query.startsWith('.')) {
        const { output } = handleDotCommand(db, query);
        ctx.stdout += output;
        db.close();
        return 0;
      }
      try {
        const results = db.exec(query);
        ctx.stdout += formatResults(results);
        await saveDB(db, ctx, dbPath);
        db.close();
        return 0;
      } catch (err: any) {
        ctx.stderr = `Error: ${err.message}\n`;
        db.close();
        return 1;
      }
    }

    // Interactive REPL
    if (!ctx.terminal) {
      ctx.stderr = 'sqlite3: interactive mode requires a terminal\n';
      db.close();
      return 1;
    }

    const term = ctx.terminal;
    term.writeOutput(`SQLite (sql.js)\r\nConnected to ${dbPath}\r\nType ".help" for usage hints, ".quit" to exit.\r\n`);

    return new Promise<number>((resolve) => {
      let line = '';
      let multiline = '';
      const prompt = () => multiline ? '   ...> ' : 'sqlite> ';
      term.writeOutput(prompt());

      term.enterRawMode((key: string) => {
        if (key === '\r' || key === '\n') {
          term.writeOutput('\r\n');
          const input = (multiline + line).trim();

          // Check for dot-commands (only when not in multiline SQL)
          if (!multiline && input.startsWith('.')) {
            const { output, quit } = handleDotCommand(db, input);
            if (output) term.writeOutput(output.replace(/\n/g, '\r\n'));
            if (quit) {
              saveDB(db, ctx, dbPath).then(() => {
                db.close();
                term.exitRawMode();
                resolve(0);
              });
              return;
            }
            line = '';
            term.writeOutput(prompt());
            return;
          }

          // Accumulate multiline SQL (continue if no semicolon at end)
          if (input && !input.endsWith(';') && input.toUpperCase() !== 'BEGIN' && input.toUpperCase() !== 'END') {
            multiline = (multiline ? multiline + ' ' : '') + line;
            line = '';
            term.writeOutput(prompt());
            return;
          }

          const fullQuery = multiline ? multiline + ' ' + line : line;
          multiline = '';
          line = '';

          if (fullQuery.trim()) {
            try {
              const results = db.exec(fullQuery);
              const output = formatResults(results);
              if (output) term.writeOutput(output.replace(/\n/g, '\r\n'));
              // Auto-save after each write operation
              saveDB(db, ctx, dbPath).catch(() => {});
            } catch (err: any) {
              term.writeOutput(`Error: ${err.message}\r\n`);
            }
          }

          term.writeOutput(prompt());
        } else if (key === '\x7f' || key === '\b') {
          if (line.length > 0) {
            line = line.slice(0, -1);
            term.writeOutput('\b \b');
          }
        } else if (key === '\x03') {
          // Ctrl+C — cancel current input
          term.writeOutput('^C\r\n');
          line = '';
          multiline = '';
          term.writeOutput(prompt());
        } else if (key === '\x04') {
          // Ctrl+D — exit
          term.writeOutput('\r\n');
          saveDB(db, ctx, dbPath).then(() => {
            db.close();
            term.exitRawMode();
            resolve(0);
          });
        } else if (key.charCodeAt(0) >= 32) {
          line += key;
          term.writeOutput(key);
        }
      });
    });
  },
};
