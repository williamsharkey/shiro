// helpers-linkedom.js -- Direct module access helpers for linkedom-based testing
// Provides the same API as helpers.js but calls VFS/Shell directly instead of page.evaluate()

/**
 * Returns an object with helper functions that directly call VFS/Shell methods.
 * This is used by the linkedom runner for fast in-process testing.
 */
export function createDirectHelpers(vfs, shell, osTarget = 'foam') {
  const helpers = {
    osTarget,

    // -- Filesystem operations --

    async writeFile(path, content) {
      await vfs.writeFile(path, content);
    },

    async readFile(path) {
      return vfs.readFile(path);
    },

    async mkdir(path) {
      await vfs.mkdir(path);
    },

    async readdir(path) {
      return vfs.readdir(path);
    },

    async stat(path) {
      return vfs.stat(path);
    },

    async exists(path) {
      return vfs.exists(path);
    },

    async unlink(path) {
      await vfs.unlink(path);
    },

    async rename(oldPath, newPath) {
      await vfs.rename(oldPath, newPath);
    },

    // -- Shell operations --

    async exec(command) {
      return shell.exec(command);
    },

    // -- Environment --

    async getCwd() {
      return vfs.cwd || '/home/user';
    },

    async getEnv(key) {
      return vfs.env?.[key];
    },

    // -- Provider (Spirit OSProvider interface) --
    // Note: Provider tests may need real browser for full testing

    async hasProvider() {
      return false; // Provider requires browser context
    },

    async providerReadFile(path) {
      return vfs.readFile(path);
    },

    async providerExec(command) {
      return shell.exec(command);
    },
  };

  return helpers;
}

// Re-export test utilities from helpers.js
export { TestResults, assert, assertEqual, assertIncludes, assertMatch, assertNotIncludes, assertThrows, assertGreater } from './helpers.js';
