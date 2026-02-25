import type { Candidate } from './types';

/** Curated test repos per platform */
export const candidates: Candidate[] = [
  // --- Static HTML (index.html at root, no build step) ---
  { user: 'gabrielecirulli', repo: '2048', expectedKind: 'static', description: '2048 puzzle game' },
  { user: 'doublespeakgames', repo: 'adarkroom', expectedKind: 'static', description: 'Text adventure RPG' },
  { user: '1j01', repo: 'jspaint', expectedKind: 'static', description: 'MS Paint clone' },
  { user: 'ncase', repo: 'trust', expectedKind: 'static', description: 'Game theory interactive' },
  { user: 'ncase', repo: 'loopy', expectedKind: 'static', description: 'Systems thinking tool' },
  { user: 'jackschaedler', repo: 'circles-sines-signals', expectedKind: 'static', description: 'DSP visualization' },
  { user: 'muan', repo: 'emoji-minesweeper', expectedKind: 'static', description: 'Minesweeper with emoji' },
  { user: 'jakesgordon', repo: 'javascript-tetris', expectedKind: 'static', description: 'Tetris game' },
  { user: 'nebez', repo: 'floppybird', expectedKind: 'static', description: 'Flappy Bird clone' },
  { user: 'ncase', repo: 'anxiety', expectedKind: 'static', description: 'Interactive story' },
  { user: 'dionyziz', repo: 'canvas-tetris', expectedKind: 'static', description: 'Canvas tetris' },
  { user: 'ncase', repo: 'fireflies', expectedKind: 'static', description: 'Emergence simulation' },

  // --- Node.js Web (package.json with web deps or start/dev scripts) ---
  { user: 'tastejs', repo: 'todomvc', expectedKind: 'node-web', description: 'TodoMVC examples' },
  { user: 'vuejs', repo: 'petite-vue', expectedKind: 'node-web', description: 'Lightweight Vue' },
  { user: 'sveltejs', repo: 'template', expectedKind: 'node-web', description: 'Svelte starter (archived)' },
  { user: 'jackrugile', repo: '3d-particle-explorations', expectedKind: 'node-web', description: '3D particle demo' },

  // --- Node.js CLI (package.json with main/bin, runnable output) ---
  { user: 'kroitor', repo: 'asciichart', expectedKind: 'node-cli', description: 'ASCII sine wave charts' },
  { user: 'piuccio', repo: 'cowsay', expectedKind: 'node-cli', description: 'ASCII cow art' },
  { user: 'patorjk', repo: 'figlet.js', expectedKind: 'node-cli', description: 'ASCII art text' },
  { user: 'bokub', repo: 'gradient-string', expectedKind: 'node-cli', description: 'Gradient terminal text' },

  // --- Python (pyproject.toml / requirements.txt) ---
  { user: 'Textualize', repo: 'rich', expectedKind: 'python-cli', description: 'Rich test card (python -m rich)' },
  { user: 'tqdm', repo: 'tqdm', expectedKind: 'python-cli', description: 'Progress bars' },
  { user: 'bfontaine', repo: 'term2048', expectedKind: 'python-cli', description: 'Terminal 2048 game' },
  { user: 'TheAlgorithms', repo: 'Python', expectedKind: 'python-cli', description: 'Algorithm collection' },

  // --- C (.c files, Makefile) ---
  { user: 'TheAlgorithms', repo: 'C', expectedKind: 'c', description: 'Algorithms in C' },
  { user: 'antirez', repo: 'kilo', expectedKind: 'c', description: 'Tiny text editor (1000 lines)' },
  { user: 'orangeduck', repo: 'mpc', expectedKind: 'c', description: 'Parser combinator library' },
  { user: 'clibs', repo: 'clib', expectedKind: 'c', description: 'C package manager' },

  // --- Lua (.lua files) ---
  { user: 'mpeterv', repo: 'luacheck', expectedKind: 'lua', description: 'Lua linter CLI' },
  { user: 'kikito', repo: 'inspect.lua', expectedKind: 'lua', description: 'Lua pretty printer' },
  { user: 'rxi', repo: 'json.lua', expectedKind: 'lua', description: 'JSON parser in Lua' },
  { user: 'rxi', repo: 'lume', expectedKind: 'lua', description: 'Lua utility library' },
];
