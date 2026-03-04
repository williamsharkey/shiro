/**
 * Phase 19-20: Port Detection, Polish & Performance tests
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { createFileCache } from '@shiro/node-compat/file-cache';

describe('port detection regex', () => {
  const regex = /(?:listening|running|started|ready)\s+(?:on|at)\s+(?:https?:\/\/[^:]+:|port\s*)(\d{2,5})/i;

  it('matches "listening on port 3000"', () => {
    const m = 'Server listening on port 3000'.match(regex);
    expect(m).toBeTruthy();
    expect(m![1]).toBe('3000');
  });

  it('matches "Server running at http://localhost:8080"', () => {
    const m = 'Server running at http://localhost:8080'.match(regex);
    expect(m).toBeTruthy();
    expect(m![1]).toBe('8080');
  });

  it('does not match random number strings', () => {
    const m = 'The result is 3000 items'.match(regex);
    expect(m).toBeNull();
  });

  it('matches case-insensitively', () => {
    const m = 'LISTENING ON PORT 4000'.match(regex);
    expect(m).toBeTruthy();
    expect(m![1]).toBe('4000');
  });
});

describe('npm cache clean', () => {
  it('npm cache clean --force removes node_modules', async () => {
    const { fs, shell } = await createTestShell();
    // Create node_modules with a file
    await fs.mkdir('/home/user/node_modules/test-pkg', { recursive: true });
    await fs.writeFile('/home/user/node_modules/test-pkg/index.js', new TextEncoder().encode('module.exports = 1;'));

    const { output, exitCode } = await run(shell, 'npm cache clean --force');
    expect(exitCode).toBe(0);
    expect(output).toContain('Removed node_modules/ directory');

    // Verify node_modules is gone
    let exists = true;
    try {
      await fs.readdir('/home/user/node_modules');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('npm cache clean without --force only clears metadata', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/node_modules/test-pkg', { recursive: true });
    await fs.writeFile('/home/user/node_modules/test-pkg/index.js', new TextEncoder().encode('module.exports = 1;'));

    const { output, exitCode } = await run(shell, 'npm cache clean');
    expect(exitCode).toBe(0);
    expect(output).not.toContain('Removed node_modules');

    // node_modules should still exist
    const entries = await fs.readdir('/home/user/node_modules');
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('require error messages', () => {
  it('require error for npm packages suggests npm install', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "try { require('nonexistent-pkg-xyz'); } catch(e) { console.log(e.message); }"`
    );
    expect(exitCode).toBe(0);
    expect(output).toContain('npm install nonexistent-pkg-xyz');
  });

  it('require error for relative paths does not suggest npm install', async () => {
    const { shell } = await createTestShell();
    const { output, exitCode } = await run(shell,
      `node -e "try { require('./no-such-file'); } catch(e) { console.log(e.message); }"`
    );
    expect(exitCode).toBe(0);
    expect(output).not.toContain('npm install');
  });
});

describe('getCacheStats', () => {
  it('returns correct counts', () => {
    const cache = createFileCache();
    cache.fileCache.set('/a.js', 'console.log(1)');
    cache.fileCache.set('/b.js', 'console.log(2)');
    cache.moduleCache.set('/a.js', { exports: {} });

    const stats = cache.getCacheStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.moduleCount).toBe(1);
    expect(stats.totalSizeBytes).toBe('console.log(1)'.length + 'console.log(2)'.length);
  });
});
