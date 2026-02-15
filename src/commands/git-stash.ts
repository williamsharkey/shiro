import git from 'isomorphic-git';
import { CommandContext } from './index';

interface StashEntry {
  message: string;
  timestamp: number;
  changes: { filepath: string; content: string | null; status: string }[];
}

export async function gitStashHandler(ctx: CommandContext, fs: any, dir: string): Promise<number> {
  const sub = ctx.args[1] || 'push';
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

  async function nextIndex(): Promise<number> {
    const entries = await listEntries();
    return entries.length > 0 ? entries[0].index + 1 : 0;
  }

  switch (sub) {
    case 'push':
    case 'save': {
      let message = 'WIP';
      for (let i = 2; i < ctx.args.length; i++) {
        if ((ctx.args[i] === '-m' || ctx.args[i] === '--message') && ctx.args[i + 1]) {
          message = ctx.args[++i];
        }
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
        ctx.stdout = 'No local changes to save\n';
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
            await git.checkout({ fs, dir, ref: 'HEAD', filepaths: [change.filepath], force: true });
          } catch {}
        }
      }

      ctx.stdout = `Saved working directory and index state: ${message}\n`;
      return 0;
    }

    case 'pop': {
      const popIdx = ctx.args[2] ? parseInt(ctx.args[2], 10) : undefined;
      const entries = await listEntries();
      if (entries.length === 0) {
        ctx.stderr = 'No stash entries\n';
        return 1;
      }
      const target = popIdx !== undefined
        ? entries.find(e => e.index === popIdx)
        : entries[0];
      if (!target) {
        ctx.stderr = `stash@{${popIdx}} not found\n`;
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

      ctx.stdout = `Restored stash@{${target.index}}: ${target.entry.message}\n`;
      return 0;
    }

    case 'apply': {
      const applyIdx = ctx.args[2] ? parseInt(ctx.args[2], 10) : undefined;
      const entries = await listEntries();
      if (entries.length === 0) {
        ctx.stderr = 'No stash entries\n';
        return 1;
      }
      const target = applyIdx !== undefined
        ? entries.find(e => e.index === applyIdx)
        : entries[0];
      if (!target) {
        ctx.stderr = `stash@{${applyIdx}} not found\n`;
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

      ctx.stdout = `Applied stash@{${target.index}}: ${target.entry.message}\n`;
      return 0;
    }

    case 'list': {
      const entries = await listEntries();
      if (entries.length === 0) {
        ctx.stdout = '';
        return 0;
      }
      for (const { index, entry } of entries) {
        ctx.stdout += `stash@{${index}}: ${entry.message}\n`;
      }
      return 0;
    }

    case 'drop': {
      const dropIdx = ctx.args[2] ? parseInt(ctx.args[2], 10) : undefined;
      const entries = await listEntries();
      if (entries.length === 0) {
        ctx.stderr = 'No stash entries\n';
        return 1;
      }
      const target = dropIdx !== undefined
        ? entries.find(e => e.index === dropIdx)
        : entries[0];
      if (!target) {
        ctx.stderr = `stash@{${dropIdx}} not found\n`;
        return 1;
      }
      try { await ctx.fs.unlink(`${stashDir}/stash-${target.index}.json`); } catch {}
      ctx.stdout = `Dropped stash@{${target.index}}\n`;
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
