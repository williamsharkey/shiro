import git from 'isomorphic-git';
import { CommandContext } from './index';

export async function gitTagHandler(ctx: CommandContext, fs: any, dir: string): Promise<number> {
  let deleteMode = false;
  let listPattern = '';
  let listMode = false;
  const positional: string[] = [];

  for (let i = 1; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '-d' || a === '--delete') deleteMode = true;
    else if (a === '-l' || a === '--list') {
      listMode = true;
      if (ctx.args[i + 1] && !ctx.args[i + 1].startsWith('-')) {
        listPattern = ctx.args[++i];
      }
    }
    else if (!a.startsWith('-')) positional.push(a);
  }

  // Delete mode
  if (deleteMode) {
    if (positional.length === 0) {
      ctx.stderr = 'fatal: tag name required\n';
      return 1;
    }
    for (const tagName of positional) {
      try {
        await git.deleteTag({ fs, dir, ref: tagName });
        ctx.stdout += `Deleted tag '${tagName}'\n`;
      } catch (e: any) {
        ctx.stderr += `error: tag '${tagName}' not found: ${e.message}\n`;
        return 1;
      }
    }
    return 0;
  }

  // Create mode: git tag <name> [ref]
  if (positional.length > 0 && !listMode) {
    const tagName = positional[0];
    const ref = positional[1] || 'HEAD';
    let oid: string;
    try {
      oid = await git.resolveRef({ fs, dir, ref });
    } catch {
      try {
        oid = await git.expandOid({ fs, dir, oid: ref });
      } catch {
        ctx.stderr = `fatal: bad revision '${ref}'\n`;
        return 128;
      }
    }
    await git.tag({ fs, dir, ref: tagName, object: oid });
    ctx.stdout = '';
    return 0;
  }

  // List mode (default)
  const tags = await git.listTags({ fs, dir });
  if (listPattern) {
    const re = new RegExp('^' + listPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    for (const t of tags) {
      if (re.test(t)) ctx.stdout += t + '\n';
    }
  } else {
    for (const t of tags) ctx.stdout += t + '\n';
  }
  return 0;
}
