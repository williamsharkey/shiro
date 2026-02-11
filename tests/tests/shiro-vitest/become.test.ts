import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { serveCmd, serversCmd, getActiveServers } from '@shiro/commands/serve';
import { becomeCmd, unbecomeCmd, getBecomeConfig, activateBecomeMode, deactivateBecomeMode } from '@shiro/commands/become';
import { iframeServer } from '@shiro/iframe-server';

// Polyfill localStorage — Node.js may have a partial one without removeItem
{
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  };
}

// Polyfill history.pushState for linkedom
if (!globalThis.history) {
  (globalThis as any).history = { pushState: () => {} };
} else if (!globalThis.history.pushState) {
  globalThis.history.pushState = () => {};
}

describe('Become / Unbecome — App Mode', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;

    // Register serve + become commands (not registered by default in test helper)
    shell.commands.register(serveCmd);
    shell.commands.register(serversCmd);
    shell.commands.register(becomeCmd);
    shell.commands.register(unbecomeCmd);

    // Clean up DOM and localStorage between tests
    localStorage.removeItem('shiro-become');
    document.body.classList.remove('become-active');
    const existing = document.getElementById('become-container');
    if (existing) existing.remove();
    // Ensure a #terminal div exists (become hides it via CSS class)
    if (!document.getElementById('terminal')) {
      const termDiv = document.createElement('div');
      termDiv.id = 'terminal';
      document.body.appendChild(termDiv);
    }
  });

  afterEach(() => {
    // Clean up any become state
    localStorage.removeItem('shiro-become');
    document.body.classList.remove('become-active');
    const container = document.getElementById('become-container');
    if (container) {
      (container as any)._navCleanup?.();
      container.remove();
    }
    // Clean up all virtual servers so they don't leak between tests
    iframeServer.cleanup();
    getActiveServers().clear();
  });

  describe('serve → become → unbecome lifecycle', () => {
    it('should serve files, become app, and unbecome back to terminal', async () => {
      // 1. Create an app directory with index.html
      await fs.mkdir('/tmp/myapp', { recursive: true });
      await fs.writeFile('/tmp/myapp/index.html',
        '<!DOCTYPE html><html><head><title>My App</title></head><body><h1>Hello from MyApp</h1></body></html>'
      );

      // 2. Serve the directory
      const serveResult = await run(shell, 'serve /tmp/myapp 4000');
      expect(serveResult.exitCode).toBe(0);
      expect(serveResult.output).toContain('Serving /tmp/myapp on port 4000');

      // 3. Become the app
      const becomeResult = await run(shell, 'become 4000 myapp');
      expect(becomeResult.exitCode).toBe(0);
      expect(becomeResult.output).toContain('Became "myapp"');

      // 4. Verify localStorage config is set
      const config = getBecomeConfig();
      expect(config).not.toBeNull();
      expect(config!.slug).toBe('myapp');
      expect(config!.port).toBe(4000);
      expect(config!.directory).toBe('/tmp/myapp');

      // 5. Verify DOM state
      expect(document.body.classList.contains('become-active')).toBe(true);
      const container = document.getElementById('become-container');
      expect(container).not.toBeNull();
      const iframe = container!.querySelector('iframe');
      expect(iframe).not.toBeNull();
      // iframe srcdoc should contain the app content (with injected scripts)
      expect(iframe!.getAttribute('srcdoc') || iframe!.srcdoc).toContain('Hello from MyApp');

      // 6. Unbecome
      const unbecomeResult = await run(shell, 'unbecome');
      expect(unbecomeResult.exitCode).toBe(0);
      expect(unbecomeResult.output).toContain('Returned to terminal');

      // 7. Verify cleanup
      expect(getBecomeConfig()).toBeNull();
      expect(document.body.classList.contains('become-active')).toBe(false);
      expect(document.getElementById('become-container')).toBeNull();
    });
  });

  describe('become command argument handling', () => {
    it('should auto-detect the only active server when no port given', async () => {
      await fs.mkdir('/tmp/solo', { recursive: true });
      await fs.writeFile('/tmp/solo/index.html', '<html><body>Solo</body></html>');
      await run(shell, 'serve /tmp/solo 5000');

      const result = await run(shell, 'become');
      expect(result.exitCode).toBe(0);

      const config = getBecomeConfig();
      expect(config).not.toBeNull();
      expect(config!.port).toBe(5000);
      // Slug derived from directory basename
      expect(config!.slug).toBe('solo');

      // Cleanup
      deactivateBecomeMode();
      await run(shell, 'serve stop 5000');
    });

    it('should error when no servers are running', async () => {
      const result = await run(shell, 'become');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('no active servers');
    });

    it('should error when multiple servers and no port specified', async () => {
      await fs.mkdir('/tmp/app1', { recursive: true });
      await fs.mkdir('/tmp/app2', { recursive: true });
      await fs.writeFile('/tmp/app1/index.html', '<html><body>App1</body></html>');
      await fs.writeFile('/tmp/app2/index.html', '<html><body>App2</body></html>');
      await run(shell, 'serve /tmp/app1 6000');
      await run(shell, 'serve /tmp/app2 6001');

      const result = await run(shell, 'become');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('multiple servers');

      await run(shell, 'serve stop 6000');
      await run(shell, 'serve stop 6001');
    });

    it('should error on invalid port', async () => {
      const result = await run(shell, 'become abc');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('invalid port');
    });

    it('should error when port has no server', async () => {
      const result = await run(shell, 'become 9999');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('no server on port 9999');
    });
  });

  describe('unbecome edge cases', () => {
    it('should error when not in app mode', async () => {
      const result = await run(shell, 'unbecome');
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('not in app mode');
    });
  });

  describe('activateBecomeMode / deactivateBecomeMode functions', () => {
    it('should set and clear DOM state correctly', async () => {
      await fs.mkdir('/tmp/functest', { recursive: true });
      await fs.writeFile('/tmp/functest/index.html',
        '<html><head></head><body><p>Function Test</p></body></html>'
      );
      await run(shell, 'serve /tmp/functest 7000');

      // Activate
      await activateBecomeMode({
        directory: '/tmp/functest',
        port: 7000,
        slug: 'functest',
        title: 'Func Test',
      });

      // Verify
      expect(document.body.classList.contains('become-active')).toBe(true);
      expect(document.getElementById('become-container')).not.toBeNull();
      expect(localStorage.getItem('shiro-become')).not.toBeNull();
      const parsed = JSON.parse(localStorage.getItem('shiro-become')!);
      expect(parsed.slug).toBe('functest');
      expect(parsed.title).toBe('Func Test');

      // Deactivate
      deactivateBecomeMode();
      expect(document.body.classList.contains('become-active')).toBe(false);
      expect(document.getElementById('become-container')).toBeNull();
      expect(localStorage.getItem('shiro-become')).toBeNull();

      await run(shell, 'serve stop 7000');
    });

    it('should show error page when server is not running', async () => {
      // Activate with a port that has no server
      await activateBecomeMode({
        directory: '/tmp/noserver',
        port: 9999,
        slug: 'noserver',
        title: 'No Server',
      });

      const container = document.getElementById('become-container');
      expect(container).not.toBeNull();
      const iframe = container!.querySelector('iframe');
      const srcdoc = iframe!.getAttribute('srcdoc') || iframe!.srcdoc || '';
      // Should contain either the app content or a fallback error
      // iframeServer returns 404 body for unknown ports
      expect(srcdoc.length).toBeGreaterThan(0);

      deactivateBecomeMode();
    });
  });

  describe('getBecomeConfig', () => {
    it('should return null when no config exists', () => {
      localStorage.removeItem('shiro-become');
      expect(getBecomeConfig()).toBeNull();
    });

    it('should return parsed config when set', () => {
      localStorage.setItem('shiro-become', JSON.stringify({
        directory: '/tmp/test',
        port: 8080,
        slug: 'test',
        title: 'Test',
      }));
      const config = getBecomeConfig();
      expect(config).not.toBeNull();
      expect(config!.slug).toBe('test');
      expect(config!.port).toBe(8080);
    });

    it('should return null for invalid JSON', () => {
      localStorage.setItem('shiro-become', 'not json');
      expect(getBecomeConfig()).toBeNull();
    });
  });

  describe('iframe content', () => {
    it('should inject iframe scripts into served HTML', async () => {
      await fs.mkdir('/tmp/scripted', { recursive: true });
      await fs.writeFile('/tmp/scripted/index.html',
        '<!DOCTYPE html><html><head><title>Scripted</title></head><body><h1>With Scripts</h1></body></html>'
      );
      await run(shell, 'serve /tmp/scripted 8000');

      await activateBecomeMode({
        directory: '/tmp/scripted',
        port: 8000,
        slug: 'scripted',
        title: 'Scripted App',
      });

      const container = document.getElementById('become-container');
      const iframe = container!.querySelector('iframe');
      const srcdoc = iframe!.getAttribute('srcdoc') || iframe!.srcdoc || '';

      // Should have the resource interceptor script injected
      expect(srcdoc).toContain('vfs-fetch');
      expect(srcdoc).toContain('virtual-navigate');
      // Should still have original content
      expect(srcdoc).toContain('With Scripts');

      deactivateBecomeMode();
      await run(shell, 'serve stop 8000');
    });
  });
});
