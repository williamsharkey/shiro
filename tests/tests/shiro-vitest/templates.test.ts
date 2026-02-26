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

// ── Command Execution ──────────────────────────────────────────────
//
// Shell.execute() splits multi-line input on newlines, so heredocs
// that appear after echo commands get orphaned.  Work around this by
// extracting each heredoc block individually and running it as a
// standalone shell.execute() call.

/**
 * Extract heredoc blocks from a template cmd string.
 * Returns an array of standalone shell commands, each creating one file.
 * Matches patterns like:
 *   mkdir -p /tmp/dir && cat > /path << 'DELIM' ... DELIM
 *   cat > /path << 'DELIM' ... DELIM
 */
function extractHeredocs(cmd: string): { shellCmd: string; path: string }[] {
  const results: { shellCmd: string; path: string }[] = [];
  const regex = /((?:mkdir\s+-p\s+[^\n&]+&&\s*)?cat\s*>\s*(\S+)\s*<<\s*'([A-Z]+)')\n([\s\S]*?)\n\3/g;
  let match;
  while ((match = regex.exec(cmd)) !== null) {
    const header = match[1];   // e.g. "mkdir -p /tmp/dir && cat > /path << 'DELIM'"
    const path = match[2];     // e.g. "/path"
    const delim = match[3];    // e.g. "DELIM"
    const body = match[4];     // heredoc content
    results.push({
      shellCmd: `${header}\n${body}\n${delim}`,
      path,
    });
  }
  return results;
}

describe('Template Command Execution', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('echo commands produce ANSI-colored output', async () => {
    const { output } = await run(shell, 'echo "\x1b[1;36m--- Lesson ---\x1b[0m"');
    expect(output).toContain('\x1b[1;36m');
    expect(output).toContain('--- Lesson ---');
  });

  describe('HTML Page template', () => {
    it('creates /tmp/mypage/index.html with correct content', async () => {
      const template = categories[0].templates[0]; // Web > HTML Page
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBeGreaterThanOrEqual(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/mypage/index.html', 'utf8') as string;
      expect(content).toContain('<!DOCTYPE html>');
      expect(content).toContain('Hello from Shiro');
      expect(content).toContain('<style>');
      expect(content).toContain('onclick=');
    });
  });

  describe('Node.js Server template', () => {
    it('creates /tmp/myapi/server.js and index.html', async () => {
      const template = categories[0].templates[1]; // Web > Node.js Server
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(2); // server.js + index.html
      for (const h of heredocs) await run(shell, h.shellCmd);

      const serverJs = await fs.readFile('/tmp/myapi/server.js', 'utf8') as string;
      expect(serverJs).toContain("require('express')");
      expect(serverJs).toContain('/api/time');
      expect(serverJs).toContain('/api/echo');
      expect(serverJs).toContain('/api/random');
      expect(serverJs).toContain('app.listen(3001');

      const indexHtml = await fs.readFile('/tmp/myapi/index.html', 'utf8') as string;
      expect(indexHtml).toContain('API Dashboard');
      expect(indexHtml).toContain('callApi');
      expect(indexHtml).toContain('/api/time');
    });
  });

  describe('Python template', () => {
    it('creates /tmp/lesson.py with educational content', async () => {
      const template = categories[1].templates[0]; // Languages > Python
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/lesson.py', 'utf8') as string;
      expect(content).toContain('import math');
      expect(content).toContain('fibonacci');
      expect(content).toContain('scores');
      expect(content).toContain('Sine wave');
    });
  });

  describe('TypeScript template', () => {
    it('creates /tmp/myts/app.ts with type annotations', async () => {
      const template = categories[1].templates[1]; // Languages > TypeScript
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/myts/app.ts', 'utf8') as string;
      expect(content).toContain('interface Person');
      expect(content).toContain('name: string');
      expect(content).toContain('function greet');
      expect(content).toContain('function first<T>');
    });
  });

  describe('C Program template', () => {
    it('creates /tmp/hello.c with structs and pointers', async () => {
      const template = categories[1].templates[2]; // Languages > C Program
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/hello.c', 'utf8') as string;
      expect(content).toContain('#include <stdio.h>');
      expect(content).toContain('typedef struct');
      expect(content).toContain('Student');
      expect(content).toContain('int *ptr');
    });
  });

  describe('SQLite template', () => {
    it('creates /tmp/setup.sql with SQL statements', async () => {
      const template = categories[2].templates[0]; // Tools > SQLite Database
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/setup.sql', 'utf8') as string;
      expect(content).toContain('CREATE TABLE');
      expect(content).toContain("INSERT INTO students VALUES ('Alice'");
      expect(content).toContain('SELECT');
      expect(content).toContain('GROUP BY');
    });
  });

  describe('React App template', () => {
    it('creates /tmp/myreact/index.html with React CDN and counter', async () => {
      const template = categories[0].templates[2]; // Web > React App
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/myreact/index.html', 'utf8') as string;
      expect(content).toContain('unpkg.com/react@18');
      expect(content).toContain('React.useState');
      expect(content).toContain('Counter');
      expect(content).toContain('ReactDOM.createRoot');
    });
  });

  describe('React + Routing template', () => {
    it('creates /tmp/myapp/index.html with routes and navigation', async () => {
      const template = categories[0].templates[3]; // Web > React + Routing
      const heredocs = extractHeredocs(template.cmd);
      expect(heredocs.length).toBe(1);
      for (const h of heredocs) await run(shell, h.shellCmd);

      const content = await fs.readFile('/tmp/myapp/index.html', 'utf8') as string;
      expect(content).toContain('unpkg.com/react@18');
      expect(content).toContain('hashchange');
      expect(content).toContain("routes");
      expect(content).toContain('Home');
      expect(content).toContain('CounterPage');
      expect(content).toContain('About');
    });
  });

  describe('Shell Tutorial template', () => {
    it('creates CSV files and runs shell commands', async () => {
      const template = categories[2].templates[1]; // Tools > Shell Tutorial

      // Shell Tutorial uses echo+redirect (no heredocs), run line by line
      const lines = template.cmd.split('\n');
      let output = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const result = await run(shell, trimmed);
        output += result.output;
      }

      // Check files were created
      const content = await fs.readFile('/tmp/tutorial/people.csv', 'utf8') as string;
      expect(content).toContain('Alice,25,Engineer');
      expect(content).toContain('Eve,22,Developer');

      // Check output contains tutorial sections
      expect(output).toContain('cat: read files');
      expect(output).toContain('grep: search for patterns');
      expect(output).toContain('Developer');
      expect(output).toContain('wc: count lines');

      // Sorted file should exist
      const sorted = await fs.readFile('/tmp/tutorial/sorted.csv', 'utf8') as string;
      expect(sorted).toContain('Alice');
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
});
