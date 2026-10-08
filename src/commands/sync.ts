import { Command } from './index';

/** sync(1): wait until every buffered filesystem write is committed to IndexedDB. */
export const syncCmd: Command = {
  name: 'sync',
  description: 'Commit buffered filesystem writes to storage',
  async exec(ctx) {
    try {
      await ctx.fs.sync();
      return 0;
    } catch (e: any) {
      ctx.stderr = `sync: ${e?.message || e}\n`;
      return 1;
    }
  },
};
