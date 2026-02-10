// become.ts - App mode: make Shiro "become" a served app full-screen
// Usage: become [port] [slug]   — activate app mode
//        unbecome               — return to terminal

import { Command, CommandContext } from './index';
import { getActiveServers, injectIframeScripts } from './serve';
import { iframeServer } from '../iframe-server';

const STORAGE_KEY = 'shiro-become';

export interface BecomeConfig {
  directory: string;
  port: number;
  slug: string;
  title: string;
}

/** Read become config from localStorage (synchronous) */
export function getBecomeConfig(): BecomeConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Activate become mode: hide terminal, show full-screen app iframe */
export async function activateBecomeMode(config: BecomeConfig): Promise<void> {
  // Save config
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));

  // Add class to body to hide terminal/vkeys via CSS
  document.body.classList.add('become-active');

  // Create full-screen container
  let container = document.getElementById('become-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'become-container';
    document.body.appendChild(container);
  }

  // Create iframe
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none';
  container.innerHTML = '';
  container.appendChild(iframe);

  // Fetch content from the virtual server
  try {
    const response = await iframeServer.fetch(config.port, '/');
    let html: string;
    if (typeof response.body === 'string') {
      html = response.body;
    } else if (response.body instanceof Uint8Array) {
      html = new TextDecoder().decode(response.body);
    } else {
      html = '<!DOCTYPE html><html><body></body></html>';
    }
    html = injectIframeScripts(html, config.port);
    iframe.srcdoc = html;
  } catch (err) {
    iframe.srcdoc = `<html><body style="color:#fff;background:#1a1a2e;font-family:monospace;padding:2em">
      <h2>Failed to load app</h2>
      <p>${err instanceof Error ? err.message : 'Unknown error'}</p>
      <p>Run <code>__shiro.unbecome()</code> in browser console to return to terminal.</p>
    </body></html>`;
  }

  // Set up navigation message handler
  const navHandler = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.type === 'virtual-navigate' && event.data?.port === config.port) {
      const newPath = event.data.path;
      try {
        const navResponse = await iframeServer.fetch(config.port, newPath);
        let navHtml = typeof navResponse.body === 'string'
          ? navResponse.body
          : navResponse.body instanceof Uint8Array
            ? new TextDecoder().decode(navResponse.body)
            : '';
        navHtml = injectIframeScripts(navHtml, config.port);
        iframe.srcdoc = navHtml;
      } catch {}
    }

    // Handle vfs-fetch requests from iframe
    if (event.source === iframe.contentWindow && event.data?.type === 'vfs-fetch') {
      const { id, port: fetchPort, url, method } = event.data;
      try {
        const resp = await iframeServer.fetch(fetchPort || config.port, url, { method: method || 'GET' });
        let body = '';
        if (typeof resp.body === 'string') body = resp.body;
        else if (resp.body instanceof Uint8Array) body = new TextDecoder().decode(resp.body);
        iframe.contentWindow?.postMessage({
          type: 'vfs-resource-response',
          id,
          status: resp.status || 200,
          headers: resp.headers || {},
          body,
        }, '*');
      } catch {
        iframe.contentWindow?.postMessage({
          type: 'vfs-resource-response',
          id,
          status: 500,
          body: '',
        }, '*');
      }
    }
  };
  window.addEventListener('message', navHandler);
  (container as any)._navCleanup = () => window.removeEventListener('message', navHandler);

  // Update URL and title
  history.pushState({}, '', '/' + config.slug);
  document.title = config.title || config.slug;
}

/** Deactivate become mode: return to terminal */
export function deactivateBecomeMode(): void {
  // Remove container
  const container = document.getElementById('become-container');
  if (container) {
    (container as any)._navCleanup?.();
    container.remove();
  }

  // Clear config
  localStorage.removeItem(STORAGE_KEY);

  // Show terminal/vkeys
  document.body.classList.remove('become-active');

  // Reset URL and title
  history.pushState({}, '', '/');
  document.title = 'shiro';

  // Focus terminal
  const shiro = (window as any).__shiro;
  if (shiro?.terminal?.term) {
    shiro.terminal.term.focus();
  }
}

export const becomeCmd: Command = {
  name: 'become',
  description: 'Enter app mode — full-screen served app',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    const servers = getActiveServers();

    let port: number;
    let slug: string | undefined;

    if (args.length === 0) {
      // No args: use the only active server
      if (servers.size === 0) {
        ctx.stderr = 'become: no active servers. Run "serve <dir> <port>" first.\n';
        return 1;
      }
      if (servers.size > 1) {
        ctx.stderr = 'become: multiple servers running. Specify port: become <port> [slug]\n';
        for (const [p, info] of servers) {
          ctx.stderr += `  :${p} ${info.directory || ''}\n`;
        }
        return 1;
      }
      port = servers.keys().next().value!;
    } else {
      port = parseInt(args[0]);
      if (isNaN(port)) {
        ctx.stderr = `become: invalid port: ${args[0]}\n`;
        return 1;
      }
      slug = args[1];
    }

    if (!iframeServer.isPortInUse(port)) {
      ctx.stderr = `become: no server on port ${port}\n`;
      return 1;
    }

    const serverInfo = servers.get(port);
    const directory = serverInfo?.directory || '/tmp';

    // Derive slug from directory basename if not provided
    if (!slug) {
      slug = directory.split('/').filter(Boolean).pop() || 'app';
    }

    const config: BecomeConfig = {
      directory,
      port,
      slug,
      title: slug.charAt(0).toUpperCase() + slug.slice(1),
    };

    await activateBecomeMode(config);
    ctx.stdout = `Became "${config.slug}" — full-screen app mode\n`;
    ctx.stdout += `Run __shiro.unbecome() in browser console to return.\n`;
    return 0;
  },
};

export const unbecomeCmd: Command = {
  name: 'unbecome',
  description: 'Exit app mode — return to terminal',
  async exec(ctx: CommandContext): Promise<number> {
    if (!getBecomeConfig()) {
      ctx.stderr = 'unbecome: not in app mode\n';
      return 1;
    }
    deactivateBecomeMode();
    ctx.stdout = 'Returned to terminal\n';
    return 0;
  },
};
