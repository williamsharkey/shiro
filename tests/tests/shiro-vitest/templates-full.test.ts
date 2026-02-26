/**
 * Full-scale template tests — classic + living templates.
 *
 * Tests the complete execution flow through the shell with linkedom:
 * - Classic templates: full multi-line cmd with heredocs, serve registration, file content
 * - Living templates: setup commands, file creation, guide HTML, checkpoint verification,
 *   serve registration, iframeServer fetch
 *
 * The serve command and iframeServer are registered so templates that call `serve`
 * actually register virtual ports — enabling end-to-end content verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { categories, type Template } from '@shiro/template-palette';
import { livingTemplates } from '@shiro/living-templates';
import type { LivingTemplate } from '@shiro/template-runner';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { serveCmd, serversCmd } from '@shiro/commands/serve';
import { iframeServer } from '@shiro/iframe-server';

// ── Helpers ───────────────────────────────────────────────────────────

/** Create a test shell with the serve command registered */
async function createTestShellWithServe(): Promise<{ fs: FileSystem; shell: Shell }> {
  const env = await createTestShell();
  env.shell.commands.register(serveCmd);
  env.shell.commands.register(serversCmd);
  return env;
}

/** Stop all active servers and clear iframeServer state */
function cleanupServers() {
  for (const s of iframeServer.list()) {
    iframeServer.close(s.port);
  }
}

// Flatten classic templates
const allClassic = categories.flatMap(c =>
  c.templates.map(t => ({ ...t, category: c.name }))
);

// ── Classic Templates: Full Execution with Serve ─────────────────────

describe('Classic Templates: Full Execution with Serve', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    cleanupServers();
    const env = await createTestShellWithServe();
    shell = env.shell;
    fs = env.fs;
  });

  afterEach(() => {
    cleanupServers();
  });

  // Commands that truly can't run in test env (WASM runtimes, compiled binaries, etc.)
  const unavailable = ['node ', 'python3 ', 'python ', 'build ', 'cc ', 'sqlite3 ', '/tmp/hello'];

  /** Filter out lines that start with unavailable commands */
  function filterCmd(cmd: string): string {
    return cmd.split('\n')
      .filter(l => !unavailable.some(c => l.trim().startsWith(c)))
      .join('\n');
  }

  for (const t of allClassic) {
    it(`${t.name}: executes without errors`, async () => {
      const cmd = filterCmd(t.cmd);
      const { output, exitCode } = await run(shell, cmd);
      expect(output, `${t.name}: ENOENT in output`).not.toContain('ENOENT');
      expect(output, `${t.name}: "not found" in output`).not.toContain('command not found');
    });
  }

  // ── Web templates: serve registers ports ──

  it('HTML Page: serve registers port 3000', async () => {
    const cmd = filterCmd(categories[0].templates[0].cmd);
    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3000)).toBe(true);
  });

  it('HTML Page: iframeServer.fetch returns HTML with correct content', async () => {
    const cmd = filterCmd(categories[0].templates[0].cmd);
    await run(shell, cmd);
    const resp = await iframeServer.fetch(3000, '/');
    expect(resp.status).toBe(200);
    const body = typeof resp.body === 'string' ? resp.body : new TextDecoder().decode(resp.body as Uint8Array);
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('Hello from Shiro');
    expect(body).toContain('<style>');
  });

  it('React App: serve registers port 3002', async () => {
    const cmd = filterCmd(categories[0].templates[2].cmd);
    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3002)).toBe(true);
  });

  it('React App: fetched HTML loads React from CDN', async () => {
    const cmd = filterCmd(categories[0].templates[2].cmd);
    await run(shell, cmd);
    const resp = await iframeServer.fetch(3002, '/');
    const body = typeof resp.body === 'string' ? resp.body : new TextDecoder().decode(resp.body as Uint8Array);
    expect(body).toContain('unpkg.com/react@18');
    expect(body).toContain('React.useState');
    expect(body).toContain('ReactDOM.createRoot');
  });

  it('React + Routing: serve registers port 3003', async () => {
    const cmd = filterCmd(categories[0].templates[3].cmd);
    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3003)).toBe(true);
  });

  it('React + Routing: fetched HTML has hash-based routing', async () => {
    const cmd = filterCmd(categories[0].templates[3].cmd);
    await run(shell, cmd);
    const resp = await iframeServer.fetch(3003, '/');
    const body = typeof resp.body === 'string' ? resp.body : new TextDecoder().decode(resp.body as Uint8Array);
    expect(body).toContain('hashchange');
    expect(body).toContain('#/counter');
    expect(body).toContain('#/about');
  });

  // ── Node.js template: creates Express server file ──

  it('Node.js Server: creates server.js with Express routes', async () => {
    const cmd = filterCmd(categories[0].templates[1].cmd);
    await run(shell, cmd);
    const serverJs = await fs.readFile('/tmp/myapi/server.js', 'utf8') as string;
    expect(serverJs).toContain("require('express')");
    expect(serverJs).toContain("app.get('/api/time'");
    expect(serverJs).toContain("app.get('/api/echo'");
    expect(serverJs).toContain("app.get('/api/random'");
    expect(serverJs).toContain('app.listen(3001');
  });

  it('Node.js Server: creates index.html with API dashboard', async () => {
    const cmd = filterCmd(categories[0].templates[1].cmd);
    await run(shell, cmd);
    const html = await fs.readFile('/tmp/myapi/index.html', 'utf8') as string;
    expect(html).toContain('API Dashboard');
    expect(html).toContain('/api/time');
    expect(html).toContain('/api/echo');
    expect(html).toContain('/api/random');
    expect(html).toContain('callApi');
  });

  // ── Language templates: file content validation ──

  it('Python: lesson.py has all educational sections', async () => {
    const cmd = filterCmd(categories[1].templates[0].cmd);
    await run(shell, cmd);
    const content = await fs.readFile('/tmp/lesson.py', 'utf8') as string;
    expect(content).toContain('import math');
    expect(content).toContain('import sys');
    expect(content).toContain('fibonacci');
    expect(content).toContain('list comprehension');
    expect(content).toContain('Dictionaries');
    expect(content).toContain('math.sin');
  });

  it('TypeScript: app.ts has types and generics', async () => {
    const cmd = filterCmd(categories[1].templates[1].cmd);
    await run(shell, cmd);
    const content = await fs.readFile('/tmp/myts/app.ts', 'utf8') as string;
    expect(content).toContain('interface Person');
    expect(content).toContain('function greet(person: Person): string');
    expect(content).toContain('function first<T>');
    expect(content).toContain('string | number');
    expect(content).toContain('typeof value');
  });

  it('C Program: hello.c has struct, pointer, and array', async () => {
    const cmd = filterCmd(categories[1].templates[2].cmd);
    await run(shell, cmd);
    const content = await fs.readFile('/tmp/hello.c', 'utf8') as string;
    expect(content).toContain('#include <stdio.h>');
    expect(content).toContain('#include <string.h>');
    expect(content).toContain('typedef struct');
    expect(content).toContain('Student');
    expect(content).toContain('int *ptr');
    expect(content).toContain('class_list[');
  });

  // ── Tool templates: file content validation ──

  it('SQLite: setup.sql has CREATE, INSERT, SELECT, GROUP BY', async () => {
    const cmd = filterCmd(categories[2].templates[0].cmd);
    await run(shell, cmd);
    const content = await fs.readFile('/tmp/setup.sql', 'utf8') as string;
    expect(content).toContain('CREATE TABLE');
    expect(content).toContain('INSERT INTO students');
    expect(content).toContain("SELECT name, age, grade FROM students");
    expect(content).toContain("WHERE grade = 'A'");
    expect(content).toContain('GROUP BY grade');
  });

  it('Shell Tutorial: creates CSV and runs full pipeline', async () => {
    const { output } = await run(shell, categories[2].templates[1].cmd);
    // File created
    const csv = await fs.readFile('/tmp/tutorial/people.csv', 'utf8') as string;
    expect(csv).toContain('Alice,25,Engineer');
    expect(csv).toContain('Eve,22,Developer');
    // grep output
    expect(output).toContain('Carol,28,Developer');
    // sort output (alphabetical)
    expect(output).toContain('Alice');
    // sorted file written via redirect
    const sorted = await fs.readFile('/tmp/tutorial/sorted.csv', 'utf8') as string;
    const lines = sorted.trim().split('\n');
    expect(lines[0]).toContain('Alice');
    // wc output
    expect(output).toContain('5');
  });

  // ── Banner and educational content ──

  it('every classic template output starts with a lesson banner', async () => {
    for (const t of allClassic) {
      const cmd = filterCmd(t.cmd);
      const { output } = await run(shell, cmd);
      // Should contain the ANSI-formatted lesson banner
      expect(output, `${t.name}: missing banner`).toContain('--- Lesson');
    }
  });

  it('every classic template output contains "What to try next"', async () => {
    for (const t of allClassic) {
      const cmd = filterCmd(t.cmd);
      const { output } = await run(shell, cmd);
      expect(output, `${t.name}: missing suggestions`).toContain('What to try next');
    }
  });

  // ── serve list/stop integration ──

  it('serve list shows registered servers', async () => {
    const cmd = filterCmd(categories[0].templates[0].cmd);
    await run(shell, cmd);
    const { output } = await run(shell, 'serve list');
    expect(output).toContain(':3000');
    expect(output).toContain('static');
  });

  it('serve stop unregisters port', async () => {
    const cmd = filterCmd(categories[0].templates[0].cmd);
    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3000)).toBe(true);
    await run(shell, 'serve stop 3000');
    expect(iframeServer.isPortInUse(3000)).toBe(false);
  });

  it('serve fetch returns 200 from virtual server', async () => {
    const cmd = filterCmd(categories[0].templates[0].cmd);
    await run(shell, cmd);
    const { output } = await run(shell, 'serve fetch 3000 /');
    expect(output).toContain('Status: 200');
    expect(output).toContain('text/html');
  });
});

// ── Living Templates: Data Integrity ─────────────────────────────────

describe('Living Templates: Data Integrity', () => {
  it('should have 5 living templates', () => {
    expect(livingTemplates).toHaveLength(5);
  });

  it('every living template has required fields', () => {
    for (const t of livingTemplates) {
      expect(t.id, `${t.name}: id`).toBeTruthy();
      expect(t.name, `${t.name}: name`).toBeTruthy();
      expect(t.genre, `${t.name}: genre`).toBeTruthy();
      expect(t.level, `${t.name}: level`).toBeTruthy();
      expect(t.icon, `${t.name}: icon`).toBeTruthy();
      expect(t.desc, `${t.name}: desc`).toBeTruthy();
      expect(t.time, `${t.name}: time`).toBeTruthy();
      expect(t.learns, `${t.name}: learns`).toBeInstanceOf(Array);
      expect(t.learns.length, `${t.name}: learns empty`).toBeGreaterThan(0);
      expect(t.guideHtml, `${t.name}: guideHtml`).toBeTruthy();
      expect(t.guidePort, `${t.name}: guidePort`).toBeGreaterThan(0);
      expect(t.setup, `${t.name}: setup`).toBeInstanceOf(Array);
      expect(t.workDir, `${t.name}: workDir`).toBeTruthy();
      expect(t.checkpoints, `${t.name}: checkpoints`).toBeInstanceOf(Array);
      expect(t.checkpoints.length, `${t.name}: no checkpoints`).toBeGreaterThan(0);
    }
  });

  it('valid genres', () => {
    const validGenres = ['quest', 'mirror', 'automator', 'canvas', 'collaborator'];
    for (const t of livingTemplates) {
      expect(validGenres, `${t.name}: invalid genre "${t.genre}"`).toContain(t.genre);
    }
  });

  it('valid levels', () => {
    const validLevels = ['beginner', 'intermediate', 'advanced'];
    for (const t of livingTemplates) {
      expect(validLevels, `${t.name}: invalid level "${t.level}"`).toContain(t.level);
    }
  });

  it('no duplicate IDs', () => {
    const ids = livingTemplates.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no duplicate guide ports', () => {
    const ports = livingTemplates.map(t => t.guidePort);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('guide ports are in range 9001-9099', () => {
    for (const t of livingTemplates) {
      expect(t.guidePort, `${t.name}: port out of range`).toBeGreaterThanOrEqual(9001);
      expect(t.guidePort, `${t.name}: port out of range`).toBeLessThan(9100);
    }
  });

  it('no port overlap between classic and living templates', () => {
    const classicPorts = new Set(allClassic.filter(t => t.splitPort).map(t => t.splitPort));
    for (const t of livingTemplates) {
      expect(classicPorts.has(t.guidePort), `${t.name}: port ${t.guidePort} conflicts with classic template`).toBe(false);
    }
  });

  it('every checkpoint has an id and verify config', () => {
    for (const t of livingTemplates) {
      for (const cp of t.checkpoints) {
        expect(cp.id, `${t.name}: checkpoint missing id`).toBeTruthy();
        expect(cp.verify, `${t.name}/${cp.id}: missing verify`).toBeDefined();
        expect(cp.verify.type, `${t.name}/${cp.id}: missing verify.type`).toBeTruthy();
        const validTypes = ['file-exists', 'file-contains', 'command-succeeds'];
        expect(validTypes, `${t.name}/${cp.id}: invalid verify type`).toContain(cp.verify.type);
      }
    }
  });

  it('file-exists checkpoints have a path', () => {
    for (const t of livingTemplates) {
      for (const cp of t.checkpoints) {
        if (cp.verify.type === 'file-exists') {
          expect(cp.verify.path, `${t.name}/${cp.id}: file-exists missing path`).toBeTruthy();
        }
      }
    }
  });

  it('file-contains checkpoints have path and pattern', () => {
    for (const t of livingTemplates) {
      for (const cp of t.checkpoints) {
        if (cp.verify.type === 'file-contains') {
          expect(cp.verify.path, `${t.name}/${cp.id}: file-contains missing path`).toBeTruthy();
          expect(cp.verify.pattern, `${t.name}/${cp.id}: file-contains missing pattern`).toBeTruthy();
        }
      }
    }
  });

  it('command-succeeds checkpoints have a command', () => {
    for (const t of livingTemplates) {
      for (const cp of t.checkpoints) {
        if (cp.verify.type === 'command-succeeds') {
          expect(cp.verify.command, `${t.name}/${cp.id}: command-succeeds missing command`).toBeTruthy();
        }
      }
    }
  });
});

// ── Living Templates: Guide HTML Validation ──────────────────────────

describe('Living Templates: Guide HTML', () => {
  it('every guide HTML is valid and has required structure', () => {
    for (const t of livingTemplates) {
      expect(t.guideHtml, `${t.name}: missing DOCTYPE`).toContain('<!DOCTYPE html>');
      expect(t.guideHtml, `${t.name}: missing <html>`).toContain('<html>');
      expect(t.guideHtml, `${t.name}: missing </html>`).toContain('</html>');
      expect(t.guideHtml, `${t.name}: missing <head>`).toContain('<head>');
      expect(t.guideHtml, `${t.name}: missing <body>`).toContain('<body>');
      expect(t.guideHtml, `${t.name}: missing </body>`).toContain('</body>');
      expect(t.guideHtml, `${t.name}: missing charset`).toContain('charset="UTF-8"');
      expect(t.guideHtml, `${t.name}: missing viewport`).toContain('viewport');
    }
  });

  it('every guide HTML has a <title>', () => {
    for (const t of livingTemplates) {
      expect(t.guideHtml, `${t.name}: missing <title>`).toMatch(/<title>[^<]+<\/title>/);
    }
  });

  it('every guide HTML has CSS styles', () => {
    for (const t of livingTemplates) {
      expect(t.guideHtml, `${t.name}: missing <style>`).toContain('<style>');
    }
  });

  it('guide HTML has step/instruction elements', () => {
    for (const t of livingTemplates) {
      // Each guide should have instructional content (steps, tasks, etc.)
      const hasSteps = t.guideHtml.includes('class="step"') ||
                       t.guideHtml.includes('class="task"') ||
                       t.guideHtml.includes('Step ') ||
                       t.guideHtml.includes('step-');
      expect(hasSteps, `${t.name}: guide has no step/task elements`).toBe(true);
    }
  });

  it('Mission Control guide has space-themed content', () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    expect(mc.guideHtml).toContain('Mission Control');
    expect(mc.guideHtml).toContain('ALERT: SYSTEMS OFFLINE');
    expect(mc.guideHtml).toContain('critical failures');
    expect(mc.guideHtml).toContain('status.log');
  });

  it('Your Homepage guide has personal website content', () => {
    const hp = livingTemplates.find(t => t.id === 'mirror-homepage')!;
    expect(hp.guideHtml).toContain('Your Homepage');
    expect(hp.guideHtml).toContain('color');
  });

  it('Tame Your Data guide has data analysis content', () => {
    const data = livingTemplates.find(t => t.id === 'automator-data')!;
    expect(data.guideHtml).toContain('Tame Your Data');
    expect(data.guideHtml).toContain('50 employees');
    expect(data.guideHtml).toContain('data');
  });

  it('Code as Art guide has creative coding content', () => {
    const art = livingTemplates.find(t => t.id === 'canvas-art')!;
    expect(art.guideHtml).toContain('Code as Art');
    expect(art.guideHtml).toContain('canvas');
  });

  it('AI Copilot guide has AI collaboration content', () => {
    const ai = livingTemplates.find(t => t.id === 'collaborator-copilot')!;
    expect(ai.guideHtml).toContain('AI Copilot');
    expect(ai.guideHtml).toContain('Claude');
  });
});

// ── Living Templates: Setup Execution ────────────────────────────────

describe('Living Templates: Setup Commands', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    cleanupServers();
    const env = await createTestShellWithServe();
    shell = env.shell;
    fs = env.fs;
  });

  afterEach(() => {
    cleanupServers();
  });

  for (const t of livingTemplates) {
    it(`${t.name}: all setup commands execute without error`, async () => {
      // Create workDir first (as runLivingTemplate does)
      await fs.mkdir(t.workDir, { recursive: true });
      for (let i = 0; i < t.setup.length; i++) {
        const cmd = t.setup[i];
        const { output, exitCode } = await run(shell, cmd);
        expect(output, `${t.name} setup[${i}]: ENOENT`).not.toContain('ENOENT');
        expect(exitCode, `${t.name} setup[${i}]: non-zero exit code`).toBe(0);
      }
    });
  }

  // ── Mission Control setup files ──

  it('Mission Control: creates status.log with system entries', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await run(shell, cmd);
    }
    const log = await fs.readFile('/var/ship/status.log', 'utf8') as string;
    expect(log).toContain('[CRITICAL] Engine subsystem: OFFLINE');
    expect(log).toContain('[WARNING]  Navigation: DRIFT DETECTED');
    expect(log).toContain('[INFO]     Life support: nominal');
    expect(log).toContain('crew status');
    expect(log).toContain('[CRITICAL] Communications array: NO SIGNAL');
    expect(log).toContain('Hull integrity: 94%');
  });

  it('Mission Control: creates engine.sh with typo to fix', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await run(shell, cmd);
    }
    const engine = await fs.readFile('/var/ship/engine.sh', 'utf8') as string;
    expect(engine).toContain('#!/bin/sh');
    expect(engine).toContain('Engine ignition sequence');
    // Contains the deliberate typo "fule" (should be "fuel")
    expect(engine).toContain('fule');
  });

  it('Mission Control: creates dashboard/index.html', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await run(shell, cmd);
    }
    const html = await fs.readFile('/var/ship/dashboard/index.html', 'utf8') as string;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Station Control Dashboard');
    expect(html).toContain('Engine');
  });

  // ── Your Homepage: empty setup ──

  it('Your Homepage: has no setup commands (user creates from scratch)', () => {
    const hp = livingTemplates.find(t => t.id === 'mirror-homepage')!;
    expect(hp.setup).toHaveLength(0);
  });

  // ── Tame Your Data: CSV setup ──

  it('Tame Your Data: creates employees.csv with 50 rows', async () => {
    const data = livingTemplates.find(t => t.id === 'automator-data')!;
    await fs.mkdir(data.workDir, { recursive: true });
    for (const cmd of data.setup) {
      await run(shell, cmd);
    }
    const csv = await fs.readFile('/tmp/data/employees.csv', 'utf8') as string;
    const rows = csv.trim().split('\n');
    // Header + 50 data rows
    expect(rows.length).toBe(51);
    // Header has correct columns
    expect(rows[0]).toBe('name,department,salary,city,start_date');
    // Spot-check data
    expect(csv).toContain('Engineering');
    expect(csv).toContain('Marketing');
    expect(csv).toContain('Seattle');
  });

  // ── Code as Art: spiral.js setup ──

  it('Code as Art: creates spiral.js with canvas code', async () => {
    const art = livingTemplates.find(t => t.id === 'canvas-art')!;
    await fs.mkdir(art.workDir, { recursive: true });
    for (const cmd of art.setup) {
      await run(shell, cmd);
    }
    const js = await fs.readFile('/tmp/art/spiral.js', 'utf8') as string;
    expect(js).toContain('SPIRALS');
    expect(js).toContain('COLOR_SPEED');
    expect(js).toContain('Math.cos');
    expect(js).toContain('Math.sin');
    expect(js).toContain('ctx.fillStyle');
    expect(js).toContain('ctx.arc');
  });

  // ── AI Copilot: minimal setup ──

  it('AI Copilot: creates workDir only', async () => {
    const ai = livingTemplates.find(t => t.id === 'collaborator-copilot')!;
    await fs.mkdir(ai.workDir, { recursive: true });
    for (const cmd of ai.setup) {
      await run(shell, cmd);
    }
    const stat = await fs.stat('/tmp/todo');
    expect(stat).toBeTruthy();
    expect(stat!.type).toBe('dir');
  });
});

// ── Living Templates: Guide Server + Content Fetch ───────────────────

describe('Living Templates: Guide Server', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    cleanupServers();
    const env = await createTestShellWithServe();
    shell = env.shell;
    fs = env.fs;
  });

  afterEach(() => {
    cleanupServers();
  });

  for (const t of livingTemplates) {
    it(`${t.name}: guide can be served and fetched`, async () => {
      // Reproduce what runLivingTemplate does:
      // 1. Create workDir
      await fs.mkdir(t.workDir, { recursive: true });
      // 2. Run setup commands
      for (const cmd of t.setup) {
        await shell.execute(cmd, () => {}, () => {});
      }
      // 3. Write guide HTML
      const guideDir = `/tmp/.guides/${t.id}`;
      await fs.mkdir(guideDir, { recursive: true });
      await fs.writeFile(`${guideDir}/index.html`, t.guideHtml);
      // 4. Serve the guide
      const { exitCode } = await run(shell, `serve ${guideDir} ${t.guidePort}`);
      expect(exitCode, `${t.name}: serve failed`).toBe(0);
      expect(iframeServer.isPortInUse(t.guidePort), `${t.name}: port not registered`).toBe(true);
      // 5. Fetch guide content from the virtual server
      const resp = await iframeServer.fetch(t.guidePort, '/');
      expect(resp.status, `${t.name}: guide fetch failed`).toBe(200);
      const body = typeof resp.body === 'string' ? resp.body : new TextDecoder().decode(resp.body as Uint8Array);
      expect(body, `${t.name}: guide missing DOCTYPE`).toContain('<!DOCTYPE html>');
      expect(body, `${t.name}: guide has no content`).toContain(t.name);
    });
  }

  it('all living template guides serve on distinct ports simultaneously', async () => {
    // Set up and serve all guides at once
    for (const t of livingTemplates) {
      await fs.mkdir(t.workDir, { recursive: true });
      for (const cmd of t.setup) {
        await shell.execute(cmd, () => {}, () => {});
      }
      const guideDir = `/tmp/.guides/${t.id}`;
      await fs.mkdir(guideDir, { recursive: true });
      await fs.writeFile(`${guideDir}/index.html`, t.guideHtml);
      await run(shell, `serve ${guideDir} ${t.guidePort}`);
    }

    // Verify all ports registered
    for (const t of livingTemplates) {
      expect(iframeServer.isPortInUse(t.guidePort), `${t.name}: port ${t.guidePort} not active`).toBe(true);
    }

    // Verify each returns correct content
    for (const t of livingTemplates) {
      const resp = await iframeServer.fetch(t.guidePort, '/');
      const body = typeof resp.body === 'string'
        ? resp.body
        : resp.body instanceof Uint8Array
          ? new TextDecoder().decode(resp.body)
          : '';
      expect(body.length, `${t.name}: empty response`).toBeGreaterThan(0);
      expect(body, `${t.name}: missing DOCTYPE`).toContain('<!DOCTYPE html>');
    }

    // servers command should list all
    const { output } = await run(shell, 'serve list');
    for (const t of livingTemplates) {
      expect(output, `${t.name}: not in serve list`).toContain(`:${t.guidePort}`);
    }
  });
});

// ── Living Templates: Checkpoint Verification ────────────────────────

describe('Living Templates: Checkpoints', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    cleanupServers();
    const env = await createTestShellWithServe();
    shell = env.shell;
    fs = env.fs;
  });

  afterEach(() => {
    cleanupServers();
  });

  it('Mission Control: step-1 checkpoint passes after setup (cat status.log)', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    // Checkpoint step-1: command-succeeds: cat /var/ship/status.log
    const exitCode = await shell.execute('cat /var/ship/status.log', () => {}, () => {});
    expect(exitCode).toBe(0);
  });

  it('Mission Control: step-3 checkpoint passes (grep crew)', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    // Checkpoint step-3: command-succeeds: grep crew /var/ship/status.log
    const exitCode = await shell.execute('grep crew /var/ship/status.log', () => {}, () => {});
    expect(exitCode).toBe(0);
  });

  it('Mission Control: step-4 checkpoint passes (engine.sh contains "fule")', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    // Checkpoint step-4: file-contains: engine.sh contains "fuel"
    // Note: the setup has a deliberate typo "fule", checkpoint looks for "fuel"
    const content = await fs.readFile('/var/ship/engine.sh', 'utf8') as string;
    expect(content).toContain('fule');
    // The checkpoint pattern is "fuel" — this checkpoint should FAIL initially
    // (the user needs to fix the typo, that's the lesson)
    expect(content).not.toContain('fuel levels');
  });

  it('Mission Control: step-2 checkpoint fails initially (no coords.txt)', async () => {
    const mc = livingTemplates.find(t => t.id === 'quest-mission-control')!;
    await fs.mkdir(mc.workDir, { recursive: true });
    for (const cmd of mc.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    // step-2: file-contains: /var/ship/coords.txt contains "47.3"
    // coords.txt doesn't exist after setup — user creates it
    const exists = await fs.exists('/var/ship/coords.txt');
    expect(exists).toBe(false);
  });

  it('Tame Your Data: step-1 checkpoint passes (cat employees.csv)', async () => {
    const data = livingTemplates.find(t => t.id === 'automator-data')!;
    await fs.mkdir(data.workDir, { recursive: true });
    for (const cmd of data.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    const exitCode = await shell.execute('cat /tmp/data/employees.csv', () => {}, () => {});
    expect(exitCode).toBe(0);
  });

  it('Tame Your Data: step-2 checkpoint passes (grep Engineering)', async () => {
    const data = livingTemplates.find(t => t.id === 'automator-data')!;
    await fs.mkdir(data.workDir, { recursive: true });
    for (const cmd of data.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    const exitCode = await shell.execute('grep Engineering /tmp/data/employees.csv', () => {}, () => {});
    expect(exitCode).toBe(0);
  });

  it('Tame Your Data: step-5 fails initially (no eng-report.csv)', async () => {
    const data = livingTemplates.find(t => t.id === 'automator-data')!;
    await fs.mkdir(data.workDir, { recursive: true });
    for (const cmd of data.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    const exists = await fs.exists('/tmp/data/eng-report.csv');
    expect(exists).toBe(false);
  });

  it('Code as Art: edit-code checkpoint passes (spiral.js exists)', async () => {
    const art = livingTemplates.find(t => t.id === 'canvas-art')!;
    await fs.mkdir(art.workDir, { recursive: true });
    for (const cmd of art.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    const exists = await fs.exists('/tmp/art/spiral.js');
    expect(exists).toBe(true);
  });

  it('AI Copilot: step-1 fails initially (no index.html)', async () => {
    const ai = livingTemplates.find(t => t.id === 'collaborator-copilot')!;
    await fs.mkdir(ai.workDir, { recursive: true });
    for (const cmd of ai.setup) {
      await shell.execute(cmd, () => {}, () => {});
    }
    const exists = await fs.exists('/tmp/todo/index.html');
    expect(exists).toBe(false);
  });

  it('Your Homepage: generate checkpoint fails initially (no index.html)', async () => {
    const hp = livingTemplates.find(t => t.id === 'mirror-homepage')!;
    await fs.mkdir(hp.workDir, { recursive: true });
    const exists = await fs.exists('/tmp/homepage/index.html');
    expect(exists).toBe(false);
  });
});

// ── Cross-cutting: No Port Conflicts ─────────────────────────────────

describe('Template Port Uniqueness', () => {
  it('all ports across classic and living templates are unique', () => {
    const allPorts: { name: string; port: number }[] = [];

    for (const t of allClassic) {
      if (t.splitPort) {
        allPorts.push({ name: `classic:${t.name}`, port: t.splitPort });
      }
    }
    for (const t of livingTemplates) {
      allPorts.push({ name: `living:${t.name}`, port: t.guidePort });
    }

    const seen = new Map<number, string>();
    for (const { name, port } of allPorts) {
      expect(seen.has(port), `Port ${port} used by both ${seen.get(port)} and ${name}`).toBe(false);
      seen.set(port, name);
    }
  });
});

// ── Classic Templates: Multiple Serve in Sequence ────────────────────

describe('Classic Templates: Sequential Serve', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    cleanupServers();
    const env = await createTestShellWithServe();
    shell = env.shell;
    fs = env.fs;
  });

  afterEach(() => {
    cleanupServers();
  });

  it('all web templates can serve simultaneously on different ports', async () => {
    const webTemplates = allClassic.filter(t => t.splitPort);
    const unavailable = ['node '];

    for (const t of webTemplates) {
      const cmd = t.cmd.split('\n')
        .filter(l => !unavailable.some(c => l.trim().startsWith(c)))
        .join('\n');
      await run(shell, cmd);
    }

    // All web template ports should be registered
    for (const t of webTemplates) {
      if (t.name !== 'Node.js Server') {
        // Node.js server uses node (can't run in test), but others use serve
        expect(iframeServer.isPortInUse(t.splitPort!),
          `${t.name}: port ${t.splitPort} not registered`).toBe(true);
      }
    }
  });

  it('serve stop frees port for reuse', async () => {
    const htmlTemplate = categories[0].templates[0];
    const cmd = htmlTemplate.cmd.split('\n')
      .filter(l => !['node '].some(c => l.trim().startsWith(c)))
      .join('\n');

    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3000)).toBe(true);

    await run(shell, 'serve stop 3000');
    expect(iframeServer.isPortInUse(3000)).toBe(false);

    // Can re-serve on same port
    await run(shell, cmd);
    expect(iframeServer.isPortInUse(3000)).toBe(true);
  });
});
