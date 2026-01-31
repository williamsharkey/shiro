import { Command } from './index';
import { initClaudeCode, BrowserOAuth, TokenStore } from '../claude-code-loader';

/**
 * Claude Code command - Runs the real Claude Code CLI in Shiro.
 *
 * This command:
 * 1. Initializes the Claude Code environment with API proxying
 * 2. Handles OAuth login for Claude Max accounts
 * 3. Loads and runs the actual Claude Code CLI
 *
 * Usage:
 *   claude                    # Interactive mode
 *   claude login              # Login with Claude account
 *   claude logout             # Clear saved credentials
 *   claude "prompt"           # One-shot mode
 *   claude --version          # Show version info
 */

let initialized = false;

export const claudeCmd: Command = {
  name: 'claude',
  description: 'Claude Code - AI coding assistant',
  async exec(ctx) {
    const args = ctx.args;

    // Initialize on first run
    if (!initialized) {
      await initClaudeCode(ctx.shell);
      initialized = true;
    }

    // Handle login command
    if (args[0] === 'login') {
      return handleLogin(ctx);
    }

    // Handle logout command
    if (args[0] === 'logout') {
      TokenStore.clear();
      ctx.stdout = 'Logged out of Claude Code.\n';
      return 0;
    }

    // Handle version flag
    if (args[0] === '--version' || args[0] === '-v') {
      ctx.stdout = 'Claude Code (Shiro Runtime)\n';
      ctx.stdout += 'Running in browser via Shiro OS\n';

      // Try to get real version from CLI
      const cliVersion = await getCliVersion(ctx);
      if (cliVersion) {
        ctx.stdout += `CLI version: ${cliVersion}\n`;
      }
      return 0;
    }

    // Handle help flag
    if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      ctx.stdout = `
Claude Code - AI Coding Assistant (Shiro Runtime)

USAGE:
    claude [OPTIONS] [PROMPT]

COMMANDS:
    login           Login with your Claude account (for Max subscription)
    logout          Clear saved credentials
    help            Show this help message

OPTIONS:
    -h, --help      Show this help message
    -v, --version   Show version information

EXAMPLES:
    claude login                     # Login with Claude account
    claude                           # Start interactive mode
    claude "fix the bug in main.ts"  # One-shot mode with prompt

AUTHENTICATION:
    Claude Code supports two authentication methods:

    1. Claude Account (Max subscription):
       Run 'claude login' to authenticate with your Claude account.
       This uses OAuth and supports Claude Max subscriptions.

    2. API Key:
       export ANTHROPIC_API_KEY=sk-ant-your-key-here

NOTE:
    This is Claude Code running in Shiro's browser environment.
    API calls are proxied to handle CORS restrictions.

`;
      return 0;
    }

    // Check for authentication
    const tokens = TokenStore.load();
    const apiKey = ctx.env['ANTHROPIC_API_KEY'] || '';

    if (!tokens && !apiKey) {
      ctx.stdout = `
Claude Code requires authentication.

Options:
  1. Login with Claude account (supports Max subscription):
     claude login

  2. Use an API key:
     export ANTHROPIC_API_KEY=sk-ant-your-key-here

`;
      return 1;
    }

    // Set auth header if we have OAuth tokens
    if (tokens) {
      ctx.env['CLAUDE_OAUTH_TOKEN'] = tokens.accessToken;
    }

    // Run Claude Code
    return runClaudeCode(ctx, args);
  },
};

async function handleLogin(ctx: any): Promise<number> {
  const oauth = new BrowserOAuth();

  ctx.stdout = 'Opening login window...\n';
  ctx.stdout += 'Please complete authentication in the popup.\n\n';

  try {
    const tokens = await oauth.login();
    TokenStore.save(tokens);

    ctx.stdout = 'Successfully logged in to Claude Code!\n';
    ctx.stdout += 'Your session will be saved for future use.\n';
    return 0;
  } catch (e: any) {
    ctx.stderr = `Login failed: ${e.message}\n`;
    return 1;
  }
}

async function getCliVersion(ctx: any): Promise<string | null> {
  // Try to read version from installed package
  try {
    const pkgPath = '/home/user/.claude/package.json';
    const content = await ctx.fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch {
    return null;
  }
}

async function runClaudeCode(ctx: any, args: string[]): Promise<number> {
  // Check if CLI is installed
  const cliPath = '/home/user/.claude/cli.js';
  let cliExists = false;

  try {
    await ctx.fs.stat(cliPath);
    cliExists = true;
  } catch {
    cliExists = false;
  }

  if (!cliExists) {
    ctx.stdout = 'Claude Code CLI not installed.\n';
    ctx.stdout += 'Installing from npm...\n\n';

    // Download and install CLI
    const installed = await installCli(ctx);
    if (!installed) {
      ctx.stderr = 'Failed to install Claude Code CLI.\n';
      ctx.stderr += 'Try running: npm install -g @anthropic-ai/claude-code\n';
      return 1;
    }
  }

  // Run the CLI using node command
  const nodeCmd = ctx.shell.commands.get('node');
  if (!nodeCmd) {
    ctx.stderr = 'node command not available\n';
    return 1;
  }

  // Build arguments for node
  const nodeArgs = [cliPath, ...args];

  const nodeCtx = {
    ...ctx,
    args: nodeArgs,
    stdin: ctx.stdin,
    stdout: '',
    stderr: '',
  };

  try {
    const code = await nodeCmd.exec(nodeCtx);
    ctx.stdout += nodeCtx.stdout;
    ctx.stderr += nodeCtx.stderr;
    return code;
  } catch (e: any) {
    ctx.stderr = `Error running Claude Code: ${e.message}\n`;
    return 1;
  }
}

async function installCli(ctx: any): Promise<boolean> {
  try {
    // Create .claude directory
    await ctx.fs.mkdir('/home/user/.claude', { recursive: true });

    // Determine proxy URL based on environment
    const host = typeof location !== 'undefined' ? location.host : 'localhost:9999';
    const proxyBase = host.includes('shiro.computer')
      ? 'https://shiro.computer'
      : `http://${host}`;

    // Download CLI from npm registry (via proxy to avoid CORS)
    const registryUrl = `${proxyBase}/proxy/registry.npmjs.org/@anthropic-ai/claude-code/latest`;

    // Use fetch to get package info
    const response = await fetch(registryUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch package info: ${response.status}`);
    }

    const pkgInfo = await response.json();
    const originalTarballUrl = pkgInfo.dist.tarball;

    // Proxy the tarball URL too
    const tarballUrl = originalTarballUrl.replace(
      'https://registry.npmjs.org/',
      `${proxyBase}/proxy/registry.npmjs.org/`
    );

    ctx.stdout = `Downloading ${pkgInfo.version}...\n`;

    // Download tarball
    const tarballResponse = await fetch(tarballUrl);
    if (!tarballResponse.ok) {
      throw new Error(`Failed to download tarball: ${tarballResponse.status}`);
    }

    const tarballData = await tarballResponse.arrayBuffer();

    ctx.stdout = 'Extracting...\n';

    // Extract tarball (using pako for gzip, then parse tar)
    const { extractTarGz } = await import('../utils/tar-utils');
    const files = await extractTarGz(new Uint8Array(tarballData));

    // Write files to .claude directory
    for (const file of files) {
      // Remove 'package/' prefix from paths
      const relativePath = file.name.replace(/^package\//, '');
      const fullPath = `/home/user/.claude/${relativePath}`;

      if (file.type === 'directory') {
        await ctx.fs.mkdir(fullPath, { recursive: true });
      } else if (file.type === 'file' && file.data) {
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        await ctx.fs.mkdir(dir, { recursive: true });
        await ctx.fs.writeFile(fullPath, file.data);
      }
    }

    // Save package.json
    await ctx.fs.writeFile('/home/user/.claude/package.json', JSON.stringify({
      name: '@anthropic-ai/claude-code',
      version: pkgInfo.version,
      installedAt: new Date().toISOString(),
    }, null, 2));

    ctx.stdout = `Installed Claude Code ${pkgInfo.version}\n`;
    return true;
  } catch (e: any) {
    console.error('Install error:', e);
    ctx.stderr = `Install error: ${e.message}\n`;
    return false;
  }
}

/**
 * Alias: cc -> claude (common shorthand)
 */
export const ccCmd: Command = {
  name: 'cc',
  description: 'Claude Code (alias for claude)',
  exec: claudeCmd.exec,
};
