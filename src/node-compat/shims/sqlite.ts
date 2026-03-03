/**
 * better-sqlite3 shim using sql.js (WASM-based SQLite).
 * Extracted from node-cmd.ts createBetterSqlite3Shim().
 */

import type { CommandContext } from '../../commands/index';

export interface SqliteDeps {
  ctx: CommandContext;
}

export function createSqliteShim(deps: SqliteDeps): any {
  const { ctx } = deps;

  // Cache for sql.js initialization
  let sqlJsPromise: Promise<any> | null = null;
  const sqliteDatabases = new Map<string, any>(); // path -> sql.js Database

  // Load sql.js from CDN - START LOADING IMMEDIATELY when shim is created
  async function loadSqlJs(): Promise<any> {
    if (typeof window === 'undefined') {
      throw new Error('better-sqlite3 shim requires browser environment (sql.js WASM)');
    }

    if (!sqlJsPromise) {
      sqlJsPromise = (async () => {
        try {
          const initSqlJs = (window as any).initSqlJs;
          if (initSqlJs) {
            const SQL = await initSqlJs({
              locateFile: (file: string) => `https://sql.js.org/dist/${file}`
            });
            return SQL;
          }
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://sql.js.org/dist/sql-wasm.js';
            script.onload = () => resolve();
            script.onerror = (e) => reject(e);
            document.head.appendChild(script);
          });
          const SQL = await (window as any).initSqlJs({
            locateFile: (file: string) => `https://sql.js.org/dist/${file}`
          });
          return SQL;
        } catch (err) {
          throw err;
        }
      })();
    }
    return sqlJsPromise;
  }

  // START LOADING SQL.JS IMMEDIATELY when shim is created (when require('better-sqlite3') is called)
  // This gives sql.js a head start before any Database is constructed
  const earlyLoadPromise = loadSqlJs();

  // Database class mimicking better-sqlite3
  // NOTE: Methods are async because sql.js requires async initialization
  // Code using this shim should use await with all Database methods
  class Database {
    private db: any = null;
    private dbPath: string;
    private SQL: any = null;
    private initPromise: Promise<void> | null = null;
    private _isReady = false;

    constructor(path: string, options?: any) {
      this.dbPath = ctx.fs.resolvePath(path, ctx.cwd);
      // Start initialization immediately in constructor
      // This allows sql.js loading to happen while other code runs
      this.initPromise = this._init();
    }

    private async _init(): Promise<void> {
      if (this._isReady) return;

      try {
        this.SQL = await earlyLoadPromise;

        if (sqliteDatabases.has(this.dbPath)) {
          this.db = sqliteDatabases.get(this.dbPath);
          this._isReady = true;
          return;
        }

        try {
          const data = await ctx.fs.readFile(this.dbPath);
          if (data instanceof Uint8Array) {
            this.db = new this.SQL.Database(data);
          } else {
            this.db = new this.SQL.Database();
          }
        } catch {
          this.db = new this.SQL.Database();
        }

        sqliteDatabases.set(this.dbPath, this.db);
        this._isReady = true;
      } catch (err) {
        throw err;
      }
    }

    // All methods are now async to properly await sql.js initialization
    // This is necessary because sql.js requires WASM loading which is inherently async
    async prepare(sql: string): Promise<Statement> {
      await this.ready;
      return new Statement(this.db, sql);
    }

    async exec(sql: string): Promise<this> {
      await this.ready;
      this.db.run(sql);
      await this._save();
      return this;
    }

    async pragma(pragma: string, options?: any): Promise<any> {
      await this.ready;
      const result = this.db.exec(`PRAGMA ${pragma}`);
      if (result.length === 0) return options?.simple ? undefined : [];
      if (options?.simple) {
        return result[0].values[0]?.[0];
      }
      return result[0].values.map((row: any[]) => {
        const obj: any = {};
        result[0].columns.forEach((col: string, i: number) => {
          obj[col] = row[i];
        });
        return obj;
      });
    }

    transaction<T>(fn: () => T): () => T {
      // Transaction returns a sync function, but the function itself can be async
      return () => {
        // Note: This won't work properly with async - transactions need special handling
        // For now, throw if db not ready
        if (!this._isReady) {
          throw new Error('Database must be initialized before using transactions. Call await db.ready first.');
        }
        this.db.run('BEGIN');
        try {
          const result = fn();
          this.db.run('COMMIT');
          this._save();
          return result;
        } catch (err) {
          this.db.run('ROLLBACK');
          throw err;
        }
      };
    }

    async close(): Promise<void> {
      await this._save();
      if (this.db) {
        this.db.close();
        sqliteDatabases.delete(this.dbPath);
        this.db = null;
      }
    }

    private async _save(): Promise<void> {
      if (!this.db) return;
      const data = this.db.export();
      await ctx.fs.writeFile(this.dbPath, data);
    }

    // Expose the init promise for async usage
    get ready(): Promise<void> {
      if (!this.initPromise) {
        this.initPromise = this._init();
      }
      return this.initPromise;
    }

    // For compatibility - some code checks if db is open
    get open(): boolean {
      return this._isReady && this.db !== null;
    }
  }

  // Statement class mimicking better-sqlite3
  class Statement {
    private db: any;
    private sql: string;

    constructor(db: any, sql: string) {
      this.db = db;
      this.sql = sql;
    }

    run(...params: any[]): { changes: number; lastInsertRowid: number } {
      const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
        ? params[0]  // Named parameters
        : params.flat();

      this.db.run(this.sql, flatParams);

      // Get changes and lastInsertRowid
      const changesResult = this.db.exec('SELECT changes()');
      const lastIdResult = this.db.exec('SELECT last_insert_rowid()');

      return {
        changes: changesResult[0]?.values[0]?.[0] ?? 0,
        lastInsertRowid: lastIdResult[0]?.values[0]?.[0] ?? 0,
      };
    }

    get(...params: any[]): any {
      const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
        ? params[0]
        : params.flat();

      const stmt = this.db.prepare(this.sql);
      stmt.bind(flatParams);

      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        stmt.free();

        const row: any = {};
        columns.forEach((col: string, i: number) => {
          row[col] = values[i];
        });
        return row;
      }

      stmt.free();
      return undefined;
    }

    all(...params: any[]): any[] {
      const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])
        ? params[0]
        : params.flat();

      const result = this.db.exec(this.sql, flatParams);
      if (result.length === 0) return [];

      const columns = result[0].columns;
      return result[0].values.map((row: any[]) => {
        const obj: any = {};
        columns.forEach((col: string, i: number) => {
          obj[col] = row[i];
        });
        return obj;
      });
    }

    iterate(...params: any[]): IterableIterator<any> {
      const rows = this.all(...params);
      return rows[Symbol.iterator]();
    }

    bind(...params: any[]): this {
      // For chaining - params will be used in next run/get/all
      return this;
    }
  }

  // Return with both CommonJS and ES module compatibility
  // CommonJS: const Database = require('better-sqlite3')
  // ES Module: const { default: Database } = await import('better-sqlite3')
  const module = Database as any;
  module.default = Database;
  return module;
}
