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
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, branch, checkout, clone\n  push, pull, fetch, remote, merge\n';
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
          let oneline = false;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '-n' && ctx.args[i + 1]) maxCount = parseInt(ctx.args[++i]);
            if (ctx.args[i]?.startsWith('--max-count=')) maxCount = parseInt(ctx.args[i].split('=')[1]);
            if (ctx.args[i] === '--oneline') oneline = true;
          }
          const commits = await git.log({ fs, dir, depth: maxCount });
          for (const c of commits) {
            if (oneline) {
              ctx.stdout += `${c.oid.slice(0, 7)} ${c.commit.message.trim()}\n`;
            } else {
              ctx.stdout += `commit ${c.oid}\n`;
              ctx.stdout += `Author: ${c.commit.author.name} <${c.commit.author.email}>\n`;
              const date = new Date(c.commit.author.timestamp * 1000);
              ctx.stdout += `Date:   ${date.toISOString()}\n`;
              ctx.stdout += `\n    ${c.commit.message.trim()}\n\n`;
            }
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

        case 'checkout': {
          const target = ctx.args[1];
          if (!target) {
            ctx.stderr = 'error: must specify branch or path\n';
            return 1;
          }
          // Check if -b flag (create new branch)
          if (target === '-b') {
            const newBranch = ctx.args[2];
            if (!newBranch) {
              ctx.stderr = 'error: must specify new branch name\n';
              return 1;
            }
            await git.branch({ fs, dir, ref: newBranch, checkout: true });
            ctx.stdout = `Switched to a new branch '${newBranch}'\n`;
          } else {
            // Try as branch first
            const branches = await git.listBranches({ fs, dir });
            if (branches.includes(target)) {
              await git.checkout({ fs, dir, ref: target });
              ctx.stdout = `Switched to branch '${target}'\n`;
            } else {
              // Try as file restore (checkout -- file)
              const filepath = target === '--' ? ctx.args[2] : target;
              if (!filepath) {
                ctx.stderr = `error: pathspec '${target}' did not match any branch or file\n`;
                return 1;
              }
              await git.checkout({ fs, dir, ref: 'HEAD', filepaths: [filepath], force: true });
              ctx.stdout = `Updated 1 path from HEAD\n`;
            }
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

          // For GitHub repos, use tarball API (CORS-friendly) as primary strategy
          const ghMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
          let cloned = false;
          if (ghMatch) {
            const [, ghOwner, ghRepo] = ghMatch;
            try {
              ctx.stdout += 'Downloading via GitHub API...\n';
              const tarResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/tarball`, {
                headers: { 'Accept': 'application/vnd.github+json' },
                redirect: 'follow',
              });
              if (!tarResp.ok) throw new Error(`GitHub API: ${tarResp.status}`);
              const tarBuf = await tarResp.arrayBuffer();
              const ds = new DecompressionStream('gzip');
              const dsWriter = ds.writable.getWriter();
              dsWriter.write(new Uint8Array(tarBuf));
              dsWriter.close();
              const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
              // Extract tar entries
              let tOff = 0;
              while (tOff + 512 <= decompressed.length) {
                const hdr = decompressed.slice(tOff, tOff + 512);
                if (hdr.every((b: number) => b === 0)) break;
                let tName = '';
                for (let i = 0; i < 100 && hdr[i] !== 0; i++) tName += String.fromCharCode(hdr[i]);
                let tPrefix = '';
                for (let i = 345; i < 500 && hdr[i] !== 0; i++) tPrefix += String.fromCharCode(hdr[i]);
                if (tPrefix) tName = tPrefix + '/' + tName;
                let tSizeStr = '';
                for (let i = 124; i < 136 && hdr[i] !== 0; i++) tSizeStr += String.fromCharCode(hdr[i]);
                const tSize = parseInt(tSizeStr.trim(), 8) || 0;
                const tType = String.fromCharCode(hdr[156]);
                tOff += 512;
                const tParts = tName.split('/');
                const tRel = tParts.slice(1).join('/');
                if (tRel && (tType === '0' || (tType === '\0' && tSize > 0))) {
                  const fPath = ctx.fs.resolvePath(tRel, targetDir);
                  const fDir = fPath.substring(0, fPath.lastIndexOf('/'));
                  if (fDir) await ctx.fs.mkdir(fDir, { recursive: true });
                  const content = new TextDecoder().decode(decompressed.slice(tOff, tOff + tSize));
                  await ctx.fs.writeFile(fPath, content);
                } else if (tRel && tType === '5') {
                  await ctx.fs.mkdir(ctx.fs.resolvePath(tRel, targetDir), { recursive: true });
                }
                tOff += Math.ceil(tSize / 512) * 512;
              }
              await git.init({ fs, dir: targetDir, defaultBranch: 'main' });
              const clFiles = await listAllFiles(ctx.fs, targetDir, targetDir);
              for (const cf of clFiles) await git.add({ fs, dir: targetDir, filepath: cf });
              await git.commit({
                fs, dir: targetDir,
                message: `Clone of ${ghOwner}/${ghRepo}`,
                author: { name: ctx.env['USER'] || 'user', email: 'user@shiro.local' },
              });
              cloned = true;
            } catch (ghErr: any) {
              ctx.stdout += `GitHub API failed (${ghErr.message}), trying git protocol...\n`;
            }
          }

          if (!cloned) {
            const corsProxy = ctx.env['GIT_CORS_PROXY'] || 'https://cors.isomorphic-git.org';
            const cloneWithTimeout = (proxy: string) => {
              return Promise.race([
                git.clone({
                  fs, http, dir: targetDir, url,
                  corsProxy: proxy,
                  singleBranch: true,
                  depth: 1,
                }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('clone timed out')), 30000)
                ),
              ]);
            };
            await cloneWithTimeout(corsProxy);
          }

          ctx.stdout += `done.\n`;
          break;
        }

        case 'remote': {
          const remoteCmd = ctx.args[1];
          if (!remoteCmd || remoteCmd === '-v') {
            // List remotes
            const remotes = await git.listRemotes({ fs, dir });
            if (remotes.length === 0) {
              ctx.stdout = '';
            } else {
              for (const r of remotes) {
                if (remoteCmd === '-v') {
                  ctx.stdout += `${r.remote}\t${r.url} (fetch)\n`;
                  ctx.stdout += `${r.remote}\t${r.url} (push)\n`;
                } else {
                  ctx.stdout += `${r.remote}\n`;
                }
              }
            }
          } else if (remoteCmd === 'add') {
            const name = ctx.args[2];
            const url = ctx.args[3];
            if (!name || !url) {
              ctx.stderr = 'usage: git remote add <name> <url>\n';
              return 1;
            }
            await git.addRemote({ fs, dir, remote: name, url });
            ctx.stdout = '';
          } else if (remoteCmd === 'remove' || remoteCmd === 'rm') {
            const name = ctx.args[2];
            if (!name) {
              ctx.stderr = 'usage: git remote remove <name>\n';
              return 1;
            }
            await git.deleteRemote({ fs, dir, remote: name });
            ctx.stdout = '';
          } else {
            ctx.stderr = `git remote: '${remoteCmd}' is not a valid subcommand\n`;
            return 1;
          }
          break;
        }

        case 'push': {
          const { remote, ref, token, corsProxy } = parseRemoteArgs(ctx);
          if (!token) {
            ctx.stderr = 'error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n';
            return 1;
          }
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          ctx.stdout = `Pushing to ${remote}/${currentBranch}...\n`;
          await git.push({
            fs, http, dir,
            remote,
            ref: currentBranch,
            corsProxy,
            onAuth: () => ({ username: token }),
          });
          ctx.stdout += `done.\n`;
          break;
        }

        case 'fetch': {
          const { remote, token, corsProxy } = parseRemoteArgs(ctx);
          if (!token) {
            ctx.stderr = 'error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n';
            return 1;
          }
          ctx.stdout = `Fetching from ${remote}...\n`;
          await git.fetch({
            fs, http, dir,
            remote,
            corsProxy,
            onAuth: () => ({ username: token }),
          });
          ctx.stdout += `done.\n`;
          break;
        }

        case 'pull': {
          const { remote, ref, token, corsProxy } = parseRemoteArgs(ctx);
          if (!token) {
            ctx.stderr = 'error: authentication required\nSet GITHUB_TOKEN or run: export GITHUB_TOKEN=ghp_...\n';
            return 1;
          }
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          ctx.stdout = `Pulling from ${remote}/${currentBranch}...\n`;
          await git.pull({
            fs, http, dir,
            remote,
            ref: currentBranch,
            corsProxy,
            singleBranch: true,
            author: { name: ctx.env['USER'] || 'user', email: 'user@shiro.local' },
            onAuth: () => ({ username: token }),
          });
          ctx.stdout += `done.\n`;
          break;
        }

        case 'merge': {
          const theirs = ctx.args[1];
          if (!theirs) {
            ctx.stderr = 'usage: git merge <branch>\n';
            return 1;
          }
          const mergeResult = await git.merge({
            fs, dir,
            ours: await git.currentBranch({ fs, dir }) || 'main',
            theirs,
            author: { name: ctx.env['USER'] || 'user', email: 'user@shiro.local' },
          });
          if (mergeResult.alreadyMerged) {
            ctx.stdout = 'Already up to date.\n';
          } else if (mergeResult.fastForward) {
            ctx.stdout = `Fast-forward merge to ${mergeResult.oid?.slice(0, 7)}\n`;
          } else {
            ctx.stdout = `Merge made by the 'recursive' strategy. ${mergeResult.oid?.slice(0, 7)}\n`;
          }
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

function parseRemoteArgs(ctx: CommandContext): { remote: string; ref: string; token: string; corsProxy: string } {
  let remote = 'origin';
  let ref = '';
  const positional: string[] = [];
  for (let i = 1; i < ctx.args.length; i++) {
    if (!ctx.args[i].startsWith('-')) {
      positional.push(ctx.args[i]);
    }
  }
  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  const token = ctx.env['GITHUB_TOKEN']
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_github_token') || '' : '');
  const corsProxy = ctx.env['GIT_CORS_PROXY'] || 'https://cors.isomorphic-git.org';

  return { remote, ref, token, corsProxy };
}

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
