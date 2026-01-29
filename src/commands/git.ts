import git from 'isomorphic-git';
// @ts-ignore - isomorphic-git http module
import http from 'isomorphic-git/http/web';
import { Command, CommandContext } from './index';

export const gitCmd: Command = {
  name: 'git',
  description: 'Version control system',
  async exec(ctx: CommandContext) {
    const subcommand = ctx.args[0];
    if (!subcommand) {
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, branch, checkout, clone\n';
      return 0;
    }

    const fs = ctx.fs.toIsomorphicGitFS();
    const dir = ctx.cwd;

    try {
      switch (subcommand) {
        case 'init': {
          // git init [directory] - optional directory argument
          let targetDir = dir;
          if (ctx.args[1]) {
            targetDir = ctx.fs.resolvePath(ctx.args[1], dir);
            await ctx.fs.mkdir(targetDir, { recursive: true });
          }
          // Pre-create .git directory for isomorphic-git compatibility
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          try {
            await ctx.fs.mkdir(gitDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
          await git.init({ fs, dir: targetDir });
          ctx.stdout = `Initialized empty Git repository in ${targetDir}/.git/\n`;
          break;
        }

        case 'add': {
          const paths = ctx.args.slice(1);
          if (paths.length === 0 || paths.includes('.')) {
            // Add all files
            const allFiles = await listAllFiles(ctx.fs, dir, dir);
            for (const filepath of allFiles) {
              await git.add({ fs, dir, filepath });
            }
          } else {
            for (const filepath of paths) {
              await git.add({ fs, dir, filepath });
            }
          }
          break;
        }

        case 'commit': {
          let message = '';
          for (let i = 1; i < ctx.args.length; i++) {
            if ((ctx.args[i] === '-m' || ctx.args[i] === '--message') && ctx.args[i + 1]) {
              message = ctx.args[++i];
            }
          }
          if (!message) {
            ctx.stderr = 'error: must supply commit message with -m\n';
            return 1;
          }
          const sha = await git.commit({
            fs, dir, message,
            author: { name: ctx.env['USER'] || 'user', email: 'user@shiro.local' },
          });
          ctx.stdout = `[main ${sha.slice(0, 7)}] ${message}\n`;
          break;
        }

        case 'status': {
          const matrix = await git.statusMatrix({ fs, dir });
          const STATUS_MAP: Record<string, string> = {
            '003': 'added',     // new file, staged
            '020': 'deleted',   // deleted, not staged
            '023': 'deleted',   // deleted, staged
            '100': 'deleted',   // HEAD has it, workdir deleted
            '101': 'deleted',
            '103': 'modified',
            '110': 'deleted',
            '111': '',          // unmodified
            '120': 'modified',
            '121': 'modified',
            '122': 'modified',
            '123': 'modified',
          };

          let hasChanges = false;
          const staged: string[] = [];
          const unstaged: string[] = [];
          const untracked: string[] = [];

          for (const [filepath, head, workdir, stage] of matrix) {
            const key = `${head}${workdir}${stage}`;
            if (key === '111') continue;
            hasChanges = true;
            if (head === 0 && workdir === 2 && stage === 0) {
              untracked.push(filepath as string);
            } else if (stage === 3 || (head === 0 && stage === 2)) {
              staged.push(`${STATUS_MAP[key] || 'modified'}:   ${filepath}`);
            } else if (stage === 0 || workdir !== stage) {
              unstaged.push(`${STATUS_MAP[key] || 'modified'}:   ${filepath}`);
            }
          }

          ctx.stdout = `On branch main\n`;
          if (staged.length > 0) {
            ctx.stdout += `\nChanges to be committed:\n`;
            for (const s of staged) ctx.stdout += `\t${s}\n`;
          }
          if (unstaged.length > 0) {
            ctx.stdout += `\nChanges not staged for commit:\n`;
            for (const s of unstaged) ctx.stdout += `\t${s}\n`;
          }
          if (untracked.length > 0) {
            ctx.stdout += `\nUntracked files:\n`;
            for (const f of untracked) ctx.stdout += `\t${f}\n`;
          }
          if (!hasChanges) {
            ctx.stdout += `\nnothing to commit, working tree clean\n`;
          }
          break;
        }

        case 'log': {
          let maxCount = 10;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '-n' && ctx.args[i + 1]) maxCount = parseInt(ctx.args[++i]);
            if (ctx.args[i]?.startsWith('--max-count=')) maxCount = parseInt(ctx.args[i].split('=')[1]);
          }
          const commits = await git.log({ fs, dir, depth: maxCount });
          for (const c of commits) {
            ctx.stdout += `commit ${c.oid}\n`;
            ctx.stdout += `Author: ${c.commit.author.name} <${c.commit.author.email}>\n`;
            const date = new Date(c.commit.author.timestamp * 1000);
            ctx.stdout += `Date:   ${date.toISOString()}\n`;
            ctx.stdout += `\n    ${c.commit.message.trim()}\n\n`;
          }
          break;
        }

        case 'diff': {
          const matrix = await git.statusMatrix({ fs, dir });
          for (const [filepath, head, workdir, _stage] of matrix) {
            if (head === workdir) continue;
            if (head === 0 && workdir === 2) {
              // New file
              const content = await ctx.fs.readFile(ctx.fs.resolvePath(filepath as string, dir), 'utf8');
              ctx.stdout += `diff --git a/${filepath} b/${filepath}\n`;
              ctx.stdout += `new file\n`;
              ctx.stdout += `--- /dev/null\n`;
              ctx.stdout += `+++ b/${filepath}\n`;
              const lines = (content as string).split('\n');
              ctx.stdout += `@@ -0,0 +1,${lines.length} @@\n`;
              for (const line of lines) ctx.stdout += `+${line}\n`;
            } else if (workdir === 0) {
              ctx.stdout += `diff --git a/${filepath} b/${filepath}\n`;
              ctx.stdout += `deleted file\n`;
            } else {
              ctx.stdout += `diff --git a/${filepath} b/${filepath}\n`;
              ctx.stdout += `--- a/${filepath}\n`;
              ctx.stdout += `+++ b/${filepath}\n`;
              ctx.stdout += `(binary diff not shown)\n`;
            }
          }
          if (!ctx.stdout) ctx.stdout = '';
          break;
        }

        case 'branch': {
          const branches = await git.listBranches({ fs, dir });
          const current = await git.currentBranch({ fs, dir });
          for (const b of branches) {
            ctx.stdout += (b === current ? '* ' : '  ') + b + '\n';
          }
          break;
        }

        case 'clone': {
          let url = ctx.args[1];
          if (!url) { ctx.stderr = 'error: must specify repository URL\n'; return 1; }
          // Normalize URL: add https:// if no protocol
          if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git://')) {
            url = 'https://' + url;
          }
          const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
          const targetDir = ctx.args[2]
            ? ctx.fs.resolvePath(ctx.args[2], ctx.cwd)
            : ctx.fs.resolvePath(repoName, ctx.cwd);
          await ctx.fs.mkdir(targetDir, { recursive: true });
          // Pre-create .git directory for isomorphic-git compatibility
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          try {
            await ctx.fs.mkdir(gitDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
          ctx.stdout = `Cloning into '${repoName}'...\n`;
          await git.clone({
            fs, http, dir: targetDir, url,
            corsProxy: 'https://cors.isomorphic-git.org',
            singleBranch: true,
            depth: 1,
          });
          ctx.stdout += `done.\n`;
          break;
        }

        default:
          ctx.stderr = `git: '${subcommand}' is not a git command\n`;
          return 1;
      }
    } catch (e: any) {
      ctx.stderr = `fatal: ${e.message}\n`;
      return 128;
    }

    return 0;
  },
};

async function listAllFiles(fs: any, dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === '.git') continue;
    const fullPath = dir === '/' ? '/' + entry : dir + '/' + entry;
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      files.push(...await listAllFiles(fs, fullPath, base));
    } else {
      // Return relative path from base
      files.push(fullPath.slice(base.length + 1));
    }
  }
  return files;
}
