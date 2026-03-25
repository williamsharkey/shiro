import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureClaudeAuthState } from '@shiro/claude-auth';
import { preloadEnvironment } from '@shiro/node-compat/preload';
import type { CommandContext } from '@shiro/commands/index';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { createTestShell } from './helpers';

function createCtx(shell: Shell, fs: FileSystem): CommandContext {
  return {
    args: [],
    fs,
    cwd: shell.cwd,
    env: shell.env,
    stdin: '',
    stdout: '',
    stderr: '',
    shell,
  };
}

function stubClaudeAuthFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url, 'http://127.0.0.1:13000').pathname;

    if (pathname.endsWith('/api/oauth/profile')) {
      return new Response(JSON.stringify({
        account: {
          uuid: 'acct-1',
          email: 'wm@example.com',
          display_name: 'William',
          created_at: '2024-03-13T15:49:41.115124Z',
        },
        organization: {
          uuid: 'org-1',
          name: 'WM Org',
          organization_type: 'claude_max',
          has_extra_usage_enabled: true,
          billing_type: 'stripe_subscription',
          subscription_created_at: '2024-03-13T15:50:00.000000Z',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (pathname.endsWith('/api/oauth/claude_cli/roles')) {
      return new Response(JSON.stringify({
        organization_name: 'WM Org',
        organization_role: 'admin',
        workspace_role: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (pathname.endsWith('/api/oauth/claude_cli/client_data')) {
      return new Response(JSON.stringify({
        client_data: {
          coral_reef_sonnet: 'true',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: `unexpected ${pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }));
}

describe('Claude auth state sync', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
    shell.env['HOME'] = '/home/user';
    shell.cwd = '/work/demo';
    await fs.mkdir('/work/demo', { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores oauth account metadata, client data, and clears stale MCP auth cache', async () => {
    stubClaudeAuthFetch();
    await fs.mkdir('/home/user/.claude', { recursive: true });
    await fs.writeFile('/home/user/.claude/mcp-needs-auth-cache.json', JSON.stringify({
      'claude.ai Gmail': { timestamp: Date.now() },
    }));

    await ensureClaudeAuthState(fs, {
      homeDir: '/home/user',
      projectPath: '/work/demo',
      origin: 'http://127.0.0.1:13000',
      ensureBootstrap: true,
      refreshRemoteState: true,
      tokens: {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: Date.now() + 3600_000,
        scopes: [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
          'user:mcp_servers',
          'user:file_upload',
        ],
      },
    });

    const creds = JSON.parse(await fs.readFile('/home/user/.claude/.credentials.json', 'utf8') as string);
    expect(creds.claudeAiOauth).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });

    const config = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8') as string);
    expect(config.oauthAccount).toMatchObject({
      accountUuid: 'acct-1',
      emailAddress: 'wm@example.com',
      organizationUuid: 'org-1',
      organizationName: 'WM Org',
      displayName: 'William',
      organizationRole: 'admin',
      workspaceRole: null,
      hasExtraUsageEnabled: true,
      billingType: 'stripe_subscription',
      accountCreatedAt: '2024-03-13T15:49:41.115124Z',
      subscriptionCreatedAt: '2024-03-13T15:50:00.000000Z',
    });
    expect(config.clientDataCache?.data).toEqual({ coral_reef_sonnet: 'true' });
    expect(config.hasAvailableSubscription).toBe(true);

    await expect(fs.readFile('/home/user/.claude/mcp-needs-auth-cache.json', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('repairs incomplete oauth state during Claude boot from existing credentials', async () => {
    stubClaudeAuthFetch();
    await fs.mkdir('/home/user/.claude', { recursive: true });
    await fs.writeFile('/home/user/.claude/.credentials.json', JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at-2',
        refreshToken: 'rt-2',
        expiresAt: Date.now() + 86400_000,
        scopes: [
          'user:inference',
          'user:profile',
          'user:sessions:claude_code',
          'user:mcp_servers',
          'user:file_upload',
        ],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }));
    await fs.writeFile('/home/user/.claude.json', JSON.stringify({
      hasCompletedOnboarding: true,
    }));
    await fs.writeFile('/home/user/.claude/mcp-needs-auth-cache.json', JSON.stringify({
      'claude.ai Google Calendar': { timestamp: Date.now() },
    }));

    const ctx = createCtx(shell, fs);
    await preloadEnvironment(
      ctx,
      new Map(),
      new Map(),
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    );

    const config = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8') as string);
    expect(config.oauthAccount).toMatchObject({
      accountUuid: 'acct-1',
      organizationUuid: 'org-1',
      organizationRole: 'admin',
    });
    expect(config.clientDataCache?.data).toEqual({ coral_reef_sonnet: 'true' });
    await expect(fs.readFile('/home/user/.claude/mcp-needs-auth-cache.json', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
