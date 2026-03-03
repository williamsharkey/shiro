import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

describe('npm integration', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  // ─── npm init ────────────────────────────────────────────────

  describe('npm init', () => {
    it('should create package.json with -y flag', async () => {
      await run(shell, 'mkdir -p /tmp/ni-init1');
      await run(shell, 'cd /tmp/ni-init1');
      const { exitCode } = await run(shell, 'npm init -y');
      expect(exitCode).toBe(0);

      const stat = await fs.stat('/tmp/ni-init1/package.json');
      expect(stat.isFile()).toBe(true);
    });

    it('should create valid JSON in package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-init2');
      await run(shell, 'cd /tmp/ni-init2');
      await run(shell, 'npm init -y');

      const content = await fs.readFile('/tmp/ni-init2/package.json', 'utf8') as string;
      const pkg = JSON.parse(content);
      expect(pkg).toBeDefined();
      expect(typeof pkg).toBe('object');
    });

    it('should include expected fields in package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-init3');
      await run(shell, 'cd /tmp/ni-init3');
      await run(shell, 'npm init -y');

      const content = await fs.readFile('/tmp/ni-init3/package.json', 'utf8') as string;
      const pkg = JSON.parse(content);
      expect(pkg.name).toBe('ni-init3');
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.main).toBe('index.js');
      expect(pkg.scripts).toBeDefined();
      expect(pkg.dependencies).toBeDefined();
    });
  });

  // ─── npm install ─────────────────────────────────────────────

  describe('npm install', () => {
    it('should error when no package.json exists', async () => {
      await run(shell, 'mkdir -p /tmp/ni-nopkg');
      await run(shell, 'cd /tmp/ni-nopkg');
      const { exitCode, output } = await run(shell, 'npm install');
      // Without package.json, npm should report an error
      expect(exitCode).toBe(1);
    });

    it('should report no dependencies when package.json has none', async () => {
      await run(shell, 'mkdir -p /tmp/ni-empty');
      await run(shell, 'cd /tmp/ni-empty');
      await run(shell, 'npm init -y');
      const { exitCode, output } = await run(shell, 'npm install');
      expect(exitCode).toBe(0);
      expect(output).toContain('No dependencies');
    });

    it('should attempt to install a package (network-dependent)', async () => {
      await run(shell, 'mkdir -p /tmp/ni-inst1');
      await run(shell, 'cd /tmp/ni-inst1');
      await run(shell, 'npm init -y');
      const { output, exitCode } = await run(shell, 'npm install is-number');
      // Network may not be available in test env
      if (exitCode === 0) {
        expect(output).toContain('is-number');
        // Check that node_modules was created
        const stat = await fs.stat('/tmp/ni-inst1/node_modules');
        expect(stat.isDirectory()).toBe(true);
      }
      // Don't assert on exitCode — network dependency
    });

    it('should add package to dependencies in package.json (network-dependent)', async () => {
      await run(shell, 'mkdir -p /tmp/ni-inst2');
      await run(shell, 'cd /tmp/ni-inst2');
      await run(shell, 'npm init -y');
      const { exitCode } = await run(shell, 'npm install is-number');
      if (exitCode === 0) {
        const content = await fs.readFile('/tmp/ni-inst2/package.json', 'utf8') as string;
        const pkg = JSON.parse(content);
        expect(pkg.dependencies).toBeDefined();
        expect(pkg.dependencies['is-number']).toBeDefined();
      }
    });

    it('should error for global install with no packages specified', async () => {
      const { exitCode, output } = await run(shell, 'npm install -g');
      expect(exitCode).toBe(1);
    });
  });

  // ─── npm list ────────────────────────────────────────────────

  describe('npm list', () => {
    it('should error with no package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-ls1');
      await run(shell, 'cd /tmp/ni-ls1');
      const { exitCode } = await run(shell, 'npm list');
      expect(exitCode).toBe(1);
    });

    it('should show project name after init', async () => {
      await run(shell, 'mkdir -p /tmp/ni-ls2');
      await run(shell, 'cd /tmp/ni-ls2');
      await run(shell, 'npm init -y');

      // Add a dummy dependency so npm list shows more than "No packages"
      const content = await fs.readFile('/tmp/ni-ls2/package.json', 'utf8') as string;
      const pkg = JSON.parse(content);
      pkg.dependencies = { 'fake-pkg': '1.0.0' };
      await fs.writeFile('/tmp/ni-ls2/package.json', JSON.stringify(pkg, null, 2) + '\n');

      const { output, exitCode } = await run(shell, 'npm list');
      expect(exitCode).toBe(0);
      expect(output).toContain('ni-ls2');
    });

    it('should show "No packages installed" when dependencies are empty', async () => {
      await run(shell, 'mkdir -p /tmp/ni-ls3');
      await run(shell, 'cd /tmp/ni-ls3');
      await run(shell, 'npm init -y');
      const { output, exitCode } = await run(shell, 'npm list');
      expect(exitCode).toBe(0);
      expect(output).toContain('No packages');
    });
  });

  // ─── npm uninstall ───────────────────────────────────────────

  describe('npm uninstall', () => {
    it('should remove a package from dependencies in package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-uninst1');
      await run(shell, 'cd /tmp/ni-uninst1');
      await run(shell, 'npm init -y');

      // Manually add a dependency to package.json
      const content = await fs.readFile('/tmp/ni-uninst1/package.json', 'utf8') as string;
      const pkg = JSON.parse(content);
      pkg.dependencies = { 'fake-pkg': '1.0.0' };
      await fs.writeFile('/tmp/ni-uninst1/package.json', JSON.stringify(pkg, null, 2) + '\n');

      // Create a fake node_modules entry
      await fs.mkdir('/tmp/ni-uninst1/node_modules/fake-pkg', { recursive: true });
      await fs.writeFile('/tmp/ni-uninst1/node_modules/fake-pkg/package.json', '{"name":"fake-pkg","version":"1.0.0"}');

      const { exitCode, output } = await run(shell, 'npm uninstall fake-pkg');
      expect(exitCode).toBe(0);
      expect(output).toContain('Removed fake-pkg');

      // Verify it was removed from package.json
      const updated = await fs.readFile('/tmp/ni-uninst1/package.json', 'utf8') as string;
      const updatedPkg = JSON.parse(updated);
      expect(updatedPkg.dependencies['fake-pkg']).toBeUndefined();
    });

    it('should remove node_modules directory for uninstalled package', async () => {
      await run(shell, 'mkdir -p /tmp/ni-uninst2');
      await run(shell, 'cd /tmp/ni-uninst2');
      await run(shell, 'npm init -y');

      // Add dependency and fake node_modules
      const content = await fs.readFile('/tmp/ni-uninst2/package.json', 'utf8') as string;
      const pkg = JSON.parse(content);
      pkg.dependencies = { 'test-pkg': '^1.0.0' };
      await fs.writeFile('/tmp/ni-uninst2/package.json', JSON.stringify(pkg, null, 2) + '\n');

      await fs.mkdir('/tmp/ni-uninst2/node_modules/test-pkg', { recursive: true });
      await fs.writeFile('/tmp/ni-uninst2/node_modules/test-pkg/index.js', 'module.exports = {}');

      await run(shell, 'npm uninstall test-pkg');

      // Verify node_modules/test-pkg was removed
      await expect(fs.stat('/tmp/ni-uninst2/node_modules/test-pkg')).rejects.toThrow();
    });
  });

  // ─── npm run ─────────────────────────────────────────────────

  describe('npm run', () => {
    it('should list available scripts when no script name given', async () => {
      await run(shell, 'mkdir -p /tmp/ni-run1');
      await run(shell, 'cd /tmp/ni-run1');
      await run(shell, 'npm init -y');

      const { output, exitCode } = await run(shell, 'npm run');
      expect(exitCode).toBe(0);
      // Default init creates a "test" script
      expect(output).toContain('test');
    });

    it('should execute a defined script', async () => {
      await run(shell, 'mkdir -p /tmp/ni-run2');
      await run(shell, 'cd /tmp/ni-run2');

      // Write package.json with a custom script
      const pkg = {
        name: 'ni-run2',
        version: '1.0.0',
        scripts: {
          greet: 'echo hello-from-script',
        },
        dependencies: {},
      };
      await fs.writeFile('/tmp/ni-run2/package.json', JSON.stringify(pkg, null, 2) + '\n');

      const { output, exitCode } = await run(shell, 'npm run greet');
      expect(exitCode).toBe(0);
      expect(output).toContain('hello-from-script');
    });

    it('should error for nonexistent script', async () => {
      await run(shell, 'mkdir -p /tmp/ni-run3');
      await run(shell, 'cd /tmp/ni-run3');
      await run(shell, 'npm init -y');

      const { exitCode, output } = await run(shell, 'npm run nonexistent');
      expect(exitCode).toBe(1);
    });
  });

  // ─── npm info/view ───────────────────────────────────────────

  describe('npm info/view', () => {
    it('should treat info as an unknown command', async () => {
      // Shiro npm does not implement info/view — should return error
      const { exitCode, output } = await run(shell, 'npm info lodash');
      expect(exitCode).toBe(1);
    });

    it('should treat view as an unknown command', async () => {
      const { exitCode } = await run(shell, 'npm view nonexistent-pkg-12345');
      expect(exitCode).toBe(1);
    });
  });

  // ─── Error handling ──────────────────────────────────────────

  describe('error handling', () => {
    it('should show usage when run with no subcommand', async () => {
      const { output, exitCode } = await run(shell, 'npm');
      expect(exitCode).toBe(0);
      expect(output).toContain('Usage');
      expect(output).toContain('install');
      expect(output).toContain('init');
    });

    it('should error on invalid subcommand', async () => {
      const { exitCode, output } = await run(shell, 'npm invalidcommand');
      expect(exitCode).toBe(1);
    });
  });

  // ─── npm --version ──────────────────────────────────────────

  describe('npm --version', () => {
    it('should print version string', async () => {
      const { output, exitCode } = await run(shell, 'npm --version');
      expect(exitCode).toBe(0);
      expect(output).toContain('npm');
      expect(output).toContain('shiro');
    });
  });

  // ─── npm cache ──────────────────────────────────────────────

  describe('npm cache', () => {
    it('should show cache status', async () => {
      const { output, exitCode } = await run(shell, 'npm cache status');
      expect(exitCode).toBe(0);
      expect(output).toContain('cache');
    });

    it('should clean cache', async () => {
      const { output, exitCode } = await run(shell, 'npm cache clean');
      expect(exitCode).toBe(0);
      expect(output).toContain('Cleared');
    });
  });

  // ─── npm uninstall edge cases ────────────────────────────────

  describe('npm uninstall edge cases', () => {
    it('should error when no package name is given', async () => {
      await run(shell, 'mkdir -p /tmp/ni-uninst3');
      await run(shell, 'cd /tmp/ni-uninst3');
      await run(shell, 'npm init -y');
      const { exitCode } = await run(shell, 'npm uninstall');
      expect(exitCode).toBe(1);
    });
  });

  // ─── npm start ─────────────────────────────────────────────

  describe('npm start', () => {
    it('should run the start script from package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-start1');
      await run(shell, 'cd /tmp/ni-start1');
      await fs.writeFile('/tmp/ni-start1/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: { start: 'echo hello-start' },
      }));
      const { output, exitCode } = await run(shell, 'npm start');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '')).toContain('hello-start');
      expect(output.replace(/\r/g, '')).toContain('> test-app@1.0.0 start');
    });

    it('should default to "node server.js" when no start script defined', async () => {
      await run(shell, 'mkdir -p /tmp/ni-start2');
      await run(shell, 'cd /tmp/ni-start2');
      await fs.writeFile('/tmp/ni-start2/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: {},
      }));
      const { output } = await run(shell, 'npm start');
      expect(output.replace(/\r/g, '')).toContain('> node server.js');
    });

    it('should error without package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-start3');
      await run(shell, 'cd /tmp/ni-start3');
      const { exitCode, output } = await run(shell, 'npm start');
      expect(exitCode).toBe(1);
      expect(output.replace(/\r/g, '')).toContain('package.json not found');
    });
  });

  // ─── npm test ──────────────────────────────────────────────

  describe('npm test', () => {
    it('should run the test script from package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-test1');
      await run(shell, 'cd /tmp/ni-test1');
      await fs.writeFile('/tmp/ni-test1/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: { test: 'echo running-tests' },
      }));
      const { output, exitCode } = await run(shell, 'npm test');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '')).toContain('running-tests');
    });

    it('should error when no test script defined', async () => {
      await run(shell, 'mkdir -p /tmp/ni-test2');
      await run(shell, 'cd /tmp/ni-test2');
      await fs.writeFile('/tmp/ni-test2/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: {},
      }));
      const { output, exitCode } = await run(shell, 'npm test');
      expect(exitCode).toBe(1);
      expect(output.replace(/\r/g, '')).toContain('missing script: test');
    });

    it('should work with npm t alias', async () => {
      await run(shell, 'mkdir -p /tmp/ni-test3');
      await run(shell, 'cd /tmp/ni-test3');
      await fs.writeFile('/tmp/ni-test3/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: { test: 'echo alias-works' },
      }));
      const { output, exitCode } = await run(shell, 'npm t');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '')).toContain('alias-works');
    });

    it('should work with npm tst alias', async () => {
      await run(shell, 'mkdir -p /tmp/ni-test4');
      await run(shell, 'cd /tmp/ni-test4');
      await fs.writeFile('/tmp/ni-test4/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: { test: 'echo tst-alias' },
      }));
      const { output, exitCode } = await run(shell, 'npm tst');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '')).toContain('tst-alias');
    });

    it('should error without package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-test5');
      await run(shell, 'cd /tmp/ni-test5');
      const { exitCode, output } = await run(shell, 'npm test');
      expect(exitCode).toBe(1);
      expect(output.replace(/\r/g, '')).toContain('package.json not found');
    });
  });

  // ─── npm stop ──────────────────────────────────────────────

  describe('npm stop', () => {
    it('should run the stop script from package.json', async () => {
      await run(shell, 'mkdir -p /tmp/ni-stop1');
      await run(shell, 'cd /tmp/ni-stop1');
      await fs.writeFile('/tmp/ni-stop1/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: { stop: 'echo stopping-app' },
      }));
      const { output, exitCode } = await run(shell, 'npm stop');
      expect(exitCode).toBe(0);
      expect(output.replace(/\r/g, '')).toContain('stopping-app');
    });

    it('should error when no stop script defined', async () => {
      await run(shell, 'mkdir -p /tmp/ni-stop2');
      await run(shell, 'cd /tmp/ni-stop2');
      await fs.writeFile('/tmp/ni-stop2/package.json', JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        scripts: {},
      }));
      const { output, exitCode } = await run(shell, 'npm stop');
      expect(exitCode).toBe(1);
      expect(output.replace(/\r/g, '')).toContain('missing script: stop');
    });
  });
});
