import git from './git-cached';
import { CommandContext } from './index';

interface StashEntry {
  message: string;
  timestamp: number;
  changes: { filepath: string; content: string | null; status: string }[];
}

export async function gitStashHandler(ctx: CommandContext, fs: any, dir: string): Promise<number> {
  // `git stash -q`, `git stash -m msg`: push with options
  const explicit = ctx.args[1] && !ctx.args[1].startsWith('-');
  const sub = explicit ? ctx.args[1] : 'push';
  const opts = ctx.args.slice(explicit ? 2 : 1);
  const quiet = opts.includes('-q') || opts.includes('--quiet');
  const stashDir = `${dir}/.git/refs/stash`;

  async function ensureStashDir() {
    try { await ctx.fs.mkdir(stashDir, { recursive: true }); } catch {}
  }

  async function listEntries(): Promise<{ index: number; entry: StashEntry }[]> {
    await ensureStashDir();
    let files: string[];
    try { files = await ctx.fs.readdir(stashDir); } catch { return []; }
    const entries: { index: number; entry: StashEntry }[] = [];
    for (const f of files) {
      if (!f.startsWith('stash-')) continue;
      const idx = parseInt(f.replace('stash-', '').replace('.json', ''), 10);
      try {
        const raw = await ctx.fs.readFile(`${stashDir}/${f}`, 'utf8') as string;
        entries.push({ index: idx, entry: JSON.parse(raw) });
      } catch {}
    }
    entries.sort((a, b) => b.index - a.index);
    return entries;
  }

  /** stash@{N} (or N) counts from the newest, as git's reflog does */
  async function pick(): Promise<{ index: number; entry: StashEntry; n: number } | string> {
    const entries = await listEntries();
    if (entries.length === 0) return 'No stash entries found.';
    const arg = opts.find(a => !a.startsWith('-'));
    const m = arg?.match(/^(?:stash@\{(\d+)\}|(\d+))$/);
    const n = arg === undefined ? 0 : m ? +(m[1] ?? m[2]) : -1;
    if (n < 0 || n >= entries.length) return `error: ${arg} is not a valid reference`;
    return { ...entries[n], n };
  }

  async function nextIndex(): Promise<number> {
    const entries = await listEntries();
    return entries.length > 0 ? entries[0].index + 1 : 0;
  }

  switch (sub) {
    case 'push':
    case 'save': {
      let given = '';
      for (let i = 0; i < opts.length; i++) {
        if ((opts[i] === '-m' || opts[i] === '--message') && opts[i + 1] !== undefined) given = opts[++i];
        else if (opts[i].startsWith('--message=')) given = opts[i].slice(10);
        else if (sub === 'save' && !opts[i].startsWith('-')) given = opts.slice(i).join(' ');
      }
      const branch = await git.currentBranch({ fs, dir }).catch(() => undefined) || '(no branch)';
      let message = `On ${branch}: ${given}`;
      if (!given) {
        let head = '';
        try {
          const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          const { commit } = await git.readCommit({ fs, dir, oid });
          head = `${oid.slice(0, 7)} ${commit.message.split('\n')[0]}`;
        } catch {}
        message = `WIP on ${branch}: ${head}`;
      }

      const matrix = await git.statusMatrix({ fs, dir });
      const changes: StashEntry['changes'] = [];

      for (const [filepath, head, workdir, stage] of matrix) {
        const key = `${head}${workdir}${stage}`;
        if (key === '111') continue;
        // Save file content
        let content: string | null = null;
        try {
          const fullPath = ctx.fs.resolvePath(filepath as string, dir);
          content = await ctx.fs.readFile(fullPath, 'utf8') as string;
        } catch {}
        changes.push({ filepath: filepath as string, content, status: key });
      }

      if (changes.length === 0) {
        if (!quiet) ctx.stdout = 'No local changes to save\n';
        return 0;
      }

      // Save stash entry
      await ensureStashDir();
      const idx = await nextIndex();
      const entry: StashEntry = { message, timestamp: Date.now(), changes };
      await ctx.fs.writeFile(`${stashDir}/stash-${idx}.json`, JSON.stringify(entry));

      // Restore files to HEAD state
      for (const change of changes) {
        const fullPath = ctx.fs.resolvePath(change.filepath, dir);
        if (change.status.startsWith('0')) {
          // Was untracked or added — delete the file
          try { await ctx.fs.unlink(fullPath); } catch {}
        } else {
          // Was modified or deleted — checkout from HEAD
          try {
            await git.checkout({ fs, dir, ref: 'HEAD', filepaths: [change.filepath], force: true, noUpdateHead: true });
          } catch {}
        }
      }

      if (!quiet) ctx.stdout = `Saved working directory and index state ${message}\n`;
      return 0;
    }

    case 'pop': {
      const target = await pick();
      if (typeof target === 'string') {
        ctx.stderr = target + '\n';
        return 1;
      }

      // Restore files
      for (const change of target.entry.changes) {
        const fullPath = ctx.fs.resolvePath(change.filepath, dir);
        if (change.content !== null) {
          // Ensure parent directory exists
          const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
          try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch {}
          await ctx.fs.writeFile(fullPath, change.content);
        }
      }

      // Remove stash entry
      try { await ctx.fs.unlink(`${stashDir}/stash-${target.index}.json`); } catch {}

      if (!quiet) ctx.stdout = `Dropped refs/stash@{${target.n}}\n`;
      return 0;
    }

    case 'apply': {
      const target = await pick();
      if (typeof target === 'string') {
        ctx.stderr = target + '\n';
        return 1;
      }

      for (const change of target.entry.changes) {
        const fullPath = ctx.fs.resolvePath(change.filepath, dir);
        if (change.content !== null) {
          const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
          try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch {}
          await ctx.fs.writeFile(fullPath, change.content);
        }
      }

      
      return 0;
    }

    case 'list': {
      const entries = await listEntries();
      let format = '%gd: %gs', nul = false;
      for (const a of opts) {
        const f = a.match(/^--(?:pretty|format)=(?:t?format:)?(.*)$/s);
        if (f) format = f[1] === 'oneline' ? '%gd: %gs' : f[1];
        else if (a === '-z') nul = true;
        else if (a === '--oneline') format = '%h %gs';
      }
      ctx.stdout = entries.map(({ entry }, n) => formatStash(format, n, entry)).join(nul ? '\0' : '\n') + (entries.length ? (nul ? '\0' : '\n') : '');
      return 0;
    }

    case 'drop': {
      const target = await pick();
      if (typeof target === 'string') {
        ctx.stderr = target + '\n';
        return 1;
      }
      try { await ctx.fs.unlink(`${stashDir}/stash-${target.index}.json`); } catch {}
      if (!quiet) ctx.stdout = `Dropped stash@{${target.n}}\n`;
      return 0;
    }

    case 'clear': {
      const entries = await listEntries();
      for (const { index } of entries) {
        try { await ctx.fs.unlink(`${stashDir}/stash-${index}.json`); } catch {}
      }
      ctx.stdout = '';
      return 0;
    }

    default:
      ctx.stderr = `git stash: '${sub}' is not a valid subcommand. Valid: push, pop, apply, list, drop, clear\n`;
      return 1;
  }
}

/** A stash entry in `git stash list --format` (the reflog atoms and the dates; no commit behind it) */
function formatStash(format: string, n: number, entry: StashEntry): string {
  const secs = Math.floor(entry.timestamp / 1000);
  const ago = () => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    for (const [u, s] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
      if (d >= s) { const k = Math.floor(d / s); return `${k} ${u}${k > 1 ? 's' : ''} ago`; }
    }
    return `${d} seconds ago`;
  };
  const subject = entry.message.replace(/^(WIP on|On) [^:]*: /, '');
  return format.replace(/%(gd|gD|gs|gn|ge|[ac][trdDI]|[sHhn%]|x[0-9a-fA-F]{2})/g, (_, k: string) => {
    if (k === 'gd' || k === 'gD') return `stash@{${n}}`;
    if (k === 'gs') return entry.message;
    if (k === 's') return subject;
    if (k === 'n') return '\n';
    if (k === '%') return '%';
    if (k[0] === 'x') return String.fromCharCode(parseInt(k.slice(1), 16));
    if (k[1] === 't') return String(secs);
    if (k[1] === 'r') return ago();
    if (k[1] === 'I') return new Date(entry.timestamp).toISOString().replace('.000Z', '+00:00');
    if (k[1] === 'd' || k[1] === 'D') return new Date(entry.timestamp).toUTCString();
    return '';
  });
}
