/**
 * Git helper functions shared by git.ts and git-* command files.
 *
 * Extracted from git.ts to keep command implementations focused.
 */
import git, { TREE, STAGE } from 'isomorphic-git';

// --- Types ---

export interface DiffOpts {
  nameOnly?: boolean;
  nameStatus?: boolean;
  stat?: boolean;
}

export interface ChangedFile {
  filepath: string;
  oldContent: string | null;
  newContent: string | null;
}

// --- Diff helpers ---

/** Simple greedy unified diff between two arrays of lines */
export function unifiedDiff(oldLines: string[], newLines: string[]): string {
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

// --- Revision helpers ---

/** Resolve a revision string like HEAD, HEAD~3, HEAD^2, short SHA, branch name */
export async function resolveRevision(fs: any, dir: string, ref: string): Promise<string> {
  const ops: { type: string; n: number }[] = [];
  let base = ref;
  const modRe = /([~^])(\d*)/g;
  let match: RegExpExecArray | null;
  const firstMod = ref.search(/[~^]/);
  if (firstMod > 0) {
    base = ref.slice(0, firstMod);
    const modStr = ref.slice(firstMod);
    while ((match = modRe.exec(modStr)) !== null) {
      ops.push({ type: match[1], n: match[2] ? parseInt(match[2], 10) : 1 });
    }
  }

  let oid: string;
  try {
    oid = await git.resolveRef({ fs, dir, ref: base });
  } catch {
    try {
      oid = await git.expandOid({ fs, dir, oid: base });
    } catch {
      throw new Error(`bad revision '${ref}'`);
    }
  }

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
export async function readFileAtRef(fs: any, dir: string, oid: string, filepath: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return new TextDecoder().decode(blob);
  } catch { return null; }
}

// --- Commit diff helpers ---

/** Diff two commits by walking their trees */
export async function diffCommits(fs: any, dir: string, oid1: string | null, oid2: string, opts?: DiffOpts): Promise<string> {
  let out = '';
  const changes: ChangedFile[] = [];

  if (oid1 === null) {
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
    const results = await git.walk({
      fs, dir,
      trees: [TREE({ ref: oid1 }), TREE({ ref: oid2 })],
      map: async (filepath: string, [entry1, entry2]: any[]) => {
        if (filepath === '.' || filepath === '..') return undefined;
        const o1 = entry1 ? await entry1.oid() : null;
        const o2 = entry2 ? await entry2.oid() : null;
        if (o1 === o2) return undefined;
        const t1 = entry1 ? await entry1.type() : null;
        const t2 = entry2 ? await entry2.type() : null;
        if (t1 === 'tree' || t2 === 'tree') return undefined;
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

  if (opts?.nameStatus) {
    for (const c of changes) {
      let status = 'M';
      if (c.oldContent === null) status = 'A';
      else if (c.newContent === null) status = 'D';
      out += `${status}\t${c.filepath}\n`;
    }
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

/** Diff staged changes vs HEAD */
export async function diffStaged(fs: any, dir: string, opts?: DiffOpts): Promise<string> {
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

  if (opts?.nameStatus) {
    for (const c of changes) {
      let status = 'M';
      if (c.oldContent === null) status = 'A';
      else if (c.newContent === null) status = 'D';
      out += `${status}\t${c.filepath}\n`;
    }
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

// --- Formatting helpers ---

/** Format relative time from unix timestamp */
export function timeAgoFromTimestamp(ts: number): string {
  const secs = Math.floor((Date.now() / 1000) - ts);
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/** Apply format specifiers to a commit */
export function formatCommit(c: { oid: string; commit: any }, fmt: string): string {
  let result = fmt;
  result = result.replace(/%H/g, c.oid);
  result = result.replace(/%h/g, c.oid.slice(0, 7));
  result = result.replace(/%s/g, c.commit.message.split('\n')[0].trim());
  result = result.replace(/%an/g, c.commit.author.name);
  result = result.replace(/%ae/g, c.commit.author.email);
  result = result.replace(/%ad/g, new Date(c.commit.author.timestamp * 1000).toISOString());
  result = result.replace(/%ar/g, timeAgoFromTimestamp(c.commit.author.timestamp));
  result = result.replace(/%cn/g, c.commit.committer?.name || c.commit.author.name);
  result = result.replace(/%ce/g, c.commit.committer?.email || c.commit.author.email);
  const committerTs = c.commit.committer?.timestamp || c.commit.author.timestamp;
  result = result.replace(/%cr/g, timeAgoFromTimestamp(committerTs));
  result = result.replace(/%cd/g, new Date(committerTs * 1000).toString());
  result = result.replace(/%ci/g, new Date(committerTs * 1000).toISOString());
  result = result.replace(/%n/g, '\n');
  result = result.replace(/%%/g, '%');
  return result;
}
