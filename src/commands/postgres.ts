import { Command, CommandContext } from './index';

/**
 * psql / postgres: PostgreSQL database via PGlite (WebAssembly)
 *
 * Downloads PGlite (~3.7MB gzipped) on first use, browser-cached.
 * Full PostgreSQL engine with IndexedDB persistence.
 *
 * Usage:
 *   psql "SELECT 1+1;"                         # run query
 *   psql mydb "CREATE TABLE t(id serial, name text);"  # persistent DB
 *   psql mydb "INSERT INTO t(name) VALUES ('hello');"
 *   psql mydb "SELECT * FROM t;"
 *   echo "SELECT version();" | psql             # pipe
 *   psql mydb                                   # interactive-ish (stdin)
 *   psql --list                                 # list databases
 */

const PGLITE_CDN = 'https://esm.sh/@electric-sql/pglite@0.3.15';

// Cache database instances by name
const dbCache = new Map<string, any>();
let PGliteClass: any = null;
let loadPromise: Promise<any> | null = null;

async function ensurePGlite(ctx: CommandContext): Promise<any> {
  if (PGliteClass) return PGliteClass;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading PostgreSQL (PGlite)... ';

    const mod = await import(/* @vite-ignore */ PGLITE_CDN);
    PGliteClass = mod.PGlite || mod.default?.PGlite;
    if (!PGliteClass) throw new Error('Failed to load PGlite');

    ctx.stdout += 'done.\n';
    return PGliteClass;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    PGliteClass = null;
    throw err;
  }
}

async function getDB(PG: any, name: string): Promise<any> {
  if (dbCache.has(name)) return dbCache.get(name)!;

  // Use idb:// prefix for IndexedDB persistence, or in-memory
  const dataDir = name === ':memory:' ? undefined : `idb://shiro-pg-${name}`;
  const db = new PG({ dataDir });
  await db.waitReady;
  dbCache.set(name, db);
  return db;
}

function formatResults(result: any): string {
  if (!result || !result.rows || result.rows.length === 0) {
    if (result?.affectedRows !== undefined && result.affectedRows > 0) {
      return `${result.affectedRows} row(s) affected\n`;
    }
    return '';
  }

  const rows = result.rows;
  const fields = result.fields || [];
  const columns = fields.length > 0
    ? fields.map((f: any) => f.name)
    : Object.keys(rows[0]);

  if (columns.length === 0) return '';

  // Calculate column widths
  const widths = columns.map((col: string) => col.length);
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const val = String(row[columns[i]] ?? 'NULL');
      widths[i] = Math.max(widths[i], val.length);
    }
  }

  // Header
  let out = ' ' + columns.map((col: string, i: number) => col.padEnd(widths[i])).join(' | ') + '\n';
  out += '-' + widths.map((w: number) => '-'.repeat(w)).join('-+-') + '-\n';

  // Rows
  for (const row of rows) {
    out += ' ' + columns.map((col: string, i: number) => {
      const val = String(row[col] ?? 'NULL');
      return val.padEnd(widths[i]);
    }).join(' | ') + '\n';
  }

  out += `(${rows.length} row${rows.length !== 1 ? 's' : ''})\n`;
  return out;
}

export const psqlCmd: Command = {
  name: 'psql',
  description: 'PostgreSQL database (PGlite)',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.includes('--version') || args.includes('-V')) {
      ctx.stdout = 'psql (PGlite 0.3.15) — PostgreSQL in WebAssembly\n';
      return 0;
    }

    if (args.includes('--help') || args.includes('-h')) {
      ctx.stdout = [
        'psql (Shiro) — PostgreSQL powered by PGlite',
        '',
        'Usage:',
        '  psql "SELECT 1+1;"                         Run a query (in-memory)',
        '  psql mydb "SELECT version();"              Use named database (persistent)',
        '  psql mydb "CREATE TABLE t(x int);"         Create table',
        '  echo "SELECT 42;" | psql                   Pipe SQL',
        '  psql --list                                List databases',
        '  psql --version                             Show version',
        '',
        'Databases persist in IndexedDB across page reloads.',
        '',
      ].join('\n');
      return 0;
    }

    // List databases
    if (args.includes('--list') || args.includes('-l')) {
      const dbs = Array.from(dbCache.keys());
      if (dbs.length === 0) {
        ctx.stdout = 'No databases currently open.\n';
        ctx.stdout += 'Use: psql <dbname> "SQL..." to create one.\n';
      } else {
        ctx.stdout = 'Open databases:\n';
        for (const name of dbs) {
          ctx.stdout += `  ${name}\n`;
        }
      }
      return 0;
    }

    // Parse args: psql [dbname] "SQL" or psql "SQL" or stdin
    let dbName = ':memory:';
    let sql = '';

    if (args.length >= 2) {
      // psql dbname "SQL"
      dbName = args[0];
      sql = args.slice(1).join(' ');
    } else if (args.length === 1) {
      // Could be a DB name or SQL
      if (args[0].match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|WITH|EXPLAIN|TRUNCATE|GRANT|REVOKE|SET|SHOW|COPY|VACUUM|ANALYZE)/i)) {
        sql = args[0];
      } else {
        dbName = args[0];
      }
    }

    // Read from stdin if no SQL in args
    if (!sql && ctx.stdin) {
      sql = ctx.stdin.trim();
    }

    if (!sql) {
      ctx.stderr = 'psql: no SQL provided\n';
      ctx.stderr += 'Usage: psql [dbname] "SQL statement"\n';
      return 1;
    }

    // Load PGlite
    let PG: any;
    try {
      PG = await ensurePGlite(ctx);
    } catch (err: any) {
      ctx.stderr = `psql: failed to load: ${err.message}\n`;
      return 1;
    }

    // Get or create database
    let db: any;
    try {
      db = await getDB(PG, dbName);
    } catch (err: any) {
      ctx.stderr = `psql: failed to open database "${dbName}": ${err.message}\n`;
      return 1;
    }

    // Execute SQL (support multiple statements separated by ;)
    const statements = sql.split(/;\s*/).filter(s => s.trim());
    try {
      for (const stmt of statements) {
        const result = await db.query(stmt);
        const formatted = formatResults(result);
        if (formatted) ctx.stdout += formatted;
      }
      return 0;
    } catch (err: any) {
      ctx.stderr = `ERROR: ${err.message}\n`;
      return 1;
    }
  },
};
