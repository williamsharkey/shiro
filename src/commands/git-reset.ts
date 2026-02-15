import git from 'isomorphic-git';
import { CommandContext } from './index';

export async function gitResetHandler(ctx: CommandContext, fs: any, dir: string): Promise<number> {
  let mode: 'soft' | 'mixed' | 'hard' = 'mixed';
  const paths: string[] = [];
  let ref = '';
  let afterDash = false;

  for (let i = 1; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '--soft') mode = 'soft';
    else if (a === '--mixed') mode = 'mixed';
    else if (a === '--hard') mode = 'hard';
    else if (a === '--') { afterDash = true; }
    else if (afterDash) { paths.push(a); }
    else if (!a.startsWith('-')) {
      // Could be a ref or a path — try ref first
      if (!ref) ref = a;
      else paths.push(a);
    }
  }

  // If paths are given (git reset [ref] -- path1 path2), unstage those files
  if (paths.length > 0) {
    for (const filepath of paths) {
      try {
        await git.resetIndex({ fs, dir, filepath });
      } catch (e: any) {
        ctx.stderr += `error: pathspec '${filepath}': ${e.message}\n`;
      }
    }
    return 0;
  }

  // If no ref, unstage with no ref change (like git reset HEAD -- .)
  if (!ref) ref = 'HEAD';

  // Resolve the target commit
  let targetOid: string;
  try {
    // Handle HEAD~N syntax
    const tildaMatch = ref.match(/^(.+?)~(\d+)$/);
    if (tildaMatch) {
      let oid = await git.resolveRef({ fs, dir, ref: tildaMatch[1] });
      const count = parseInt(tildaMatch[2], 10);
      for (let i = 0; i < count; i++) {
        const { commit } = await git.readCommit({ fs, dir, oid });
        if (!commit.parent || commit.parent.length === 0) {
          ctx.stderr = `fatal: revision '${ref}' has no parent\n`;
          return 128;
        }
        oid = commit.parent[0];
      }
      targetOid = oid;
    } else {
      targetOid = await git.resolveRef({ fs, dir, ref });
    }
  } catch {
    try {
      targetOid = await git.expandOid({ fs, dir, oid: ref });
    } catch {
      ctx.stderr = `fatal: bad revision '${ref}'\n`;
      return 128;
    }
  }

  const currentBranch = await git.currentBranch({ fs, dir }) || 'main';

  if (mode === 'soft') {
    // Only move HEAD — don't touch index or working tree
    await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: targetOid, force: true });
    ctx.stdout = `HEAD is now at ${targetOid.slice(0, 7)}\n`;
    return 0;
  }

  if (mode === 'mixed') {
    // Move HEAD + reset index
    await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: targetOid, force: true });
    // Reset index for all tracked files
    const matrix = await git.statusMatrix({ fs, dir });
    for (const [filepath] of matrix) {
      try {
        await git.resetIndex({ fs, dir, filepath: filepath as string, ref: targetOid });
      } catch {}
    }
    ctx.stdout = `HEAD is now at ${targetOid.slice(0, 7)}\n`;
    return 0;
  }

  if (mode === 'hard') {
    // Move HEAD + reset index + checkout working tree
    await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: targetOid, force: true });
    try {
      await git.checkout({ fs, dir, ref: currentBranch, force: true });
    } catch {}
    ctx.stdout = `HEAD is now at ${targetOid.slice(0, 7)}\n`;
    return 0;
  }

  return 0;
}
