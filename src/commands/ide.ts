// ide.ts — IDE command: launches a full visual development environment
// Uses CodeMirror 6 (loaded from esm.sh CDN) in a become-mode iframe

import { Command, CommandContext } from './index';
import { createRouter, iframeServer } from '../iframe-server';
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import { activateBecomeMode } from './become';
import { generateIdeHtml } from '../ide/ide-html';

export const IDE_PORT = 4000;

// Scaffold templates
const SCAFFOLD_TEMPLATES: Record<string, Record<string, string>> = {
  static: {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello World</h1>
  <script src="app.js"></script>
</body>
</html>`,
    'style.css': `body {
  font-family: -apple-system, sans-serif;
  max-width: 800px;
  margin: 0 auto;
  padding: 2em;
  background: #111;
  color: #eee;
}

h1 { color: #6c63ff; }`,
    'app.js': `console.log('Hello from app.js');`,
  },

  express: {
    'index.js': `const express = require('express');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Hello from Express!' });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on port ' + PORT));`,
    'package.json': `{
  "name": "express-app",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}`,
  },

  mcp: {
    'index.js': `const { Server } = require('@anthropic-ai/mcp');

const server = new Server({
  name: 'my-mcp-server',
  version: '1.0.0',
});

server.tool('hello', { name: { type: 'string' } }, async ({ name }) => {
  return { content: [{ type: 'text', text: 'Hello, ' + name + '!' }] };
});

server.listen();`,
    'package.json': `{
  "name": "mcp-server",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@anthropic-ai/mcp": "^1.0.0"
  }
}`,
  },

  cli: {
    'cli.js': `#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'greet':
    console.log('Hello, ' + (args[1] || 'world') + '!');
    break;
  case 'help':
  default:
    console.log('Usage: mycli <command>');
    console.log('  greet [name]  Say hello');
    console.log('  help          Show this help');
    break;
}`,
    'package.json': `{
  "name": "my-cli",
  "version": "1.0.0",
  "bin": { "mycli": "cli.js" },
  "scripts": {
    "start": "node cli.js"
  }
}`,
  },

  command: {
    'mycommand.ts': `import { Command } from './index';

export const myCommand: Command = {
  name: 'mycommand',
  description: 'My custom Shiro command',
  async exec(ctx) {
    const args = ctx.args;
    if (args.length === 0) {
      ctx.stdout = 'Usage: mycommand <text>\\n';
      return 1;
    }
    ctx.stdout = 'You said: ' + args.join(' ') + '\\n';
    return 0;
  },
};`,
  },
};

/** Create the IDE API router (exported for testing without DOM/become) */
export function createIdeRouter(fs: FileSystem, shell: Shell, projectDir: string) {
  const router = createRouter();

  function parseBody(req: { body?: string | null }): any {
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch {
      return {};
    }
  }

  const JSON_HDR = { 'Content-Type': 'application/json' };

  // ── FS routes ──
  router.post('/api/fs/read', async (req) => {
    const { path } = parseBody(req);
    try {
      const content = await fs.readFile(path, 'utf8');
      return { status: 200, body: JSON.stringify({ content }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 404, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/write', async (req) => {
    const { path, content } = parseBody(req);
    try {
      await fs.writeFile(path, content);
      return { status: 200, body: JSON.stringify({ ok: true }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/readdir', async (req) => {
    const { path } = parseBody(req);
    try {
      const names = await fs.readdir(path);
      const entries = [];
      for (const name of names) {
        try {
          const s = await fs.stat(path + '/' + name);
          entries.push({ name, type: s?.type || 'file', size: s?.size || 0, mtime: s?.mtime || 0 });
        } catch {
          entries.push({ name, type: 'file', size: 0, mtime: 0 });
        }
      }
      return { status: 200, body: JSON.stringify({ entries }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/stat', async (req) => {
    const { path } = parseBody(req);
    try {
      const s = await fs.stat(path);
      if (!s) return { status: 404, body: JSON.stringify({ error: 'Not found' }), headers: JSON_HDR };
      return { status: 200, body: JSON.stringify({ type: s.type, size: s.size, mtime: s.mtime }), headers: JSON_HDR };
    } catch {
      return { status: 404, body: JSON.stringify({ error: 'Not found' }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/mkdir', async (req) => {
    const { path, recursive } = parseBody(req);
    try {
      await fs.mkdir(path, { recursive: !!recursive });
      return { status: 200, body: JSON.stringify({ ok: true }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/rm', async (req) => {
    const { path, recursive } = parseBody(req);
    try {
      if (recursive) {
        const s = await fs.stat(path);
        if (s?.type === 'dir') {
          const entries = await fs.readdir(path);
          for (const name of entries) {
            const childPath = path + '/' + name;
            const cs = await fs.stat(childPath);
            if (cs?.type === 'dir') {
              await shell.execute(`rm -rf "${childPath}"`, () => {}, () => {});
            } else {
              await fs.unlink(childPath);
            }
          }
          await fs.rmdir(path);
        } else {
          await fs.unlink(path);
        }
      } else {
        await fs.unlink(path);
      }
      return { status: 200, body: JSON.stringify({ ok: true }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/rename', async (req) => {
    const { oldPath, newPath } = parseBody(req);
    try {
      await fs.rename(oldPath, newPath);
      return { status: 200, body: JSON.stringify({ ok: true }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  router.post('/api/fs/glob', async (req) => {
    const { pattern, base } = parseBody(req);
    try {
      const files = await fs.glob(pattern, base || projectDir);
      return { status: 200, body: JSON.stringify({ files }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  // ── Shell route ──
  router.post('/api/shell/exec', async (req) => {
    const { command } = parseBody(req);
    let stdout = '', stderr = '';
    try {
      const exitCode = await shell.execute(
        command,
        (data: string) => { stdout += data; },
        (data: string) => { stderr += data; },
      );
      return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ stdout, stderr: stderr + e.message, exitCode: 1 }), headers: JSON_HDR };
    }
  });

  // ── Git routes ──
  router.post('/api/git/status', async () => {
    let stdout = '', stderr = '';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && git status --porcelain`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  router.post('/api/git/log', async (req) => {
    const { n } = parseBody(req);
    let stdout = '', stderr = '';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && git log --oneline -${n || 20}`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  router.post('/api/git/diff', async (req) => {
    const { cached } = parseBody(req);
    let stdout = '', stderr = '';
    const cmd = cached ? 'git diff --cached' : 'git diff';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && ${cmd}`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  router.post('/api/git/commit', async (req) => {
    const { message, files } = parseBody(req);
    let stdout = '', stderr = '';
    const addCmd = files && files.length > 0
      ? `git add ${files.map((f: string) => `"${f}"`).join(' ')}`
      : 'git add -A';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && ${addCmd} && git commit -m "${(message || 'Update').replace(/"/g, '\\"')}"`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  router.post('/api/git/push', async () => {
    let stdout = '', stderr = '';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && GITHUB_TOKEN=$GITHUB_TOKEN git push`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  router.post('/api/git/pull', async () => {
    let stdout = '', stderr = '';
    const exitCode = await shell.execute(
      `cd "${projectDir}" && git pull`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  // ── Claude route ──
  router.post('/api/claude/prompt', async (req) => {
    const { prompt } = parseBody(req);
    let stdout = '', stderr = '';
    const escaped = prompt.replace(/'/g, "'\\''");
    const exitCode = await shell.execute(
      `claude -p '${escaped}'`,
      (d: string) => { stdout += d; }, (d: string) => { stderr += d; },
    );
    return { status: 200, body: JSON.stringify({ stdout, stderr, exitCode }), headers: JSON_HDR };
  });

  // ── Project scaffold route ──
  router.post('/api/project/scaffold', async (req) => {
    const { template, name } = parseBody(req);
    const tmpl = SCAFFOLD_TEMPLATES[template];
    if (!tmpl) {
      return { status: 400, body: JSON.stringify({ error: 'Unknown template: ' + template }), headers: JSON_HDR };
    }
    const targetDir = projectDir + '/' + (name || 'new-project');
    try {
      await fs.mkdir(targetDir, { recursive: true });
      for (const [file, content] of Object.entries(tmpl)) {
        const parts = file.split('/');
        if (parts.length > 1) {
          await fs.mkdir(targetDir + '/' + parts.slice(0, -1).join('/'), { recursive: true });
        }
        await fs.writeFile(targetDir + '/' + file, content);
      }
      return { status: 200, body: JSON.stringify({ ok: true, dir: targetDir }), headers: JSON_HDR };
    } catch (e: any) {
      return { status: 500, body: JSON.stringify({ error: e.message }), headers: JSON_HDR };
    }
  });

  // ── Root: serve IDE HTML ──
  router.get('/', async () => {
    const html = generateIdeHtml(projectDir);
    return { status: 200, body: html, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
  });

  return router;
}

export const ideCmd: Command = {
  name: 'ide',
  description: 'Launch visual IDE (CodeMirror 6)',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args[0] === '--help' || args[0] === '-h') {
      ctx.stdout = `ide [project-dir]  — Launch IDE for a project directory
  Default: current working directory

  The IDE provides:
    - File tree with git status indicators
    - Multi-tab editor (CodeMirror 6)
    - Slash menu (/) for quick commands
    - Integrated terminal, output panel, Claude chat
    - Live preview for HTML projects
    - Project scaffolding templates

  Press / in the IDE for the command menu.
  Press Ctrl+S to save. Ctrl+J to toggle terminal.
`;
      return 0;
    }

    // Resolve project directory
    const projectDir = args[0]
      ? ctx.fs.resolvePath(args[0], ctx.cwd)
      : ctx.cwd;

    // Verify directory exists
    let stat;
    try { stat = await ctx.fs.stat(projectDir); } catch {}
    if (!stat || stat.type !== 'dir') {
      ctx.stderr = `ide: ${args[0] || projectDir}: Not a directory\n`;
      return 1;
    }

    // Check if port already in use
    if (iframeServer.isPortInUse(IDE_PORT)) {
      ctx.stderr = `ide: port ${IDE_PORT} already in use. Run 'serve stop ${IDE_PORT}' first.\n`;
      return 1;
    }

    const router = createIdeRouter(ctx.fs, ctx.shell, projectDir);
    router.serve(IDE_PORT, 'ide');

    // Activate become mode
    await activateBecomeMode({
      directory: projectDir,
      port: IDE_PORT,
      slug: 'ide',
      title: 'Shiro IDE',
    });

    ctx.stdout = `IDE launched for ${projectDir}\n`;
    ctx.stdout += `Press / for commands. Run __shiro.unbecome() to exit.\n`;
    return 0;
  },
};
