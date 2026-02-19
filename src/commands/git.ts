import git, { TREE, STAGE } from 'isomorphic-git';
// @ts-ignore - isomorphic-git http module
import http from 'isomorphic-git/http/web';
import { Command, CommandContext } from './index';
import { gitStashHandler } from './git-stash';
import { gitResetHandler } from './git-reset';
import { gitTagHandler } from './git-tag';
import {
  unifiedDiff, resolveRevision, readFileAtRef,
  diffCommits, diffStaged, formatCommit,
  type DiffOpts,
} from './git-utils';

// --- Main command ---

export const gitCmd: Command = {
  name: 'git',
  description: 'Version control system',
  async exec(ctx: CommandContext) {
    // Parse -C <dir> flag before subcommand (git -C /path subcmd ...)
    const filteredArgs: string[] = [];
    let workDir = ctx.cwd;
    for (let ai = 0; ai < ctx.args.length; ai++) {
      if (ctx.args[ai] === '-C' && ai + 1 < ctx.args.length) {
        workDir = ctx.fs.resolvePath(ctx.args[ai + 1], workDir);
        ai++; // skip the path arg
      } else {
        filteredArgs.push(ctx.args[ai]);
      }
    }
    // Mutate ctx in-place so stdout/stderr propagate back
    ctx.args = filteredArgs;
    ctx.cwd = workDir;
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, show, branch, checkout, clone\n  push, pull, fetch, remote, merge, stash, reset, tag, cherry-pick, revert, rebase, reflog\n';
      return 0;
    }
    if (subcommand === '--version' || subcommand === '-v') {
      ctx.stdout = 'git version 2.47.0 (isomorphic-git/shiro)\n';
      return 0;
    }

    const fs = ctx.fs.toIsomorphicGitFS();
    const dir = workDir;

    try {
      switch (subcommand) {
        case 'init': {
          let targetDir = dir;
          if (ctx.args[1]) {
            targetDir = ctx.fs.resolvePath(ctx.args[1], dir);
            await ctx.fs.mkdir(targetDir, { recursive: true });
          }
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
          let amend = false;
          let allowEmpty = false;
          for (let i = 1; i < ctx.args.length; i++) {
            if ((ctx.args[i] === '-m' || ctx.args[i] === '--message') && ctx.args[i + 1]) {
              message = ctx.args[++i];
            }
            if (ctx.args[i] === '--amend') amend = true;
            if (ctx.args[i] === '--allow-empty') allowEmpty = true;
          }

          const author = { name: ctx.env['USER'] || 'user', email: 'user@shiro.local' };

          if (amend) {
            // Read current HEAD commit
            const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const { commit: headCommit } = await git.readCommit({ fs, dir, oid: headOid });
            if (!message) message = headCommit.message;
            // Move HEAD to parent
            const currentBranch = await git.currentBranch({ fs, dir }) || 'main';
            if (headCommit.parent.length > 0) {
              await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: headCommit.parent[0], force: true });
            }
            const sha = await git.commit({ fs, dir, message, author });
            ctx.stdout = `[${currentBranch} ${sha.slice(0, 7)}] ${message.split('\n')[0].trim()}\n`;
            break;
          }

          if (!message) {
            ctx.stderr = 'error: must supply commit message with -m\n';
            return 1;
          }
          const sha = await git.commit({
            fs, dir, message, author,
            ...(allowEmpty ? { allowEmpty: true } : {}),
          });
          const branch = await git.currentBranch({ fs, dir }) || 'main';
          ctx.stdout = `[${branch} ${sha.slice(0, 7)}] ${message}\n`;
          break;
        }

        case 'status': {
          let porcelain = false;
          let short = false;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '--porcelain') porcelain = true;
            if (ctx.args[i] === '-s' || ctx.args[i] === '--short') short = true;
          }

          const matrix = await git.statusMatrix({ fs, dir });
          const STATUS_MAP: Record<string, string> = {
            '003': 'added',
            '020': 'deleted',
            '023': 'deleted',
            '100': 'deleted',
            '101': 'deleted',
            '103': 'modified',
            '110': 'deleted',
            '111': '',
            '120': 'modified',
            '121': 'modified',
            '122': 'modified',
            '123': 'modified',
          };

          if (porcelain || short) {
            // Porcelain/short output: XY codes
            for (const [filepath, head, workdir, stage] of matrix) {
              const key = `${head}${workdir}${stage}`;
              if (key === '111') continue;
              let X = ' ', Y = ' ';
              // Index (X) status
              if (head === 0 && stage === 2) X = 'A';      // added to index
              else if (head === 1 && stage === 3) X = 'M';  // modified in index
              else if (head === 1 && stage === 0) X = 'D';  // deleted from index
              // Worktree (Y) status
              if (stage === 2 && workdir === 0) Y = 'D';    // deleted in worktree
              else if (head === 1 && workdir === 2 && stage === 1) Y = 'M'; // modified in worktree
              else if (head === 0 && workdir === 2 && stage === 0) { X = '?'; Y = '?'; } // untracked
              ctx.stdout += `${X}${Y} ${filepath}\n`;
            }
            break;
          }

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
          let showStat = false;
          let nameOnly = false;
          let formatStr = '';
          let showAll = false;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '-n' && ctx.args[i + 1]) maxCount = parseInt(ctx.args[++i]);
            else if (ctx.args[i]?.startsWith('-') && /^-\d+$/.test(ctx.args[i])) maxCount = parseInt(ctx.args[i].slice(1));
            else if (ctx.args[i]?.startsWith('--max-count=')) maxCount = parseInt(ctx.args[i].split('=')[1]);
            else if (ctx.args[i] === '--oneline') oneline = true;
            else if (ctx.args[i] === '--stat') showStat = true;
            else if (ctx.args[i] === '--name-only') nameOnly = true;
            else if (ctx.args[i] === '--all') showAll = true;
            else if (ctx.args[i]?.startsWith('--format=')) formatStr = ctx.args[i].slice(9);
            else if (ctx.args[i]?.startsWith('--pretty=format:')) formatStr = ctx.args[i].slice(16);
            else if (ctx.args[i] === '--pretty=oneline') oneline = true;
            else if (ctx.args[i]?.startsWith('--pretty=')) formatStr = ctx.args[i].slice(9);
          }
          let commits;
          if (showAll) {
            const branches = await git.listBranches({ fs, dir });
            const allCommits = new Map<string, any>();
            for (const branch of branches) {
              try {
                const branchCommits = await git.log({ fs, dir, ref: branch, depth: maxCount });
                for (const c of branchCommits) {
                  if (!allCommits.has(c.oid)) allCommits.set(c.oid, c);
                }
              } catch {}
            }
            commits = [...allCommits.values()]
              .sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp)
              .slice(0, maxCount);
          } else {
            commits = await git.log({ fs, dir, depth: maxCount });
          }
          for (const c of commits) {
            if (formatStr) {
              ctx.stdout += formatCommit(c, formatStr) + '\n';
            } else if (oneline) {
              ctx.stdout += `${c.oid.slice(0, 7)} ${c.commit.message.trim()}\n`;
            } else {
              ctx.stdout += `commit ${c.oid}\n`;
              ctx.stdout += `Author: ${c.commit.author.name} <${c.commit.author.email}>\n`;
              const date = new Date(c.commit.author.timestamp * 1000);
              ctx.stdout += `Date:   ${date.toISOString()}\n`;
              ctx.stdout += `\n    ${c.commit.message.trim()}\n\n`;
            }
            if (showStat || nameOnly) {
              const parentOid = c.commit.parent.length > 0 ? c.commit.parent[0] : null;
              const diffOut = await diffCommits(fs, dir, parentOid, c.oid, {
                stat: showStat,
                nameOnly,
              });
              ctx.stdout += diffOut;
              if (diffOut) ctx.stdout += '\n';
            }
          }
          break;
        }

        case 'diff': {
          // Parse flags and positional args
          let cached = false;
          let nameOnlyFlag = false;
          let nameStatusFlag = false;
          let statFlag = false;
          const positional: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '--cached' || a === '--staged') cached = true;
            else if (a === '--name-only') nameOnlyFlag = true;
            else if (a === '--name-status') nameStatusFlag = true;
            else if (a === '--stat') statFlag = true;
            else if (!a.startsWith('-')) positional.push(a);
          }
          const diffOpts: DiffOpts = { nameOnly: nameOnlyFlag, nameStatus: nameStatusFlag, stat: statFlag };

          if (cached) {
            // git diff --cached: staged vs HEAD
            ctx.stdout = await diffStaged(fs, dir, diffOpts);
            break;
          }

          if (positional.length >= 1) {
            // Check for commit..commit syntax
            const dotDot = positional[0].indexOf('..');
            let ref1: string, ref2: string;
            if (dotDot > 0) {
              ref1 = positional[0].slice(0, dotDot);
              ref2 = positional[0].slice(dotDot + 2);
              const oid1 = await resolveRevision(fs, dir, ref1);
              const oid2 = await resolveRevision(fs, dir, ref2);
              ctx.stdout = await diffCommits(fs, dir, oid1, oid2, diffOpts);
            } else if (positional.length >= 2) {
              // Two refs: git diff ref1 ref2
              const oid1 = await resolveRevision(fs, dir, positional[0]);
              const oid2 = await resolveRevision(fs, dir, positional[1]);
              ctx.stdout = await diffCommits(fs, dir, oid1, oid2, diffOpts);
            } else {
              // Single ref: diff ref vs working tree
              // For now, diff ref vs HEAD (since working tree diff requires statusMatrix)
              const refOid = await resolveRevision(fs, dir, positional[0]);
              const headOid = await resolveRevision(fs, dir, 'HEAD');
              if (refOid !== headOid) {
                ctx.stdout = await diffCommits(fs, dir, refOid, headOid, diffOpts);
              } else {
                ctx.stdout = '';
              }
            }
            break;
          }

          // Default: working tree vs HEAD (existing behavior)
          const matrix = await git.statusMatrix({ fs, dir });
          let output = '';
          for (const [filepath, head, workdir, _stage] of matrix) {
            if (head === workdir) continue;
            if (nameOnlyFlag) {
              output += `${filepath}\n`;
              continue;
            }
            if (nameStatusFlag) {
              const status = (head === 0) ? 'A' : (workdir === 0) ? 'D' : 'M';
              output += `${status}\t${filepath}\n`;
              continue;
            }
            output += `diff --git a/${filepath} b/${filepath}\n`;
            if (head === 0 && workdir === 2) {
              const content = await ctx.fs.readFile(ctx.fs.resolvePath(filepath as string, dir), 'utf8');
              output += `new file\n--- /dev/null\n+++ b/${filepath}\n`;
              const lines = (content as string).split('\n');
              output += `@@ -0,0 +1,${lines.length} @@\n`;
              for (const line of lines) output += `+${line}\n`;
            } else if (workdir === 0) {
              const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const oldContent = await readFileAtRef(fs, dir, headOid, filepath as string);
              output += `deleted file\n--- a/${filepath}\n+++ /dev/null\n`;
              if (oldContent != null) {
                const lines = oldContent.split('\n');
                output += `@@ -1,${lines.length} +0,0 @@\n`;
                for (const line of lines) output += `-${line}\n`;
              }
            } else {
              const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const oldContent = await readFileAtRef(fs, dir, headOid, filepath as string);
              const newContent = await ctx.fs.readFile(ctx.fs.resolvePath(filepath as string, dir), 'utf8');
              output += `--- a/${filepath}\n+++ b/${filepath}\n`;
              if (oldContent != null && newContent != null) {
                output += unifiedDiff(oldContent.split('\n'), (newContent as string).split('\n'));
              } else {
                output += `(could not read file contents)\n`;
              }
            }
          }
          ctx.stdout = output;
          break;
        }

        case 'show': {
          const ref = ctx.args[1] || 'HEAD';
          let nameOnlyFlag = false;
          let statFlag = false;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '--name-only') nameOnlyFlag = true;
            if (ctx.args[i] === '--stat') statFlag = true;
          }
          let oid = await resolveRevision(fs, dir, ref);

          // Check if this is an annotated tag object
          try {
            const { type } = await git.readObject({ fs, dir, oid });
            if (type === 'tag') {
              const { tag } = await git.readTag({ fs, dir, oid });
              ctx.stdout = `tag ${ref}\n`;
              ctx.stdout += `Tagger: ${tag.tagger.name} <${tag.tagger.email}>\n`;
              ctx.stdout += `Date:   ${new Date(tag.tagger.timestamp * 1000).toISOString()}\n`;
              ctx.stdout += `\n    ${tag.message.trim()}\n\n`;
              // Follow to the target commit
              oid = tag.object;
            }
          } catch {
            // Not a tag object, continue as commit
          }

          const { commit } = await git.readCommit({ fs, dir, oid });
          const date = new Date(commit.author.timestamp * 1000);

          ctx.stdout += `commit ${oid}\n`;
          ctx.stdout += `Author: ${commit.author.name} <${commit.author.email}>\n`;
          ctx.stdout += `Date:   ${date.toISOString()}\n`;
          ctx.stdout += `\n    ${commit.message.trim()}\n\n`;

          const parentOid = commit.parent.length > 0 ? commit.parent[0] : null;
          const diffOpts: DiffOpts = { nameOnly: nameOnlyFlag, stat: statFlag };
          ctx.stdout += await diffCommits(fs, dir, parentOid, oid, diffOpts);
          break;
        }

        case 'branch': {
          const branchArgs = ctx.args.slice(1);
          let showAll = false;
          let showRemote = false;
          for (const ba of branchArgs) {
            if (ba === '-a' || ba === '--all') showAll = true;
            if (ba === '-r' || ba === '--remotes') showRemote = true;
          }
          const nonFlagArgs = branchArgs.filter(a => !a.startsWith('-'));
          if (nonFlagArgs.length > 0 && !showAll && !showRemote) {
            if (branchArgs[0] === '-d' || branchArgs[0] === '-D') {
              const delBranch = nonFlagArgs[0];
              if (!delBranch) { ctx.stderr = 'fatal: branch name required\n'; return 1; }
              await git.deleteBranch({ fs, dir, ref: delBranch });
              ctx.stdout += `Deleted branch ${delBranch}.\n`;
              break;
            }
            const newBranch = nonFlagArgs[0];
            await git.branch({ fs, dir, ref: newBranch });
            break;
          }
          if (!showRemote) {
            const branches = await git.listBranches({ fs, dir });
            const current = await git.currentBranch({ fs, dir });
            for (const b of branches) {
              ctx.stdout += (b === current ? '* ' : '  ') + b + '\n';
            }
          }
          if (showAll || showRemote) {
            try {
              const remotes = await git.listRemotes({ fs, dir });
              for (const r of remotes) {
                try {
                  const remoteBranches = await git.listBranches({ fs, dir, remote: r.remote });
                  for (const b of remoteBranches) {
                    ctx.stdout += `  remotes/${r.remote}/${b}\n`;
                  }
                } catch {}
              }
            } catch {}
          }
          break;
        }

        case 'checkout': {
          const target = ctx.args[1];
          if (!target) {
            ctx.stderr = 'error: must specify branch or path\n';
            return 1;
          }
          if (target === '-b') {
            const newBranch = ctx.args[2];
            if (!newBranch) {
              ctx.stderr = 'error: must specify new branch name\n';
              return 1;
            }
            await git.branch({ fs, dir, ref: newBranch, checkout: true });
            ctx.stdout = `Switched to a new branch '${newBranch}'\n`;
          } else {
            const branches = await git.listBranches({ fs, dir });
            if (branches.includes(target)) {
              await git.checkout({ fs, dir, ref: target });
              ctx.stdout = `Switched to branch '${target}'\n`;
            } else {
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
          const cloneArgs = ctx.args.slice(1);
          let url = '';
          let cloneTarget = '';
          let cloneDepth = 1;
          for (let i = 0; i < cloneArgs.length; i++) {
            const a = cloneArgs[i];
            if (a === '--depth' && i + 1 < cloneArgs.length) { cloneDepth = parseInt(cloneArgs[++i], 10) || 1; continue; }
            if (a === '--branch' || a === '-b') { i++; continue; }
            if (a === '--single-branch' || a === '--no-tags' || a === '--quiet' || a === '-q') continue;
            if (a.startsWith('-')) continue;
            if (!url) { url = a; } else if (!cloneTarget) { cloneTarget = a; }
          }
          if (!url) { ctx.stderr = 'error: must specify repository URL\n'; return 1; }
          if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git://')) {
            url = 'https://' + url;
          }
          const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
          const targetDir = cloneTarget
            ? ctx.fs.resolvePath(cloneTarget, ctx.cwd)
            : ctx.fs.resolvePath(repoName, ctx.cwd);
          await ctx.fs.mkdir(targetDir, { recursive: true });
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          try {
            await ctx.fs.mkdir(gitDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
          ctx.stdout = `Cloning into '${repoName}'...\n`;

          const corsProxy = ctx.env['GIT_CORS_PROXY'] || (typeof location !== 'undefined' ? location.origin + '/git-proxy' : 'https://cors.isomorphic-git.org');
          const token = ctx.env['GITHUB_TOKEN'] || (typeof localStorage !== 'undefined' ? localStorage.getItem('shiro_github_token') || '' : '');
          await Promise.race([
            git.clone({
              fs, http, dir: targetDir, url,
              corsProxy,
              singleBranch: true,
              depth: cloneDepth,
              onProgress: async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
              },
              ...(token ? { onAuth: () => ({ username: token }) } : {}),
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('clone timed out')), 60000)
            ),
          ]);

          try {
            await new Promise(resolve => setTimeout(resolve, 0));
            const branch = await git.currentBranch({ fs, dir: targetDir }) || 'main';
            await git.checkout({ fs, dir: targetDir, ref: branch, force: true });
          } catch { /* checkout best-effort */ }

          ctx.stdout += `done.\n`;
          break;
        }

        case 'remote': {
          const remoteCmd = ctx.args[1];
          if (!remoteCmd || remoteCmd === '-v') {
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
          } else if (remoteCmd === 'set-url') {
            const name = ctx.args[2];
            const url = ctx.args[3];
            if (!name || !url) {
              ctx.stderr = 'usage: git remote set-url <name> <url>\n';
              return 1;
            }
            await git.deleteRemote({ fs, dir, remote: name });
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
          try {
            const result = await git.push({
              fs, http, dir,
              remote,
              ref: currentBranch,
              corsProxy,
              onAuth: () => ({ username: token }),
              onMessage: (msg: string) => { ctx.stdout += msg; },
            });
            if (result.ok) {
              ctx.stdout += `done.\n`;
            } else {
              ctx.stderr = `error: push failed\n`;
              if (result.refs) {
                for (const [refName, status] of Object.entries(result.refs)) {
                  if (!(status as any).ok) {
                    ctx.stderr += `  ${refName}: ${(status as any).error || 'rejected'}\n`;
                  }
                }
              }
              return 1;
            }
          } catch (e: any) {
            if (e.code === 'HttpError' || e.statusCode === 401 || e.statusCode === 403) {
              ctx.stderr = `error: authentication failed (HTTP ${e.statusCode || ''})\nCheck your GITHUB_TOKEN is valid and has push access.\n`;
            } else if (e.code === 'PushRejectedError') {
              ctx.stderr = `error: push rejected — remote has new commits. Pull first.\n`;
            } else {
              ctx.stderr = `error: push failed: ${e.message}\n`;
            }
            return 1;
          }
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

        case 'stash':
          return gitStashHandler(ctx, fs, dir);

        case 'reset':
          return gitResetHandler(ctx, fs, dir);

        case 'tag':
          return gitTagHandler(ctx, fs, dir);

        case 'cherry-pick': {
          const ref = ctx.args[1];
          if (!ref) { ctx.stderr = 'usage: git cherry-pick <commit>\n'; return 1; }
          let oid: string;
          try {
            oid = await resolveRevision(fs, dir, ref);
          } catch {
            ctx.stderr = `fatal: bad revision '${ref}'\n`; return 128;
          }
          const commitObj = await git.readCommit({ fs, dir, oid });
          const parentOid = commitObj.commit.parent[0];
          if (!parentOid) { ctx.stderr = 'fatal: cannot cherry-pick root commit\n'; return 1; }
          // Walk tree diff parent→commit, apply changes
          const changes = await git.walk({ fs, dir, trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: oid })],
            map: async (filepath: string, [A, B]: any[]) => {
              if (filepath === '.') return;
              const aOid = A ? await A.oid() : null;
              const bOid = B ? await B.oid() : null;
              if (aOid === bOid) return;
              const aType = A ? await A.type() : null;
              const bType = B ? await B.type() : null;
              if (bType === 'tree' || aType === 'tree') return;
              return { filepath, aOid, bOid, bType };
            },
          });
          for (const ch of changes.filter(Boolean)) {
            const fullPath = dir + '/' + ch.filepath;
            if (ch.bOid) {
              const { blob } = await git.readBlob({ fs, dir, oid: ch.bOid });
              await ctx.fs.mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
              await ctx.fs.writeFile(fullPath, new TextDecoder().decode(blob));
              await git.add({ fs, dir, filepath: ch.filepath });
            } else {
              await ctx.fs.unlink(fullPath).catch(() => {});
              await git.remove({ fs, dir, filepath: ch.filepath });
            }
          }
          const msg = commitObj.commit.message.trim() + `\n\n(cherry picked from commit ${oid.slice(0, 7)})`;
          await git.commit({ fs, dir, message: msg, author: commitObj.commit.author });
          ctx.stdout = `[cherry-pick ${oid.slice(0, 7)}] ${commitObj.commit.message.split('\n')[0]}\n`;
          return 0;
        }

        case 'revert': {
          const ref = ctx.args[1];
          if (!ref) { ctx.stderr = 'usage: git revert <commit>\n'; return 1; }
          let oid: string;
          try {
            oid = await resolveRevision(fs, dir, ref);
          } catch {
            ctx.stderr = `fatal: bad revision '${ref}'\n`; return 128;
          }
          const commitObj = await git.readCommit({ fs, dir, oid });
          const parentOid = commitObj.commit.parent[0];
          if (!parentOid) { ctx.stderr = 'fatal: cannot revert root commit\n'; return 1; }
          // Reverse diff: commit→parent (apply parent state for changed files)
          const changes = await git.walk({ fs, dir, trees: [git.TREE({ ref: oid }), git.TREE({ ref: parentOid })],
            map: async (filepath: string, [A, B]: any[]) => {
              if (filepath === '.') return;
              const aOid = A ? await A.oid() : null;
              const bOid = B ? await B.oid() : null;
              if (aOid === bOid) return;
              const aType = A ? await A.type() : null;
              const bType = B ? await B.type() : null;
              if (bType === 'tree' || aType === 'tree') return;
              return { filepath, aOid, bOid, bType };
            },
          });
          for (const ch of changes.filter(Boolean)) {
            const fullPath = dir + '/' + ch.filepath;
            if (ch.bOid) {
              const { blob } = await git.readBlob({ fs, dir, oid: ch.bOid });
              await ctx.fs.mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
              await ctx.fs.writeFile(fullPath, new TextDecoder().decode(blob));
              await git.add({ fs, dir, filepath: ch.filepath });
            } else {
              await ctx.fs.unlink(fullPath).catch(() => {});
              await git.remove({ fs, dir, filepath: ch.filepath });
            }
          }
          const subject = commitObj.commit.message.split('\n')[0];
          const msg = `Revert "${subject}"\n\nThis reverts commit ${oid.slice(0, 7)}.`;
          await git.commit({ fs, dir, message: msg,
            author: { name: 'user', email: 'user@shiro.computer', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 } });
          ctx.stdout = `[revert ${oid.slice(0, 7)}] Revert "${subject}"\n`;
          return 0;
        }

        case 'rebase': {
          if (ctx.args[1] === '-i' || ctx.args[1] === '--interactive') {
            ctx.stderr = 'fatal: interactive rebase is not supported\n';
            return 1;
          }
          if (ctx.args[1] === '--continue' || ctx.args[1] === '--abort') {
            ctx.stderr = `fatal: no rebase in progress\n`;
            return 1;
          }
          const target = ctx.args[1];
          if (!target) { ctx.stderr = 'usage: git rebase <branch>\n'; return 1; }
          let targetOid: string;
          try {
            targetOid = await git.resolveRef({ fs, dir, ref: target });
          } catch {
            ctx.stderr = `fatal: invalid upstream '${target}'\n`; return 128;
          }
          const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          // Find merge base (walk both histories to find common ancestor)
          const targetLog = await git.log({ fs, dir, ref: targetOid, depth: 200 });
          const headLog = await git.log({ fs, dir, ref: headOid, depth: 200 });
          const targetOids = new Set(targetLog.map(c => c.oid));
          let mergeBase = '';
          for (const c of headLog) {
            if (targetOids.has(c.oid)) { mergeBase = c.oid; break; }
          }
          if (!mergeBase) { ctx.stderr = 'fatal: no common ancestor found\n'; return 1; }
          // Collect commits from merge-base..HEAD (exclusive of merge-base)
          const toReplay: typeof headLog = [];
          for (const c of headLog) {
            if (c.oid === mergeBase) break;
            toReplay.push(c);
          }
          toReplay.reverse();
          if (toReplay.length === 0) {
            ctx.stdout = `Current branch is up to date.\n`;
            return 0;
          }
          // Reset HEAD to target
          const currentBranch = await git.currentBranch({ fs, dir }) || 'HEAD';
          await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: targetOid, force: true });
          // Checkout target tree
          await git.checkout({ fs, dir, ref: currentBranch, force: true });
          // Cherry-pick each commit
          for (const entry of toReplay) {
            const parentOid = entry.commit.parent[0];
            if (!parentOid) continue;
            const changes = await git.walk({ fs, dir, trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: entry.oid })],
              map: async (filepath: string, [A, B]: any[]) => {
                if (filepath === '.') return;
                const aOid = A ? await A.oid() : null;
                const bOid = B ? await B.oid() : null;
                if (aOid === bOid) return;
                const bType = B ? await B.type() : null;
                const aType = A ? await A.type() : null;
                if (bType === 'tree' || aType === 'tree') return;
                return { filepath, bOid };
              },
            });
            for (const ch of changes.filter(Boolean)) {
              const fullPath = dir + '/' + ch.filepath;
              if (ch.bOid) {
                const { blob } = await git.readBlob({ fs, dir, oid: ch.bOid });
                await ctx.fs.mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
                await ctx.fs.writeFile(fullPath, new TextDecoder().decode(blob));
                await git.add({ fs, dir, filepath: ch.filepath });
              } else {
                await ctx.fs.unlink(fullPath).catch(() => {});
                await git.remove({ fs, dir, filepath: ch.filepath });
              }
            }
            await git.commit({ fs, dir, message: entry.commit.message, author: entry.commit.author });
          }
          ctx.stdout = `Successfully rebased and updated refs/heads/${currentBranch}.\n`;
          return 0;
        }

        case 'reflog': {
          // isomorphic-git has no reflog; show current HEAD as single entry
          const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          ctx.stdout = `${headOid.slice(0, 7)} HEAD@{0}: current state\n`;
          return 0;
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
  const corsProxy = ctx.env['GIT_CORS_PROXY'] || (typeof location !== 'undefined' ? location.origin + '/git-proxy' : 'https://cors.isomorphic-git.org');

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
      files.push(fullPath.slice(base.length + 1));
    }
  }
  return files;
}
