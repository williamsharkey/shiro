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
import { getShiroOrigin } from '../utils/shiro-origin';
import { activeProfile } from '../profile';
import { gitPlumbing } from './git-plumbing';
import { splitShortOptions, unknownOption, realGit, PREFER_REAL } from './git-route';
import { GLOBAL_GITCONFIG, parseGitConfig, formatGitConfig } from './git-config';

// --- Main command ---

export const gitCmd: Command = {
  name: 'git',
  description: 'Version control system',
  async exec(ctx: CommandContext) {
    // Global options before the subcommand (git -C /path -c k=v --no-pager subcmd ...)
    const argv = ctx.args, cwd0 = ctx.cwd; // as given, for the real git
    let workDir = ctx.cwd;
    const configOverrides: [string, string][] = [];
    let ai = 0;
    for (; ai < ctx.args.length; ai++) {
      const a = ctx.args[ai];
      if (a === '-C' && ai + 1 < ctx.args.length) {
        workDir = ctx.fs.resolvePath(ctx.args[++ai], workDir);
      } else if (a === '-c' && ai + 1 < ctx.args.length) {
        const kv = ctx.args[++ai], eq = kv.indexOf('=');
        configOverrides.push(eq < 0 ? [kv, 'true'] : [kv.slice(0, eq), kv.slice(eq + 1)]);
      } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
        const v = ctx.fs.resolvePath(a.slice(a.indexOf('=') + 1), workDir);
        workDir = a.startsWith('--git-dir=') ? (v.endsWith('/.git') ? v.slice(0, -5) || '/' : v) : v;
      } else if (['--no-pager', '-P', '--paginate', '-p', '--no-optional-locks', '--literal-pathspecs',
        '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare'].includes(a)) {
        // nothing to do: no pager, no locks to skip
      } else break;
    }
    // Mutate ctx in-place so stdout/stderr propagate back
    ctx.args = ctx.args.slice(ai);
    ctx.cwd = workDir;
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, config, add, commit, status, log, diff, show, branch, checkout, clone\n  push, pull, fetch, remote, merge, stash, reset, tag, cherry-pick, revert, rebase, reflog\n';
      return 0;
    }
    if (subcommand === '--version' || subcommand === '-v') {
      ctx.stdout = 'git version 2.47.0 (isomorphic-git/shiro)\n';
      return 0;
    }

    if (ctx.args.includes('--help') || (ctx.args.length === 2 && ctx.args[1] === '-h')) {
      ctx.stdout = `usage: git ${subcommand} [<options>] [<args>]\n\n(the built-in git; \`pkg install git\` for the full git and its manual)\n`;
      return 0;
    }
    // What the built-in doesn't know (a subcommand, an option) is the real git's; combined short options split first
    ctx.args = [subcommand, ...splitShortOptions(subcommand, ctx.args.slice(1))];
    const unknown = unknownOption(subcommand, ctx.args.slice(1));
    if (unknown !== null || PREFER_REAL.has(subcommand)) {
      const code = await realGit(ctx, argv, cwd0);
      if (code !== null) return code;
      const full = '(the built-in git; `pkg install git` has the full git, which needs the x86 engine)\n';
      if (unknown === subcommand) {
        ctx.stderr = `git: '${unknown}' is not a git command. See 'git --help'.\n${full}`;
        return 1;
      }
      if (unknown?.includes(' ')) {
        ctx.stderr = `error: unknown subcommand: \`${unknown.split(' ')[1]}'\nusage: git ${subcommand} ...\n${full}`;
        return 129;
      }
      if (unknown !== null) {
        ctx.stderr = (unknown.startsWith('--') ? `error: unknown option \`${unknown.slice(2)}'\n` : `error: unknown switch \`${unknown.slice(1)}'\n`)
          + `usage: git ${subcommand} [<options>]\n${full}`;
        return 129;
      }
    }

    const fs = ctx.fs.toIsomorphicGitFS();
    // The repository is the nearest directory up from here with a .git, as for git
    let dir = workDir;
    if (subcommand === 'ls-remote' && /[:@]/.test(ctx.args.find((a, i) => i > 0 && !a.startsWith('-')) ?? '')) {
      return lsRemote(ctx, fs, workDir, null);
    }
    if (!['init', 'clone', 'config'].includes(subcommand)) {
      let root: string | null = workDir;
      while (root && !(await ctx.fs.exists(root === '/' ? '/.git' : `${root}/.git`))) {
        root = root === '/' ? null : root.slice(0, root.lastIndexOf('/')) || '/';
      }
      if (!root) {
        ctx.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
        return 128;
      }
      dir = root;
    }

    try {
      const handled = await gitPlumbing(ctx, fs, dir, workDir);
      if (handled !== null) return handled;
      switch (subcommand) {
        case 'config':
          return gitConfigCommand(ctx, fs, dir, configOverrides);

        case 'init': {
          let targetDir = dir;
          const initPath = ctx.args.slice(1).find((x, i, arr) => !x.startsWith('-') && arr[i - 1] !== '-b' && arr[i - 1] !== '--initial-branch');
          if (initPath) {
            targetDir = ctx.fs.resolvePath(initPath, dir);
            await ctx.fs.mkdir(targetDir, { recursive: true });
          }
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          try {
            await ctx.fs.mkdir(gitDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
          const branchFlag = ctx.args.findIndex(x => x === '-b' || x === '--initial-branch');
          const defaultBranch = (branchFlag > 0 && ctx.args[branchFlag + 1])
            || (await readGlobalConfig(ctx))['init.defaultbranch'] || 'main';
          await git.init({ fs, dir: targetDir, defaultBranch });
          ctx.stdout = `Initialized empty Git repository in ${targetDir}/.git/\n`;
          break;
        }

        case 'add': {
          let update = false, force = false, dashdash = false;
          const paths: string[] = [];
          for (const a of ctx.args.slice(1)) {
            if (dashdash || !a.startsWith('-')) paths.push(a);
            else if (a === '--') dashdash = true;
            else if (a === '-u' || a === '--update') update = true;
            else if (a === '-f' || a === '--force') force = true;
            // -A/--all, -v, -N, ...: the defaults here
          }
          const rel = (paths.length ? paths : ['.']).map(p => {
            const abs = ctx.fs.resolvePath(p, workDir);
            return abs === dir ? '.' : abs.slice(dir === '/' ? 1 : dir.length + 1);
          });
          const under = (f: string) => rel.some(r => r === '.' || f === r || f.startsWith(r + '/'));
          const seen = new Set<string>();
          const matrix = await git.statusMatrix({ fs, dir, ...(rel.includes('.') ? {} : { filepaths: rel }) });
          for (const [filepath, head, work, stage] of matrix) {
            if (!under(filepath)) continue;
            seen.add(filepath);
            if (work === 0) {
              if (head || stage) await git.remove({ fs, dir, filepath });
              continue;
            }
            if (update && head === 0 && stage === 0) continue; // -u: tracked files only
            if ((work === 1 && stage === 1) || (work === 2 && stage === 2)) continue;
            await git.add({ fs, dir, filepath, force });
          }
          for (let i = 0; i < rel.length; i++) {
            if (rel[i] === '.' || [...seen].some(f => f === rel[i] || f.startsWith(rel[i] + '/'))) continue;
            // ignored (git add -f), or nothing there
            if (force && await ctx.fs.exists(dir === '/' ? '/' + rel[i] : `${dir}/${rel[i]}`)) { await git.add({ fs, dir, filepath: rel[i], force: true }); continue; }
            if (!(await ctx.fs.exists(dir === '/' ? '/' + rel[i] : `${dir}/${rel[i]}`))) {
              ctx.stderr += `fatal: pathspec '${paths[i]}' did not match any files\n`;
              return 128;
            }
          }
          break;
        }

        case 'commit': {
          let message = '';
          let amend = false;
          let allowEmpty = false;
          let all = false, quiet = false;
          const messages: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '-m' || a === '--message' || a === '-F' || a === '--file') {
              const v = ctx.args[++i] ?? '';
              messages.push(a === '-F' || a === '--file' ? (v === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(v, workDir), 'utf8') as string) : v);
            } else if (a.startsWith('--message=')) messages.push(a.slice(10));
            else if (a === '--amend') amend = true;
            else if (a === '--allow-empty') allowEmpty = true;
            else if (a === '--all') all = true;
            else if (a === '--quiet') quiet = true;
            else if (/^-[aqnsvem]+$/.test(a) || /^-[aqnsv]*m.+$/.test(a)) {
              // bundled short options: -am msg, -qam msg, -mmsg
              for (let j = 1; j < a.length; j++) {
                const c = a[j];
                if (c === 'a') all = true;
                else if (c === 'q') quiet = true;
                else if (c === 'm') { messages.push(j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i] ?? ''); break; }
              }
            }
          }
          message = messages.map(m => m.replace(/\n+$/, '')).join('\n\n');
          if (all) {
            // -a: stage what changed in tracked files, as git does
            for (const [filepath, head, work, stage] of await git.statusMatrix({ fs, dir })) {
              if (head === 0 && stage === 0) continue;
              if (work === 0) await git.remove({ fs, dir, filepath });
              else if (work !== stage || (head === 1 && work === 2)) await git.add({ fs, dir, filepath });
            }
          }

          const author = await resolveAuthor(ctx, fs, dir);

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
            if (!quiet) ctx.stdout = `[${currentBranch} ${sha.slice(0, 7)}] ${message.split('\n')[0].trim()}\n`;
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
          if (!quiet) ctx.stdout = `[${branch} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`;
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

        case 'checkout':
        case 'switch': {
          let newBranch = '', force = false, quiet = false, sawDashDash = false;
          const rest: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (sawDashDash) rest.push(a);
            else if (a === '--') sawDashDash = true;
            else if (a === '-b' || a === '-B' || a === '-c' || a === '-C') { newBranch = ctx.args[++i] ?? ''; force = force || a === '-B' || a === '-C'; if (!newBranch) { ctx.stderr = `error: switch \`${a[1]}' requires a value\n`; return 129; } }
            else if (a === '-q' || a === '--quiet') quiet = true;
            else if (a === '-f' || a === '--force') force = true;
            else if (a === '--no-track' || a === '--track' || a === '-t' || a === '--recurse-submodules' || a === '--no-recurse-submodules' || a === '--progress' || a === '--no-progress' || a === '--detach' || a === '-d') {}
            else rest.push(a);
          }
          const say = (m: string) => { if (!quiet) ctx.stderr += m; };
          if (newBranch) {
            const start = rest[0] ? await resolveRevision(fs, dir, rest[0]) : undefined;
            await git.branch({ fs, dir, ref: newBranch, object: start, checkout: false, force });
            await git.checkout({ fs, dir, ref: newBranch });
            say(`Switched to a new branch '${newBranch}'\n`);
            break;
          }
          if (!rest.length) {
            ctx.stderr = 'error: must specify branch or path\n';
            return 1;
          }
          const branches = await git.listBranches({ fs, dir });
          const target = rest[0];
          if (!sawDashDash && rest.length === 1 && branches.includes(target)) {
            await git.checkout({ fs, dir, ref: target, force });
            say(`Switched to branch '${target}'\n`);
            break;
          }
          if (!sawDashDash && rest.length === 1 && subcommand === 'checkout') {
            // a commit (detached HEAD) or a remote branch of that name
            const remoteRef = (await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => [] as string[])).includes(target);
            if (remoteRef) {
              await git.branch({ fs, dir, ref: target, object: `refs/remotes/origin/${target}`, checkout: false });
              await git.setConfig({ fs, dir, path: `branch.${target}.remote`, value: 'origin' });
              await git.setConfig({ fs, dir, path: `branch.${target}.merge`, value: `refs/heads/${target}` });
              await git.checkout({ fs, dir, ref: target, force });
              say(`branch '${target}' set up to track 'origin/${target}'.\nSwitched to a new branch '${target}'\n`);
              break;
            }
            let oid: string | null = null;
            try { oid = await resolveRevision(fs, dir, target); } catch {}
            if (oid) {
              await git.checkout({ fs, dir, ref: oid, force });
              say(`HEAD is now at ${oid.slice(0, 7)}\n`);
              break;
            }
          }
          if (subcommand === 'switch') { ctx.stderr = `fatal: invalid reference: ${target}\n`; return 128; }
          // paths: from the index's HEAD, or from a commit (checkout REV -- paths)
          let ref = 'HEAD', paths = rest;
          if (sawDashDash && ctx.args.indexOf('--') > 1 && rest.length > 0) {
            const before = ctx.args.slice(1, ctx.args.indexOf('--')).filter(a => !a.startsWith('-'));
            if (before.length) ref = before[0];
          }
          if (sawDashDash) paths = ctx.args.slice(ctx.args.indexOf('--') + 1);
          const rel = paths.map(p => {
            const abs = ctx.fs.resolvePath(p, workDir);
            return abs === dir ? '.' : abs.slice(dir === '/' ? 1 : dir.length + 1);
          });
          if (!rel.length) { ctx.stderr = 'error: must specify branch or path\n'; return 1; }
          await git.checkout({ fs, dir, ref, filepaths: rel, force: true, noUpdateHead: true });
          say(`Updated ${rel.length} path${rel.length === 1 ? '' : 's'} from ${ref === 'HEAD' ? 'the index' : ref}\n`);
          break;
        }

        case 'clone': {
          const cloneArgs = ctx.args.slice(1);
          let url = '';
          let cloneTarget = '';
          let cloneDepth = 1;
          let cloneBranch: string | undefined;
          for (let i = 0; i < cloneArgs.length; i++) {
            const a = cloneArgs[i];
            if (a === '--depth' && i + 1 < cloneArgs.length) { cloneDepth = parseInt(cloneArgs[++i], 10) || 1; continue; }
            if (a.startsWith('--depth=')) { cloneDepth = parseInt(a.slice(8), 10) || 1; continue; }
            if (a === '--branch' || a === '-b') { cloneBranch = cloneArgs[++i]; continue; }
            if (a.startsWith('--branch=')) { cloneBranch = a.slice(9); continue; }
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
          // As git: only into a new or empty directory, and a failed clone leaves nothing behind
          const existed = await ctx.fs.exists(targetDir);
          if (existed && (await ctx.fs.readdir(targetDir).catch(() => [])).length) {
            ctx.stderr = `fatal: destination path '${cloneTarget || repoName}' already exists and is not an empty directory.\n`;
            return 128;
          }
          await ctx.fs.mkdir(targetDir, { recursive: true });
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          await ctx.fs.mkdir(gitDir, { recursive: true });
          const undo = async () => {
            await ctx.fs.rm(existed ? gitDir : targetDir, { recursive: true }).catch(() => {});
          };
          ctx.stderr = `Cloning into '${cloneTarget || repoName}'...\n`;

          const corsProxy = ctx.env['GIT_CORS_PROXY'] || `${getShiroOrigin()}/git-proxy`;
          const token = ctx.env['GITHUB_TOKEN'] || (typeof localStorage !== 'undefined' ? localStorage.getItem('tabcomputer_github_token') || '' : '');
          try {
            await Promise.race([
              git.clone({
                fs, http, dir: targetDir, url,
                corsProxy,
                singleBranch: true,
                depth: cloneDepth,
                ...(cloneBranch ? { ref: cloneBranch } : {}),
                onProgress: async () => {
                  await new Promise(resolve => setTimeout(resolve, 0));
                },
                ...githubAuth(token, url),
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('clone timed out after 300s')), 300000)
              ),
            ]);
          } catch (cloneErr: any) {
            await undo();
            ctx.stderr += `fatal: ${cloneErr.message || cloneErr}\n`;
            const httpStatus = cloneErr?.data?.statusCode;
            if ((httpStatus === 401 || httpStatus === 403 || httpStatus === 404) && /github\.com/.test(url)) {
              ctx.stderr += token
                ? 'hint: the repository may not exist, or your GitHub sign-in lacks access to it.\n'
                : 'hint: private repositories need a GitHub sign-in. Run: gh auth login\n';
            }
            return 128;
          }

          try {
            await new Promise(resolve => setTimeout(resolve, 0));
            const branch = await git.currentBranch({ fs, dir: targetDir }) || 'main';
            await git.checkout({ fs, dir: targetDir, ref: branch, force: true });
          } catch { /* checkout best-effort */ }

          ctx.stderr += `done.\n`;
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
            ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n';
            return 1;
          }
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          const pushUrl = await remoteUrl(fs, dir, remote);
          ctx.stdout = `Pushing to ${remote}/${currentBranch}...\n`;
          try {
            const result = await git.push({
              fs, http, dir,
              remote,
              ref: currentBranch,
              force: ctx.args.includes('-f') || ctx.args.includes('--force'),
              corsProxy,
              ...githubAuth(token, pushUrl),
              onMessage: (msg: string) => { ctx.stdout += msg; },
            });
            if (result.ok) {
              ctx.stdout += `done.\n`;
              if (ctx.args.includes('-u') || ctx.args.includes('--set-upstream')) {
                await git.setConfig({ fs, dir, path: `branch.${currentBranch}.remote`, value: remote });
                await git.setConfig({ fs, dir, path: `branch.${currentBranch}.merge`, value: `refs/heads/${currentBranch}` });
                ctx.stdout += `branch '${currentBranch}' set up to track '${remote}/${currentBranch}'.\n`;
              }
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
              ctx.stderr = `error: authentication failed (HTTP ${e.statusCode || e.data?.statusCode || ''})\nSign in again with: gh auth login (or gh auth refresh if the token lacks access)\n`;
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
          const quiet = ctx.args.includes('-q') || ctx.args.includes('--quiet');
          // --all: every remote (none is fine: nothing to do)
          const remotes = ctx.args.includes('--all')
            ? (await git.listRemotes({ fs, dir })).map(r => r.remote)
            : [remote];
          for (const r of remotes) {
            if (!(await remoteUrl(fs, dir, r))) {
              ctx.stderr += `fatal: '${r}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n`;
              return 128;
            }
            if (!quiet) ctx.stderr += `Fetching ${r}\n`;
            await git.fetch({
              fs, http, dir,
              remote: r,
              corsProxy,
              prune: ctx.args.includes('--prune') || ctx.args.includes('-p'),
              tags: ctx.args.includes('--tags') || ctx.args.includes('-t'),
              ...githubAuth(token, await remoteUrl(fs, dir, r)),
            });
          }
          break;
        }

        case 'pull': {
          const { remote, ref, token, corsProxy } = parseRemoteArgs(ctx);
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          ctx.stdout = `Pulling from ${remote}/${currentBranch}...\n`;
          await git.pull({
            fs, http, dir,
            remote,
            ref: currentBranch,
            corsProxy,
            singleBranch: true,
            author: await resolveAuthor(ctx, fs, dir),
            ...githubAuth(token, await remoteUrl(fs, dir, remote)),
          });
          ctx.stdout += `done.\n`;
          break;
        }

        case 'merge': {
          let noFF = false, ffOnly = false, quiet = false, message: string | undefined;
          const names: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '--no-ff') noFF = true;
            else if (a === '--ff') noFF = false;
            else if (a === '--ff-only') ffOnly = true;
            else if (a === '-q' || a === '--quiet') quiet = true;
            else if (a === '-m' || a === '--message') message = ctx.args[++i];
            else if (a.startsWith('--message=')) message = a.slice(10);
            else if (!a.startsWith('-')) names.push(a);
          }
          const theirs = names[0];
          if (!theirs) {
            ctx.stderr = 'fatal: No remote for the current branch.\n';
            return 128;
          }
          const ours = await git.currentBranch({ fs, dir }) || 'main';
          const before = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          let mergeResult;
          try {
            mergeResult = await git.merge({
              fs, dir, ours, theirs,
              fastForward: !noFF,
              fastForwardOnly: ffOnly,
              message: message ?? `Merge branch '${theirs}'`,
              author: await resolveAuthor(ctx, fs, dir),
            });
          } catch (e: any) {
            if (e.code === 'MergeConflictError' || e.code === 'MergeNotSupportedError') {
              ctx.stderr = `CONFLICT (content): Merge conflict in ${(e.data?.filepaths ?? []).join(', ') || 'the work tree'}\nAutomatic merge failed; nothing was changed (the built-in git; \`pkg install git\` merges with conflict markers).\n`;
              return 1;
            }
            if (e.code === 'FastForwardError') { ctx.stderr = 'fatal: Not possible to fast-forward, aborting.\n'; return 128; }
            throw e;
          }
          // the merge moved the branch; the work tree and index follow
          if (!mergeResult.alreadyMerged) await git.checkout({ fs, dir, ref: ours });
          if (quiet) break;
          if (mergeResult.alreadyMerged) ctx.stdout = 'Already up to date.\n';
          else if (mergeResult.fastForward) ctx.stdout = `Updating ${before.slice(0, 7)}..${mergeResult.oid?.slice(0, 7)}\nFast-forward\n`;
          else ctx.stdout = `Merge made by the 'ort' strategy.\n`;
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
            author: { name: 'user', email: `user@${activeProfile().hostname}.local`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 } });
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
          const rebaseQuiet = ctx.args.includes('-q') || ctx.args.includes('--quiet');
          const target = ctx.args.slice(1).find(a => !a.startsWith('-'));
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
          if (!rebaseQuiet) ctx.stdout = `Successfully rebased and updated refs/heads/${currentBranch}.\n`;
          return 0;
        }

        case 'ls-remote':
          return lsRemote(ctx, fs, dir, dir);

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

export { GLOBAL_GITCONFIG, parseGitConfig, formatGitConfig };

async function readGlobalConfig(ctx: CommandContext): Promise<Record<string, string>> {
  try { return parseGitConfig(await ctx.fs.readFile(GLOBAL_GITCONFIG, 'utf8') as string); } catch { return {}; }
}

/** Commit author: repo config, then ~/.gitconfig, then GIT_AUTHOR_* env, then a default. */
async function resolveAuthor(ctx: CommandContext, fs: any, dir: string): Promise<{ name: string; email: string }> {
  const repoValue = async (path: string) => { try { return await git.getConfig({ fs, dir, path }); } catch { return undefined; } };
  const global = await readGlobalConfig(ctx);
  return {
    name: (await repoValue('user.name')) || global['user.name'] || ctx.env['GIT_AUTHOR_NAME'] || ctx.env['USER'] || 'user',
    email: (await repoValue('user.email')) || global['user.email'] || ctx.env['GIT_AUTHOR_EMAIL'] || `user@${activeProfile().hostname}.local`,
  };
}

async function gitConfigCommand(ctx: CommandContext, fs: any, dir: string, overrides: [string, string][] = []): Promise<number> {
  const args = ctx.args.slice(1);
  let global = false, system = false, local = false, list = false, unset = false, nul = false, nameOnly = false;
  let mode = '' as 'get' | 'get-all' | 'get-regexp' | '', type = '', dflt: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--global') global = true;
    else if (a === '--system') system = true;
    else if (a === '--local') local = true;
    else if (a === '--list' || a === '-l') list = true;
    else if (a === '--unset' || a === '--unset-all') unset = true;
    else if (a === '-z' || a === '--null') nul = true;
    else if (a === '--name-only') nameOnly = true;
    else if (a === '--get' || a === '--get-all' || a === '--get-regexp') mode = a.slice(2) as typeof mode;
    else if (a === '--bool' || a === '--int' || a === '--path') type = a.slice(2);
    else if (a.startsWith('--type=')) type = a.slice(7);
    else if (a === '--type') type = args[++i] ?? '';
    else if (a.startsWith('--default=')) dflt = a.slice(10);
    else if (a === '--default') dflt = args[++i];
    else if (a === '--includes' || a === '--no-includes' || a === '--show-origin' || a === '--show-scope' || a === '--add' || a === '--replace-all') {}
    else if (a === '-f' || a === '--file' || a === '--blob') i++;
    else positional.push(a);
  }
  // --list and the get forms read the repository's config from a subdirectory too
  let root: string | null = dir;
  while (root && !(await ctx.fs.exists(root === '/' ? '/.git' : `${root}/.git`))) {
    root = root === '/' ? null : root.slice(0, root.lastIndexOf('/')) || '/';
  }
  const inRepo = root !== null;
  if (root) dir = root;
  const readAll = async (): Promise<Record<string, string>> => {
    const values: Record<string, string> = {};
    if (!global && !local) {
      try { Object.assign(values, parseGitConfig(await ctx.fs.readFile('/etc/gitconfig', 'utf8') as string)); } catch {}
    }
    if (system) return values;
    if (!local) Object.assign(values, await readGlobalConfig(ctx));
    if (!global && inRepo) {
      try { Object.assign(values, parseGitConfig(await ctx.fs.readFile(dir + '/.git/config', 'utf8') as string)); } catch {}
    }
    if (!global && !local) for (const [k, v] of overrides) values[k.toLowerCase()] = v;
    return values;
  };
  const typed = (v: string) => {
    if (type === 'bool') return /^(true|yes|on|1|)$/i.test(v) ? 'true' : 'false';
    if (type === 'int') { const m = v.match(/^(-?\d+)([kmg]?)$/i); return m ? String(+m[1] * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 } as any)[m[2].toLowerCase()]) : v; }
    if (type === 'path' && v.startsWith('~/')) return (ctx.env['HOME'] || '/home/user') + v.slice(1);
    return v;
  };
  const end = nul ? '\0' : '\n';
  const pair = (k: string, v: string) => nameOnly ? k + end : nul ? `${k}\n${typed(v)}\0` : mode === 'get-regexp' ? `${k} ${typed(v)}\n` : `${k}=${typed(v)}\n`;

  if (list) {
    ctx.stdout = Object.entries(await readAll()).map(([k, v]) => pair(k, v)).join('');
    return 0;
  }
  if (mode === 'get-regexp') {
    let re: RegExp;
    try { re = new RegExp(positional[0] ?? '.', 'i'); } catch { ctx.stderr = `error: invalid key pattern: ${positional[0]}\n`; return 6; }
    const hits = Object.entries(await readAll()).filter(([k]) => re.test(k));
    ctx.stdout = hits.map(([k, v]) => pair(k, v)).join('');
    return hits.length ? 0 : 1;
  }
  const key = positional[0]?.toLowerCase();
  const value = positional.slice(1).join(' ');
  if (!key) { ctx.stderr = 'usage: git config [--global] <name> [<value>] | --list | --unset <name>\n'; return 1; }
  if (mode || (!value && !unset)) {
    const v = (await readAll())[key] ?? dflt;
    if (v === undefined) return 1;
    ctx.stdout = typed(v) + end;
    return 0;
  }

  if (global || !inRepo) {
    if (!global && !inRepo) { ctx.stderr = 'fatal: not in a git directory\n'; return 128; }
    const values = await readGlobalConfig(ctx);
    if (unset) { if (values[key] === undefined) return 5; delete values[key]; }
    else values[key] = value;
    await ctx.fs.writeFile(GLOBAL_GITCONFIG, formatGitConfig(values));
    return 0;
  }
  await git.setConfig({ fs, dir, path: key, value: unset ? undefined : value });
  return 0;
}

/**
 * Credentials for GitHub remotes, sent on the first request. Left to the usual
 * 401 challenge, the browser answers GitHub's `WWW-Authenticate: Basic` with its
 * own login prompt, which stalls that request and every later one to the same
 * origin until the clone/push times out. Only github.com URLs get the token.
 */
export function githubAuth(token: string, url: string | undefined): Record<string, any> {
  if (!token || !url || !/^https?:\/\/([^/@]+@)?github\.com\//.test(url)) return {};
  return {
    headers: { Authorization: 'Basic ' + btoa('x-access-token:' + token) },
    onAuth: () => ({ username: 'x-access-token', password: token }),
    onAuthFailure: () => ({ cancel: true }),
  };
}

/** `git ls-remote [--heads|--tags] URL|REMOTE [patterns]` */
async function lsRemote(ctx: CommandContext, fs: any, cwd: string, dir: string | null): Promise<number> {
  const pos = ctx.args.slice(1).filter(a => !a.startsWith('-'));
  const target = pos[0] ?? 'origin';
  const url = dir && !/[:@]/.test(target) ? await remoteUrl(fs, dir, target) : target;
  if (!url) { ctx.stderr = `fatal: '${target}' does not appear to be a git repository\n`; return 128; }
  const { token, corsProxy } = parseRemoteArgs(ctx);
  void cwd;
  const heads = ctx.args.includes('--heads') || ctx.args.includes('-h') || ctx.args.includes('--branches');
  const tags = ctx.args.includes('--tags') || ctx.args.includes('-t');
  let refs: { ref: string; oid: string; target?: string; peeled?: string }[];
  try {
    refs = await git.listServerRefs({ http, url, corsProxy, symrefs: true, peelTags: true, ...githubAuth(token, url) });
  } catch (e: any) {
    ctx.stderr = `fatal: unable to access '${url}': ${e.message}\n`;
    return 128;
  }
  const pats = pos.slice(1);
  let out = '';
  for (const r of refs) {
    if (heads && !r.ref.startsWith('refs/heads/')) continue;
    if (tags && !r.ref.startsWith('refs/tags/')) continue;
    if (pats.length && !pats.some(p => r.ref === p || r.ref.endsWith('/' + p))) continue;
    out += `${r.oid}\t${r.ref}\n`;
    if (r.peeled) out += `${r.peeled}\t${r.ref}^{}\n`;
  }
  if (!ctx.args.includes('-q') && !ctx.args.includes('--quiet')) ctx.stdout += out;
  return 0;
}

async function remoteUrl(fs: any, dir: string, remote: string): Promise<string | undefined> {
  try { return await git.getConfig({ fs, dir, path: `remote.${remote}.url` }); } catch { return undefined; }
}

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
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('tabcomputer_github_token') || '' : '');
  const corsProxy = ctx.env['GIT_CORS_PROXY'] || `${getShiroOrigin()}/git-proxy`;

  return { remote, ref, token, corsProxy };
}


