/**
 * The npm build of Claude Code's cli.js as node-compat runs it (the version
 * and capability patches, the ES module transform, the async-context pass),
 * kept next to it so a run loads that text instead of redoing the passes.
 *
 * Each pass makes a full-size copy of the 13.7 MB source; a node guest that
 * did them while loading cli.js peaked well above the page doing the same
 * (bench: workload.peak_rss.claude_npm_first), and every launch redid them.
 * A run that transformed cli.js saves the text when its program has ended
 * (node-run.ts): no second transform, and the write is done before `claude`
 * returns. A run that finds it reads it instead.
 *
 * Keyed by this build's commit (the transforms are this build's code), the
 * pinned version and cli.js's size and mtime (a `claude update` or an edited
 * cli.js is transformed again; a stat, not a hash of 13.7 MB on every launch);
 * a build without a commit (tests) keeps none.
 */
import { CLAUDE_CODE_CLI_JS, CLAUDE_CODE_DIR, CLAUDE_CODE_VERSION, patchClaudeCodeSource } from './claude-code-version';

const PREFIX = '.tabcomputer-cli-';

interface CacheFs {
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<CliStat>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** What of cli.js's stat keys its text */
export interface CliStat { size: number; mtimeMs?: number; mtimeNs?: number }

const buildSha = (): string => (typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '');

/** FNV-1a of the key: a short file name */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The cache file for cli.js as `st` describes it, or null when this build keeps none */
export function claudeTransformPath(st: CliStat): string | null {
  const sha = buildSha();
  if (!sha) return null;
  return `${CLAUDE_CODE_DIR}/${PREFIX}${shortHash(`${sha}:${CLAUDE_CODE_VERSION}:${st.size}:${st.mtimeMs ?? 0}:${st.mtimeNs ?? 0}`)}.js`;
}

/** cli.js's text as node-compat runs it (execution.ts uses this too, so the two never differ) */
export async function transformClaudeSource(code: string): Promise<string> {
  const [{ transformESModules }, { carryAsyncContext, carriesAsyncContext }] = await Promise.all([
    import('./commands/jseval/module-transform'), import('./node-compat/async-context'),
  ]);
  // (the AsyncLocalStorage rewrite as the transform's pass, on its code mask: one scan)
  return transformESModules(patchClaudeCodeSource(code), carriesAsyncContext(code) ? carryAsyncContext : undefined);
}

/**
 * The cache file for the installed cli.js and its text when there is one
 * (path null: this build keeps none, or cli.js isn't there). Save to that
 * path, found before the run: a cli.js replaced during it gets its own.
 */
export async function readClaudeTransform(fs: Pick<CacheFs, 'readFile' | 'stat'>): Promise<{ path: string | null; text: string | null }> {
  let path: string | null;
  try { path = claudeTransformPath(await fs.stat(CLAUDE_CODE_CLI_JS)); } catch { return { path: null, text: null }; }
  if (!path) return { path, text: null };
  try {
    const text = await fs.readFile(path, 'utf8');
    return { path, text: typeof text === 'string' ? text : null };
  } catch {
    return { path, text: null };
  }
}

/** Save `text`, cli.js as this build transforms it, at `path` (readClaudeTransform's); older ones are removed */
export async function saveClaudeTransform(fs: Omit<CacheFs, 'stat'>, path: string, text: string): Promise<void> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  for (const f of await fs.readdir(CLAUDE_CODE_DIR).catch(() => [] as string[])) {
    if (f.startsWith(PREFIX) && f !== name) await fs.unlink(`${CLAUDE_CODE_DIR}/${f}`).catch(() => {});
  }
  // (under another name first: a write cut short is never taken for the text)
  await fs.writeFile(`${path}.partial`, text);
  await fs.rename(`${path}.partial`, path);
}
