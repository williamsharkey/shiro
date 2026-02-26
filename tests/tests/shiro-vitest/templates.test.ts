/**
 * Template palette tests — data integrity and command execution.
 *
 * Validates:
 * - Template data structure (required fields, valid values, no duplicates)
 * - Template commands execute through the shell (heredocs, file creation)
 * - ANSI color codes are embedded in output
 * - Educational structure (banner, suggestions)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { categories } from '@shiro/template-palette';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

// Flatten all templates for iteration
const allTemplates = categories.flatMap(c =>
  c.templates.map(t => ({ ...t, category: c.name }))
);

// ── Data Integrity ─────────────────────────────────────────────────

describe('Template Data Integrity', () => {
  it('should have 3 categories', () => {
    expect(categories).toHaveLength(3);
    expect(categories.map(c => c.name)).toEqual(['Web', 'Languages', 'Tools']);
  });

  it('should have 9 templates total', () => {
    expect(allTemplates).toHaveLength(9);
  });

  it('every template has required fields', () => {
    for (const t of allTemplates) {
      expect(t.name, `${t.name}: name`).toBeTruthy();
      expect(t.desc, `${t.name}: desc`).toBeTruthy();
      expect(t.icon, `${t.name}: icon`).toBeTruthy();
      expect(t.cmd, `${t.name}: cmd`).toBeTruthy();
      expect(t.level, `${t.name}: level`).toBeTruthy();
    }
  });

  it('every template has a valid level', () => {
    const validLevels = ['beginner', 'intermediate', 'advanced'];
    for (const t of allTemplates) {
      expect(validLevels, `${t.name}: invalid level "${t.level}"`).toContain(t.level);
    }
  });

  it('no duplicate template names', () => {
    const names = allTemplates.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no duplicate splitPorts', () => {
    const ports = allTemplates.filter(t => t.splitPort).map(t => t.splitPort);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('web templates have splitPorts, non-web templates do not', () => {
    for (const t of allTemplates) {
      if (t.category === 'Web') {
        expect(t.splitPort, `${t.name} should have splitPort`).toBeGreaterThan(0);
      } else {
        expect(t.splitPort, `${t.name} should not have splitPort`).toBeUndefined();
      }
    }
  });

  it('splitPorts are in range 3000-3999', () => {
    for (const t of allTemplates) {
      if (t.splitPort) {
        expect(t.splitPort).toBeGreaterThanOrEqual(3000);
        expect(t.splitPort).toBeLessThan(4000);
      }
    }
  });

  it('every icon is a single grapheme (emoji)', () => {
    for (const t of allTemplates) {
      // Icons should be 1-2 code points (emoji + optional variation selector)
      expect(t.icon.length, `${t.name}: icon too long`).toBeLessThanOrEqual(4);
      expect(t.icon.length, `${t.name}: icon empty`).toBeGreaterThanOrEqual(1);
    }
  });

  it('descriptions are concise (under 40 chars)', () => {
    for (const t of allTemplates) {
      expect(t.desc.length, `${t.name}: desc too long: "${t.desc}"`).toBeLessThanOrEqual(40);
    }
  });
});

// ── Command Structure ──────────────────────────────────────────────

describe('Template Command Structure', () => {
  it('every cmd contains ANSI escape bytes (ESC = 0x1B)', () => {
    for (const t of allTemplates) {
      expect(t.cmd, `${t.name}: should contain ESC byte`).toContain('\x1b[');
    }
  });

  it('every cmd starts with a lesson banner (echo with cyan bold)', () => {
    for (const t of allTemplates) {
      // First line should be echo with bold cyan ANSI
      const firstLine = t.cmd.split('\n')[0];
      expect(firstLine, `${t.name}: first line should be an echo`).toMatch(/^echo /);
      expect(firstLine, `${t.name}: banner should use cyan bold`).toContain('\x1b[1;36m');
    }
  });

  it('every cmd contains "What to try next" suggestions', () => {
    for (const t of allTemplates) {
      expect(t.cmd, `${t.name}: should have suggestions`).toContain('What to try next');
    }
  });

  it('web templates reference the serve command', () => {
    const webTemplates = allTemplates.filter(t => t.category === 'Web');
    for (const t of webTemplates) {
      // HTML Page, React App, and React+Routing use serve directly
      // Node.js Server uses node (Express listen registers the port)
      if (t.name !== 'Node.js Server') {
        expect(t.cmd, `${t.name}: should use serve`).toContain('serve ');
      }
    }
  });

  it('templates with files use heredocs', () => {
    const templatesThatCreateFiles = allTemplates.filter(t =>
      t.cmd.includes('cat >') || t.cmd.includes('cat >')
    );
    for (const t of templatesThatCreateFiles) {
      expect(t.cmd, `${t.name}: heredoc should use single-quoted delimiter`)
        .toMatch(/<<\s*'[A-Z]+'/);
    }
  });

  it('heredoc delimiters are properly closed', () => {
    for (const t of allTemplates) {
      // Find all heredoc starts: << 'DELIM'
      const starts = [...t.cmd.matchAll(/<<\s*'([A-Z]+)'/g)];
      for (const match of starts) {
        const delim = match[1];
        // The delimiter must appear on its own line
        const regex = new RegExp(`^${delim}$`, 'm');
        expect(t.cmd, `${t.name}: unclosed heredoc ${delim}`).toMatch(regex);
      }
    }
  });

  it('Node.js template uses Express with app.listen', () => {
    const node = allTemplates.find(t => t.name === 'Node.js Server');
    expect(node).toBeDefined();
    expect(node!.cmd).toContain('app.listen');
    expect(node!.cmd).toContain('express');
  });

  it('React templates reference CDN scripts', () => {
    const reactTemplates = allTemplates.filter(t => t.name.startsWith('React'));
    expect(reactTemplates.length).toBe(2);
    for (const t of reactTemplates) {
      expect(t.cmd, `${t.name}: should load React from CDN`).toContain('unpkg.com/react');
    }
  });

  it('Python template uses math and data structures', () => {
    const py = allTemplates.find(t => t.name === 'Python');
    expect(py).toBeDefined();
    expect(py!.cmd).toContain('import math');
    expect(py!.cmd).toContain('fibonacci');
  });

  it('TypeScript template uses type annotations', () => {
    const ts = allTemplates.find(t => t.name === 'TypeScript');
    expect(ts).toBeDefined();
    expect(ts!.cmd).toContain('interface Person');
    expect(ts!.cmd).toContain('build /tmp/myts/app.ts');
  });

  it('C template uses struct and pointer', () => {
    const c = allTemplates.find(t => t.name === 'C Program');
    expect(c).toBeDefined();
    expect(c!.cmd).toContain('typedef struct');
    expect(c!.cmd).toContain('int *ptr');
    expect(c!.cmd).toContain('cc /tmp/hello.c');
  });

  it('SQLite template uses SQL statements', () => {
    const sql = allTemplates.find(t => t.name === 'SQLite Database');
    expect(sql).toBeDefined();
    expect(sql!.cmd).toContain('CREATE TABLE');
    expect(sql!.cmd).toContain('INSERT INTO');
    expect(sql!.cmd).toContain('SELECT');
    expect(sql!.cmd).toContain('sqlite3');
  });

  it('Shell Tutorial template demonstrates pipes and redirects', () => {
    const sh = allTemplates.find(t => t.name === 'Shell Tutorial');
    expect(sh).toBeDefined();
    expect(sh!.cmd).toContain('|');
    expect(sh!.cmd).toContain('grep');
    expect(sh!.cmd).toContain('sort');
  });
});

// ── Full Command Execution (live reproduction) ───────────────────
//
// Each template's full multi-line cmd string is passed to shell.execute()
// in a single call — exactly how spawnInWindow() does it in production.
// This reproduces the bug where << tokens inside heredocs were mishandled.

describe('Template Full Command Execution', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  for (const t of allTemplates) {
    // Skip templates that need lazy-loaded commands (serve, node, python, build, cc, sqlite3)
    const needsLazy = ['serve ', 'node ', 'python3 ', 'build ', 'cc ', 'sqlite3 '];
    const lastLine = t.cmd.split('\n').filter(l => l.trim()).pop() || '';
    const usesLazy = needsLazy.some(c => lastLine.trimStart().startsWith(c));

    it(`${t.name}: full cmd executes without ENOENT`, async () => {
      // Run the full multi-line cmd — strip trailing serve/node/etc. lines
      // that need lazy-loaded commands not available in test env
      const lines = t.cmd.split('\n');
      const cmdLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (needsLazy.some(c => trimmed.startsWith(c))) continue;
        cmdLines.push(line);
      }
      const cmd = cmdLines.join('\n');

      const { output } = await run(shell, cmd);
      expect(output).not.toContain('ENOENT');
    });
  }

  it('HTML Page: creates /tmp/mypage/index.html', async () => {
    const template = categories[0].templates[0];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('serve ')).join('\n'));
    const content = await fs.readFile('/tmp/mypage/index.html', 'utf8') as string;
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('Hello from Shiro');
    expect(content).toContain('<style>');
    expect(content).toContain('onclick=');
  });

  it('Node.js Server: creates /tmp/myapi/server.js and index.html', async () => {
    const template = categories[0].templates[1];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('node ')).join('\n'));
    const serverJs = await fs.readFile('/tmp/myapi/server.js', 'utf8') as string;
    expect(serverJs).toContain("require('express')");
    expect(serverJs).toContain('/api/time');
    expect(serverJs).toContain('app.listen(3001');
    const indexHtml = await fs.readFile('/tmp/myapi/index.html', 'utf8') as string;
    expect(indexHtml).toContain('API Dashboard');
  });

  it('Python: creates /tmp/lesson.py', async () => {
    const template = categories[1].templates[0];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('python3 ')).join('\n'));
    const content = await fs.readFile('/tmp/lesson.py', 'utf8') as string;
    expect(content).toContain('import math');
    expect(content).toContain('fibonacci');
  });

  it('TypeScript: creates /tmp/myts/app.ts', async () => {
    const template = categories[1].templates[1];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('build ')).join('\n'));
    const content = await fs.readFile('/tmp/myts/app.ts', 'utf8') as string;
    expect(content).toContain('interface Person');
    expect(content).toContain('function greet');
  });

  it('C Program: creates /tmp/hello.c', async () => {
    const template = categories[1].templates[2];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('cc ')).join('\n'));
    const content = await fs.readFile('/tmp/hello.c', 'utf8') as string;
    expect(content).toContain('#include <stdio.h>');
    expect(content).toContain('typedef struct');
  });

  it('SQLite: creates /tmp/setup.sql', async () => {
    const template = categories[2].templates[0];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('sqlite3 ')).join('\n'));
    const content = await fs.readFile('/tmp/setup.sql', 'utf8') as string;
    expect(content).toContain('CREATE TABLE');
    expect(content).toContain('SELECT');
  });

  it('React App: creates /tmp/myreact/index.html', async () => {
    const template = categories[0].templates[2];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('serve ')).join('\n'));
    const content = await fs.readFile('/tmp/myreact/index.html', 'utf8') as string;
    expect(content).toContain('unpkg.com/react@18');
    expect(content).toContain('React.useState');
  });

  it('React + Routing: creates /tmp/myapp/index.html', async () => {
    const template = categories[0].templates[3];
    await run(shell, template.cmd.split('\n').filter(l => !l.trim().startsWith('serve ')).join('\n'));
    const content = await fs.readFile('/tmp/myapp/index.html', 'utf8') as string;
    expect(content).toContain('unpkg.com/react@18');
    expect(content).toContain('hashchange');
  });

  it('Shell Tutorial: creates CSV files', async () => {
    const template = categories[2].templates[1];
    const { output } = await run(shell, template.cmd);
    const content = await fs.readFile('/tmp/tutorial/people.csv', 'utf8') as string;
    expect(content).toContain('Alice,25,Engineer');
    expect(output).toContain('cat: read files');
    expect(output).toContain('Developer');
  });

  it('echo commands produce ANSI-colored output', async () => {
    const { output } = await run(shell, 'echo "\x1b[1;36m--- Lesson ---\x1b[0m"');
    expect(output).toContain('\x1b[1;36m');
    expect(output).toContain('--- Lesson ---');
  });

  it('grep finds Developer lines', async () => {
    await fs.mkdir('/tmp/tutorial', { recursive: true });
    await fs.writeFile('/tmp/tutorial/people.csv',
      'Alice,25,Engineer\nBob,30,Designer\nCarol,28,Developer\n');
    const { output } = await run(shell, 'grep Developer /tmp/tutorial/people.csv');
    expect(output).toContain('Carol,28,Developer');
    expect(output).not.toContain('Alice');
  });

  it('pipes work: sort | head', async () => {
    await fs.mkdir('/tmp/tutorial', { recursive: true });
    await fs.writeFile('/tmp/tutorial/people.csv',
      'Carol,28,Developer\nAlice,25,Engineer\nBob,30,Designer\n');
    const { output } = await run(shell, 'cat /tmp/tutorial/people.csv | sort | head -2');
    const lines = output.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alice');
    expect(lines[1]).toContain('Bob');
  });

  it('redirects work: output to file', async () => {
    await fs.mkdir('/tmp/tutorial', { recursive: true });
    await fs.writeFile('/tmp/tutorial/people.csv',
      'Carol\nAlice\nBob\n');
    await run(shell, 'cat /tmp/tutorial/people.csv | sort > /tmp/tutorial/sorted.csv');
    const sorted = await fs.readFile('/tmp/tutorial/sorted.csv', 'utf8') as string;
    expect(sorted.trim().split('\n')[0]).toBe('Alice');
  });
});
