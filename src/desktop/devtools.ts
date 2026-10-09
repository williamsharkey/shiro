/**
 * The dock's Developer and AI agents stacks (docs/DESKTOP.md "Developer
 * tools"; measured in docs/research/DEV-TOOLS.md and docs/COMPAT.md "Agent
 * CLIs"). Each entry installs on first use in its own Terminal window, which
 * shows the install command, its usual time and its progress, then runs the
 * program; later clicks just run it.
 */

export type DevGroup = 'developer' | 'agents';

export interface DevTool {
  id: string;
  name: string;
  group: DevGroup;
  /** Dock order (stacks sit at their first member) */
  order: number;
  /** Executables that mean "installed" (looked up on PATH by the launch script) */
  bins: string[];
  /** Shell command that installs it; none: always there */
  install?: string;
  /** What runs it, in a Terminal window (unless `window`) */
  run: string;
  /** The usual first-install time, shown while installing */
  time?: string;
  /** One line shown before it starts (keys, sign-in, caveats) */
  note?: string;
  /** Opens its own desktop window (a builtin), not a Terminal */
  window?: boolean;
}

const DEBIAN = 'debian install && sudo apt install -y';

export const DEV_TOOLS: DevTool[] = [
  // Developer: nano, Vim, Code and Git loose (DEV-TOOLS.md "Proposal"), the rest stacked
  { id: 'nano', name: 'nano', group: 'developer', order: 40, bins: ['nano'], install: 'pkg install nano', run: 'nano', time: 'about 1 s' },
  { id: 'vim', name: 'Vim', group: 'developer', order: 41, bins: ['vim'], install: 'pkg install vim', run: 'vim', time: 'about 2 s' },
  { id: 'code', name: 'Code', group: 'developer', order: 42, bins: [], run: 'code ~', window: true },
  { id: 'git', name: 'Git', group: 'developer', order: 43, bins: [], run: '', window: true },
  { id: 'neovim', name: 'Neovim', group: 'developer', order: 44, bins: ['nvim'], install: 'pkg install neovim', run: 'nvim', time: 'about 2 s, first start 7 s' },
  { id: 'emacs', name: 'Emacs', group: 'developer', order: 45, bins: ['emacs'], install: 'pkg install emacs', run: 'emacs -nw', time: 'about 3 s (26 MB), first start 9 s' },
  { id: 'geany', name: 'Geany', group: 'developer', order: 46, bins: ['geany'], install: `${DEBIAN} geany`, run: 'DISPLAY=:0 geany &', time: 'several minutes (Debian), then 30 s to its window', note: 'Geany is a Debian program: the first install sets up Debian mode.' },
  { id: 'tmux', name: 'tmux', group: 'developer', order: 47, bins: ['tmux'], install: 'pkg install tmux', run: 'tmux', time: 'a few seconds' },
  // AI agents: fastest round trips first, aider last (COMPAT.md); the keys are the user's own
  { id: 'claude', name: 'Claude Code', group: 'agents', order: 50, bins: [], run: 'claude', note: 'Sign in with your Claude account when it asks (or in Settings → Accounts).' },
  { id: 'gemini', name: 'Gemini CLI', group: 'agents', order: 51, bins: ['gemini'], install: 'npm i -g @google/gemini-cli', run: 'gemini', time: 'a few seconds', note: 'Needs a Gemini API key (GEMINI_API_KEY) or a Google sign-in.' },
  { id: 'codex', name: 'Codex', group: 'agents', order: 52, bins: ['codex'], install: 'npm i -g @openai/codex', run: 'codex --sandbox danger-full-access', time: 'under a minute (294 MB)', note: 'Needs an OpenAI API key (OPENAI_API_KEY) or a ChatGPT sign-in. No bubblewrap here, so it runs without its sandbox.' },
  { id: 'grok', name: 'Grok', group: 'agents', order: 53, bins: ['grok'], install: 'curl -fsSL https://x.ai/cli/install.sh | sh', run: 'grok', time: 'under a minute (183 MB)', note: 'Needs an xAI API key (XAI_API_KEY).' },
  { id: 'agy', name: 'Antigravity', group: 'agents', order: 54, bins: ['agy'], install: 'curl -fsSL https://antigravity.google/cli/install.sh | sh', run: 'agy', time: 'about a minute (211 MB)', note: 'Needs a Google sign-in.' },
  { id: 'aider', name: 'aider', group: 'agents', order: 55, bins: ['aider'], install: 'debian install && pkg install curl && curl -LsSf https://aider.chat/install.sh | sh', run: 'aider', time: 'slow: about 10 minutes, first run 6 more', note: 'Needs a model API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, …).' },
];

/** Groups: name, dock order, and the members shown loose even when the rest is stacked */
export const DEV_GROUPS = [
  { id: 'developer', name: 'Developer', order: 40, maxLoose: 4, loose: ['nano', 'vim', 'code', 'git'] },
  { id: 'agents', name: 'AI agents', order: 50, maxLoose: 2, loose: ['claude'] },
] as const;

/** Directories the dock checks for a tool's executables (where pkg, npm -g and the install scripts put them) */
export const TOOL_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/home/user/.local/bin', '/home/user/bin', '/home/user/.npm-global/bin', '/usr/local/lib/node_modules/.bin'];

/** Single-quote for the shell */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Terminal command for a tool: install if none of its executables is on
 * PATH (saying what, how long, and why), then run it. Safe to run every time.
 */
export function launchScript(t: DevTool): string {
  const say = (s: string) => `printf '%s\\n' ${shq(s)}`;
  const note = t.note ? `${say(t.note)}; ` : '';
  if (!t.install || !t.bins.length) return `${note}${t.run}`;
  const missing = t.bins.map(b => `! command -v ${b} >/dev/null 2>&1`).join(' && ');
  const head = `${t.name} isn't installed yet: ${t.install}${t.time ? ` (${t.time})` : ''}`;
  return `if ${missing}; then ${say(head)}; ${note}${t.install} || { ${say(`Installing ${t.name} failed; the output above says why.`)}; false; }; fi && ${t.run}`;
}
