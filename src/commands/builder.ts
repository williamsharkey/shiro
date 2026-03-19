/**
 * builder - AI-powered app builder (Claude Artifacts replacement)
 *
 * Opens a split layout: terminal with Claude Code on the left,
 * live app preview on the right. Claude writes files, preview
 * auto-refreshes.
 *
 *   builder                # Start builder in /tmp/app
 *   builder /home/user/my-app  # Use specific directory
 */

import { Command, CommandContext } from './index';
import { processTable } from '../process-table';
import { createServerWindow } from '../server-window';
import { WindowTerminal } from '../window-terminal';

export const builderCmd: Command = {
  name: 'builder',
  description: 'AI app builder (chat + live preview)',
  async exec(ctx: CommandContext): Promise<number> {
    const appDir = ctx.args[0] || '/tmp/builder-app';

    // Ensure directory exists with a starter file
    try {
      await ctx.fs.mkdir(appDir, { recursive: true });
      if (!await ctx.fs.exists(`${appDir}/index.html`)) {
        await ctx.fs.writeFile(`${appDir}/index.html`, `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Builder App</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #0f0f23;
      color: #cdd6f4;
    }
    .welcome {
      text-align: center;
      padding: 2rem;
    }
    h1 { color: #89b4fa; margin-bottom: 0.5rem; }
    p { color: #a6adc8; }
  </style>
</head>
<body>
  <div class="welcome">
    <h1>Builder</h1>
    <p>Describe what you want to build in the terminal on the left.</p>
    <p>Claude will write the code and this preview will update live.</p>
  </div>
</body>
</html>`);
      }
    } catch {}

    // Start a virtual server for the app directory
    const serveCmd = ctx.shell.commands.get('serve');
    if (!serveCmd) {
      ctx.stderr = 'builder: serve command not available\n';
      return 1;
    }

    // Find a free port
    const port = 4000 + Math.floor(Math.random() * 1000);

    // Start server with split view
    await serveCmd.exec({
      ...ctx,
      args: [appDir, String(port), '--split', 'right'],
      stdout: '',
      stderr: '',
    });

    // Spawn Claude Code in a windowed terminal with builder context
    const spawnCmd = ctx.shell.commands.get('spawn');
    if (!spawnCmd) {
      ctx.stderr = 'builder: spawn command not available\n';
      return 1;
    }

    // Write builder-specific agent instructions plus a CLAUDE.md compatibility shim.
    try {
      await ctx.fs.writeFile(`${appDir}/AGENTS.md`, `# AGENTS.md

## Builder Mode

You are building a web app in this directory. The preview is live.

## Rules
- Write app files in this directory.
- The entry point is \`index.html\`.
- Keep the structure simple unless the user asks for more.
- Use vanilla HTML/CSS/JS unless the user requests a framework.
- After edits, the preview updates automatically.
`);
      await ctx.fs.writeFile(`${appDir}/CLAUDE.md`, `# CLAUDE.md

Deprecated. Read \`./AGENTS.md\`.
`);
    } catch {}

    // Build Claude command that works in the app directory
    const claudeCmd = `cd ${appDir} && which claude > /dev/null 2>&1 || npm install -g @anthropic-ai/claude-code && claude --dangerously-skip-permissions`;

    await spawnCmd.exec({
      ...ctx,
      args: [claudeCmd],
      stdout: '',
      stderr: '',
    });

    ctx.stdout = `Builder started:\n  App dir:  ${appDir}\n  Preview:  localhost:${port} (split right)\n  Claude:   spawned in windowed terminal\n\nDescribe what you want to build in the Claude window.\n`;
    return 0;
  },
};
