import git, { TREE, STAGE } from 'isomorphic-git';
// @ts-ignore - isomorphic-git http module
import http from 'isomorphic-git/http/web';
import { Command, CommandContext } from './index';

// --- Module-scope helpers ---

/** Simple greedy unified diff between two arrays of lines */
function unifiedDiff(oldLines: string[], newLines: string[]): string {
  let out = '';
  const ctx_lines = 3;
  const n = oldLines.length, m = newLines.length;
  const edits: { type: number; old?: string; new?: string; oldIdx?: number; newIdx?: number }[] = [];
  let oi = 0, ni = 0;
  while (oi < n || ni < m) {
    if (oi < n && ni < m && oldLines[oi] === newLines[ni]) {
      edits.push({ type: 0, old: oldLines[oi], oldIdx: oi, newIdx: ni });
      oi++; ni++;
    } else {
      let bestOld = -1, bestNew = -1, bestDist = Infinity;
      const maxLook = Math.min(50, Math.max(n - oi, m - ni));
      for (let look = 0; look < maxLook && bestDist > 0; look++) {
        if (oi + look < n) {
          for (let j = ni; j < Math.min(ni + maxLook, m); j++) {
            if (oldLines[oi + look] === newLines[j] && look + (j - ni) < bestDist) {
              bestDist = look + (j - ni); bestOld = oi + look; bestNew = j;
            }
          }
        }
      }
      if (bestOld === -1) {
        while (oi < n) { edits.push({ type: -1, old: oldLines[oi], oldIdx: oi }); oi++; }
        while (ni < m) { edits.push({ type: 1, new: newLines[ni], newIdx: ni }); ni++; }
      } else {
        while (oi < bestOld) { edits.push({ type: -1, old: oldLines[oi], oldIdx: oi }); oi++; }
        while (ni < bestNew) { edits.push({ type: 1, new: newLines[ni], newIdx: ni }); ni++; }
      }
    }
  }
  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === 0) { i++; continue; }
    const hunkStart = Math.max(0, i - ctx_lines);
    let hunkEnd = i;
    while (hunkEnd < edits.length) {
      if (edits[hunkEnd].type !== 0) { hunkEnd++; continue; }
      let nextChange = hunkEnd;
      while (nextChange < edits.length && edits[nextChange].type === 0) nextChange++;
      if (nextChange < edits.length && nextChange - hunkEnd <= ctx_lines * 2) {
        hunkEnd = nextChange + 1;
      } else {
        hunkEnd = Math.min(hunkEnd + ctx_lines, edits.length);
        break;
      }
    }
    let oldStart = 1, newStart = 1, oldCount = 0, newCount = 0;
    let first = true;
    for (let j = hunkStart; j < hunkEnd; j++) {
      if (first && edits[j].oldIdx != null) { oldStart = edits[j].oldIdx! + 1; first = false; }
      if (first && edits[j].newIdx != null) { newStart = edits[j].newIdx! + 1; first = false; }
      if (edits[j].type <= 0 && edits[j].oldIdx != null) oldCount++;
      if (edits[j].type >= 0 && edits[j].newIdx != null) newCount++;
    }
    if (first) { oldStart = 1; newStart = 1; }
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (let j = hunkStart; j < hunkEnd; j++) {
      const e = edits[j];
      if (e.type === 0) out += ` ${e.old}\n`;
      else if (e.type === -1) out += `-${e.old}\n`;
      else if (e.type === 1) out += `+${e.new}\n`;
    }
    i = hunkEnd;
  }
  return out;
}

/** Resolve a revision string like HEAD, HEAD~3, HEAD^2, short SHA, branch name */
async function resolveRevision(fs: any, dir: string, ref: string): Promise<string> {
  // Parse into base + modifiers: "HEAD~3" → base="HEAD", ops=[{type:'~',n:3}]
  const ops: { type: string; n: number }[] = [];
  let base = ref;
  const modRe = /([~^])(\d*)/g;
  let match: RegExpExecArray | null;
  // Find where modifiers start
  const firstMod = ref.search(/[~^]/);
  if (firstMod > 0) {
    base = ref.slice(0, firstMod);
    const modStr = ref.slice(firstMod);
    while ((match = modRe.exec(modStr)) !== null) {
      ops.push({ type: match[1], n: match[2] ? parseInt(match[2], 10) : 1 });
    }
  }

  // Resolve base ref
  let oid: string;
  try {
    oid = await git.resolveRef({ fs, dir, ref: base });
  } catch {
    // Try as short SHA — expandOid finds full OID from prefix
    try {
      oid = await git.expandOid({ fs, dir, oid: base });
    } catch {
      throw new Error(`bad revision '${ref}'`);
    }
  }

  // Walk ancestors
  for (const op of ops) {
    if (op.type === '~') {
      for (let i = 0; i < op.n; i++) {
        const { commit } = await git.readCommit({ fs, dir, oid });
        if (!commit.parent || commit.parent.length === 0) {
          throw new Error(`revision '${ref}' has no parent at ~${i + 1}`);
        }
        oid = commit.parent[0];
      }
    } else if (op.type === '^') {
      const { commit } = await git.readCommit({ fs, dir, oid });
      const idx = op.n - 1;
      if (!commit.parent || idx >= commit.parent.length) {
        throw new Error(`revision '${ref}' has no parent at ^${op.n}`);
      }
      oid = commit.parent[idx];
    }
  }

  return oid;
}

/** Read file content at a specific commit OID */
async function readFileAtRef(fs: any, dir: string, oid: string, filepath: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return new TextDecoder().decode(blob);
  } catch { return null; }
}

interface DiffOpts {
  nameOnly?: boolean;
  stat?: boolean;
}

interface ChangedFile {
  filepath: string;
  oldContent: string | null;
  newContent: string | null;
}

/** Diff two commits by walking their trees */
async function diffCommits(fs: any, dir: string, oid1: string | null, oid2: string, opts?: DiffOpts): Promise<string> {
  let out = '';
  const changes: ChangedFile[] = [];

  if (oid1 === null) {
    // Root commit — all files are additions. Walk single tree.
    const files = await git.walk({
      fs, dir,
      trees: [TREE({ ref: oid2 })],
      map: async (filepath: string, [entry]: any[]) => {
        if (filepath === '.' || filepath === '..') return undefined;
        if (!entry) return undefined;
        const type = await entry.type();
        if (type === 'tree') return undefined;
        return filepath;
      },
    });
    for (const fp of files) {
      if (!fp) continue;
      const content = await readFileAtRef(fs, dir, oid2, fp);
      changes.push({ filepath: fp, oldContent: null, newContent: content });
    }
  } else {
    // Walk both trees
    const results = await git.walk({
      fs, dir,
      trees: [TREE({ ref: oid1 }), TREE({ ref: oid2 })],
      map: async (filepath: string, [entry1, entry2]: any[]) => {
        if (filepath === '.' || filepath === '..') return undefined;
        const o1 = entry1 ? await entry1.oid() : null;
        const o2 = entry2 ? await entry2.oid() : null;
        if (o1 === o2) return undefined; // identical
        const t1 = entry1 ? await entry1.type() : null;
        const t2 = entry2 ? await entry2.type() : null;
        if (t1 === 'tree' || t2 === 'tree') return undefined; // directory entry
        return { filepath, hasEntry1: !!entry1, hasEntry2: !!entry2 };
      },
    });
    for (const r of results) {
      if (!r) continue;
      const oldContent = r.hasEntry1 ? await readFileAtRef(fs, dir, oid1, r.filepath) : null;
      const newContent = r.hasEntry2 ? await readFileAtRef(fs, dir, oid2, r.filepath) : null;
      changes.push({ filepath: r.filepath, oldContent, newContent });
    }
  }

  if (opts?.nameOnly) {
    for (const c of changes) out += c.filepath + '\n';
    return out;
  }

  if (opts?.stat) {
    let totalAdd = 0, totalDel = 0;
    const stats: { filepath: string; add: number; del: number }[] = [];
    for (const c of changes) {
      const oldLines = c.oldContent ? c.oldContent.split('\n') : [];
      const newLines = c.newContent ? c.newContent.split('\n') : [];
      // Count additions and deletions
      let add = 0, del = 0;
      if (!c.oldContent) { add = newLines.length; }
      else if (!c.newContent) { del = oldLines.length; }
      else {
        // Simple line-count diff
        const diff = unifiedDiff(oldLines, newLines);
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++') && !line.startsWith('@@')) add++;
          else if (line.startsWith('-') && !line.startsWith('---') && !line.startsWith('@@')) del++;
        }
      }
      stats.push({ filepath: c.filepath, add, del });
      totalAdd += add; totalDel += del;
    }
    const maxPath = Math.max(...stats.map(s => s.filepath.length), 0);
    for (const s of stats) {
      const total = s.add + s.del;
      const bar = '+'.repeat(Math.min(s.add, 30)) + '-'.repeat(Math.min(s.del, 30));
      out += ` ${s.filepath.padEnd(maxPath)} | ${String(total).padStart(4)} ${bar}\n`;
    }
    out += ` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed`;
    if (totalAdd > 0) out += `, ${totalAdd} insertion${totalAdd !== 1 ? 's' : ''}(+)`;
    if (totalDel > 0) out += `, ${totalDel} deletion${totalDel !== 1 ? 's' : ''}(-)`;
    out += '\n';
    return out;
  }

  // Full diff output
  for (const c of changes) {
    out += `diff --git a/${c.filepath} b/${c.filepath}\n`;
    if (c.oldContent === null) {
      out += `new file\n--- /dev/null\n+++ b/${c.filepath}\n`;
      const lines = (c.newContent || '').split('\n');
      out += `@@ -0,0 +1,${lines.length} @@\n`;
      for (const line of lines) out += `+${line}\n`;
    } else if (c.newContent === null) {
      out += `deleted file\n--- a/${c.filepath}\n+++ /dev/null\n`;
      const lines = c.oldContent.split('\n');
      out += `@@ -1,${lines.length} +0,0 @@\n`;
      for (const line of lines) out += `-${line}\n`;
    } else {
      out += `--- a/${c.filepath}\n+++ b/${c.filepath}\n`;
      out += unifiedDiff(c.oldContent.split('\n'), c.newContent.split('\n'));
    }
  }
  return out;
}

/** Diff staged changes vs HEAD */
async function diffStaged(fs: any, dir: string, opts?: DiffOpts): Promise<string> {
  let out = '';
  const changes: ChangedFile[] = [];

  let hasHead = true;
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' });
  } catch {
    hasHead = false;
  }

  const trees = hasHead ? [TREE({ ref: 'HEAD' }), STAGE()] : [STAGE()];
  const results = await git.walk({
    fs, dir,
    trees,
    map: async (filepath: string, entries: any[]) => {
      if (filepath === '.' || filepath === '..') return undefined;
      if (!hasHead) {
        // No HEAD — everything staged is new
        const entry = entries[0];
        if (!entry) return undefined;
        const type = await entry.type();
        if (type === 'tree') return undefined;
        return { filepath, hasOld: false, hasNew: true };
      }
      const [entry1, entry2] = entries;
      const o1 = entry1 ? await entry1.oid() : null;
      const o2 = entry2 ? await entry2.oid() : null;
      if (o1 === o2) return undefined;
      const t1 = entry1 ? await entry1.type() : null;
      const t2 = entry2 ? await entry2.type() : null;
      if (t1 === 'tree' || t2 === 'tree') return undefined;
      return { filepath, hasOld: !!entry1, hasNew: !!entry2 };
    },
  });

  for (const r of results) {
    if (!r) continue;
    let oldContent: string | null = null;
    let newContent: string | null = null;
    if (r.hasOld && hasHead) {
      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      oldContent = await readFileAtRef(fs, dir, headOid, r.filepath);
    }
    if (r.hasNew) {
      // Read from staging area — use readBlob with HEAD as fallback context
      // The staged content can be read by resolving the index
      try {
        const oids = await git.walk({
          fs, dir,
          trees: [STAGE()],
          map: async (fp: string, [entry]: any[]) => {
            if (fp !== r.filepath) return undefined;
            if (!entry) return undefined;
            const content = await entry.content();
            return content ? new TextDecoder().decode(content) : null;
          },
        });
        newContent = oids.find((x: any) => x != null) ?? null;
      } catch {
        newContent = null;
      }
    }
    changes.push({ filepath: r.filepath, oldContent, newContent });
  }

  if (opts?.nameOnly) {
    for (const c of changes) out += c.filepath + '\n';
    return out;
  }

  if (opts?.stat) {
    let totalAdd = 0, totalDel = 0;
    const stats: { filepath: string; add: number; del: number }[] = [];
    for (const c of changes) {
      const oldLines = c.oldContent ? c.oldContent.split('\n') : [];
      const newLines = c.newContent ? c.newContent.split('\n') : [];
      let add = 0, del = 0;
      if (!c.oldContent) { add = newLines.length; }
      else if (!c.newContent) { del = oldLines.length; }
      else {
        const diff = unifiedDiff(oldLines, newLines);
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++') && !line.startsWith('@@')) add++;
          else if (line.startsWith('-') && !line.startsWith('---') && !line.startsWith('@@')) del++;
        }
      }
      stats.push({ filepath: c.filepath, add, del });
      totalAdd += add; totalDel += del;
    }
    const maxPath = Math.max(...stats.map(s => s.filepath.length), 0);
    for (const s of stats) {
      const total = s.add + s.del;
      const bar = '+'.repeat(Math.min(s.add, 30)) + '-'.repeat(Math.min(s.del, 30));
      out += ` ${s.filepath.padEnd(maxPath)} | ${String(total).padStart(4)} ${bar}\n`;
    }
    out += ` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed`;
    if (totalAdd > 0) out += `, ${totalAdd} insertion${totalAdd !== 1 ? 's' : ''}(+)`;
    if (totalDel > 0) out += `, ${totalDel} deletion${totalDel !== 1 ? 's' : ''}(-)`;
    out += '\n';
    return out;
  }

  for (const c of changes) {
    out += `diff --git a/${c.filepath} b/${c.filepath}\n`;
    if (c.oldContent === null) {
      out += `new file\n--- /dev/null\n+++ b/${c.filepath}\n`;
      const lines = (c.newContent || '').split('\n');
      out += `@@ -0,0 +1,${lines.length} @@\n`;
      for (const line of lines) out += `+${line}\n`;
    } else if (c.newContent === null) {
      out += `deleted file\n--- a/${c.filepath}\n+++ /dev/null\n`;
      const lines = c.oldContent.split('\n');
      out += `@@ -1,${lines.length} +0,0 @@\n`;
      for (const line of lines) out += `-${line}\n`;
    } else {
      out += `--- a/${c.filepath}\n+++ b/${c.filepath}\n`;
      out += unifiedDiff(c.oldContent.split('\n'), c.newContent.split('\n'));
    }
  }
  return out;
}

// --- Main command ---

export const gitCmd: Command = {
  name: 'git',
  description: 'Version control system',
  async exec(ctx: CommandContext) {
    const subcommand = ctx.args[0];
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, add, commit, status, log, diff, show, branch, checkout, clone\n  push, pull, fetch, remote, merge\n';
      return 0;
    }
    if (subcommand === '--version' || subcommand === '-v') {
      ctx.stdout = 'git version 2.47.0 (isomorphic-git/shiro)\n';
      return 0;
    }

    const fs = ctx.fs.toIsomorphicGitFS();
    const dir = ctx.cwd;

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
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === '-n' && ctx.args[i + 1]) maxCount = parseInt(ctx.args[++i]);
            if (ctx.args[i]?.startsWith('--max-count=')) maxCount = parseInt(ctx.args[i].split('=')[1]);
            if (ctx.args[i] === '--oneline') oneline = true;
            if (ctx.args[i] === '--stat') showStat = true;
            if (ctx.args[i] === '--name-only') nameOnly = true;
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
          let statFlag = false;
          const positional: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '--cached' || a === '--staged') cached = true;
            else if (a === '--name-only') nameOnlyFlag = true;
            else if (a === '--stat') statFlag = true;
            else if (!a.startsWith('-')) positional.push(a);
          }
          const diffOpts: DiffOpts = { nameOnly: nameOnlyFlag, stat: statFlag };

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
          const commitOid = await resolveRevision(fs, dir, ref);
          const { commit } = await git.readCommit({ fs, dir, oid: commitOid });
          const date = new Date(commit.author.timestamp * 1000);

          ctx.stdout = `commit ${commitOid}\n`;
          ctx.stdout += `Author: ${commit.author.name} <${commit.author.email}>\n`;
          ctx.stdout += `Date:   ${date.toISOString()}\n`;
          ctx.stdout += `\n    ${commit.message.trim()}\n\n`;

          const parentOid = commit.parent.length > 0 ? commit.parent[0] : null;
          const diffOpts: DiffOpts = { nameOnly: nameOnlyFlag, stat: statFlag };
          ctx.stdout += await diffCommits(fs, dir, parentOid, commitOid, diffOpts);
          break;
        }

        case 'branch': {
          const branchArgs = ctx.args.slice(1);
          if (branchArgs.length > 0 && !branchArgs[0].startsWith('-')) {
            const newBranch = branchArgs[0];
            await git.branch({ fs, dir, ref: newBranch });
            break;
          }
          if (branchArgs[0] === '-d' || branchArgs[0] === '-D') {
            const delBranch = branchArgs[1];
            if (!delBranch) { ctx.stderr = 'fatal: branch name required\n'; return 1; }
            await git.deleteBranch({ fs, dir, ref: delBranch });
            ctx.stdout += `Deleted branch ${delBranch}.\n`;
            break;
          }
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
              ...(token ? { onAuth: () => ({ username: token }) } : {}),
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('clone timed out')), 60000)
            ),
          ]);

          try {
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
