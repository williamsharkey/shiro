import { Command, CommandContext } from './index';

export const diffCmd: Command = {
  name: 'diff',
  description: 'Compare files line by line',
  async exec(ctx: CommandContext) {
    let unified = false;
    const files: string[] = [];

    for (const arg of ctx.args) {
      if (arg === '-u' || arg === '--unified') {
        unified = true;
      } else {
        files.push(arg);
      }
    }

    if (files.length < 2) {
      ctx.stderr = 'diff: missing operand\n';
      return 2;
    }

    const pathA = ctx.fs.resolvePath(files[0], ctx.cwd);
    const pathB = ctx.fs.resolvePath(files[1], ctx.cwd);

    let contentA: string, contentB: string;
    try {
      contentA = await ctx.fs.readFile(pathA, 'utf8') as string;
    } catch {
      ctx.stderr = `diff: ${files[0]}: No such file or directory\n`;
      return 2;
    }
    try {
      contentB = await ctx.fs.readFile(pathB, 'utf8') as string;
    } catch {
      ctx.stderr = `diff: ${files[1]}: No such file or directory\n`;
      return 2;
    }

    if (contentA === contentB) {
      return 0;
    }

    const linesA = contentA.split('\n');
    const linesB = contentB.split('\n');

    if (unified) {
      ctx.stdout += `--- ${files[0]}\n`;
      ctx.stdout += `+++ ${files[1]}\n`;
    }

    // Simple LCS-based diff
    const hunks = computeDiff(linesA, linesB);

    if (unified) {
      for (const hunk of hunks) {
        ctx.stdout += `@@ -${hunk.startA + 1},${hunk.countA} +${hunk.startB + 1},${hunk.countB} @@\n`;
        for (const line of hunk.lines) {
          ctx.stdout += line + '\n';
        }
      }
    } else {
      // Normal diff format
      for (const hunk of hunks) {
        const rangeA = hunk.countA === 1
          ? `${hunk.startA + 1}`
          : `${hunk.startA + 1},${hunk.startA + hunk.countA}`;
        const rangeB = hunk.countB === 1
          ? `${hunk.startB + 1}`
          : `${hunk.startB + 1},${hunk.startB + hunk.countB}`;

        if (hunk.countA === 0) {
          ctx.stdout += `${hunk.startA}a${rangeB}\n`;
        } else if (hunk.countB === 0) {
          ctx.stdout += `${rangeA}d${hunk.startB}\n`;
        } else {
          ctx.stdout += `${rangeA}c${rangeB}\n`;
        }

        for (const line of hunk.lines) {
          if (line.startsWith('-') || line.startsWith('<')) {
            ctx.stdout += `< ${line.slice(1)}\n`;
          } else if (line.startsWith('+') || line.startsWith('>')) {
            ctx.stdout += `> ${line.slice(1)}\n`;
          } else if (line === '---') {
            ctx.stdout += '---\n';
          }
        }
      }
    }

    return 1; // diff returns 1 when files differ
  },
};

interface Hunk {
  startA: number;
  countA: number;
  startB: number;
  countB: number;
  lines: string[];
}

function computeDiff(a: string[], b: string[]): Hunk[] {
  // Myers diff algorithm (simplified)
  const n = a.length;
  const m = b.length;

  // Build edit script using LCS
  const lcs = computeLCS(a, b);
  const hunks: Hunk[] = [];

  let ai = 0, bi = 0, li = 0;
  let currentHunk: Hunk | null = null;

  const flushHunk = () => {
    if (currentHunk && currentHunk.lines.length > 0) {
      hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  while (ai < n || bi < m) {
    if (li < lcs.length && ai === lcs[li].ai && bi === lcs[li].bi) {
      // Matching line
      flushHunk();
      ai++;
      bi++;
      li++;
    } else if (li < lcs.length) {
      if (!currentHunk) {
        currentHunk = { startA: ai, countA: 0, startB: bi, countB: 0, lines: [] };
      }
      // Lines before the next LCS match
      while (ai < lcs[li].ai) {
        currentHunk.lines.push('-' + a[ai]);
        currentHunk.countA++;
        ai++;
      }
      while (bi < lcs[li].bi) {
        currentHunk.lines.push('+' + b[bi]);
        currentHunk.countB++;
        bi++;
      }
    } else {
      // Past the end of LCS
      if (!currentHunk) {
        currentHunk = { startA: ai, countA: 0, startB: bi, countB: 0, lines: [] };
      }
      while (ai < n) {
        currentHunk.lines.push('-' + a[ai]);
        currentHunk.countA++;
        ai++;
      }
      while (bi < m) {
        currentHunk.lines.push('+' + b[bi]);
        currentHunk.countB++;
        bi++;
      }
    }
  }

  flushHunk();
  return hunks;
}

interface LCSEntry {
  ai: number;
  bi: number;
}

function computeLCS(a: string[], b: string[]): LCSEntry[] {
  const n = a.length;
  const m = b.length;

  // DP table (space-optimized would be better but this is clear)
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: LCSEntry[] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift({ ai: i - 1, bi: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
