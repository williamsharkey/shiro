/**
 * drop-handler.ts — Drag-and-drop seed GIF import
 *
 * Attaches listeners to #terminal. When a .gif is dropped, scans for
 * the SHIRO1.0 Application Extension. If found, shows a confirmation
 * prompt and triggers rehydration via the existing shiro-seed-v2 message.
 */

import type { ShiroTerminal } from './terminal';
import type { FileSystem } from './filesystem';
import { extractShiroSeed, type SeedData } from './gif-encoder';

export function initDropHandler(terminal: ShiroTerminal, _fs: FileSystem): void {
  const container = document.getElementById('terminal')!;

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.outline = '2px solid #51cf66';
    container.style.outlineOffset = '-2px';
  });

  container.addEventListener('dragleave', () => {
    container.style.outline = '';
    container.style.outlineOffset = '';
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.outline = '';
    container.style.outlineOffset = '';

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (file.type === 'image/gif' || file.name.endsWith('.gif')) {
        try {
          const buffer = await file.arrayBuffer();
          const seed = await extractShiroSeed(new Uint8Array(buffer));
          if (seed) {
            promptSeedRestore(terminal, seed);
            return;
          }
        } catch {
          // Not a valid seed GIF — silently ignore
        }
      }
    }
  });
}

async function promptSeedRestore(terminal: ShiroTerminal, seed: SeedData): Promise<void> {
  const term = terminal.term;
  const date = new Date(seed.timestamp).toLocaleString();
  const sizeMB = (seed.totalBytes / (1024 * 1024)).toFixed(2);

  term.writeln('');
  term.writeln('\x1b[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\x1b[0m');
  term.writeln('\x1b[36m\u2551\x1b[0m  \x1b[1;97mShiro Snapshot Detected\x1b[0m                 \x1b[36m\u2551\x1b[0m');
  term.writeln('\x1b[36m\u2551\x1b[0m                                          \x1b[36m\u2551\x1b[0m');
  term.writeln(`\x1b[36m\u2551\x1b[0m  Files: ${String(seed.files).padEnd(8)} Size: ${sizeMB.padEnd(8)} MB   \x1b[36m\u2551\x1b[0m`);
  term.writeln(`\x1b[36m\u2551\x1b[0m  From:  ${seed.hostname.slice(0, 30).padEnd(30)}  \x1b[36m\u2551\x1b[0m`);
  term.writeln(`\x1b[36m\u2551\x1b[0m  Date:  ${date.slice(0, 30).padEnd(30)}  \x1b[36m\u2551\x1b[0m`);
  term.writeln('\x1b[36m\u2551\x1b[0m                                          \x1b[36m\u2551\x1b[0m');
  term.writeln('\x1b[36m\u2551\x1b[0m  \x1b[33mThis will replace all current files.\x1b[0m     \x1b[36m\u2551\x1b[0m');
  term.writeln('\x1b[36m\u2551\x1b[0m  Type \x1b[1;97mrestore\x1b[0m to confirm.                \x1b[36m\u2551\x1b[0m');
  term.writeln('\x1b[36m\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\x1b[0m');
  term.write('\x1b[33m> \x1b[0m');

  // Temporarily set running=true so waitForUserInput() works
  // (it routes keystrokes to the userInput handler instead of shell)
  (terminal as any).running = true;
  try {
    const response = await terminal.waitForUserInput();
    if (response.trim().toLowerCase() === 'restore') {
      term.writeln('\x1b[92mRestoring...\x1b[0m');
      window.postMessage({
        type: 'shiro-seed-v2',
        ndjson: seed.ndjson,
        storage: seed.storage,
      }, '*');
    } else {
      term.writeln('Cancelled.');
    }
  } finally {
    (terminal as any).running = false;
  }
}
