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
 * pinned version and cli.js's size; a build without a commit (tests) keeps none.
 */
import { CLAUDE_CODE_CLI_JS, CLAUDE_CODE_DIR, CLAUDE_CODE_VERSION, patchClaudeCodeSource } from './claude-code-version';

const PREFIX = '.tabcomputer-cli-';

interface CacheFs {
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const buildSha = (): string => (typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '');

/** FNV-1a of the key: a short file name */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The cache file for a cli.js of `size` bytes, or null when this build keeps none */
export function claudeTransformPath(size: number): string | null {
  const sha = buildSha();
  if (!sha) return null;
  return `${CLAUDE_CODE_DIR}/${PREFIX}${shortHash(`${sha}:${CLAUDE_CODE_VERSION}:${size}`)}.js`;
}

/** cli.js's text as node-compat runs it (execution.ts uses this too, so the two never differ) */
export async function transformClaudeSource(code: string): Promise<string> {
  const [{ transformESModules }, { carryAsyncContext }] = await Promise.all([
    import('./commands/jseval/module-transform'), import('./node-compat/async-context'),
  ]);
  // (the AsyncLocalStorage rewrite as the transform's pass, on its code mask: one scan)
  return transformESModules(patchClaudeCodeSource(code), code.includes('AsyncLocalStorage') ? carryAsyncContext : undefined);
}

/** The cached text for the installed cli.js, or null (none, stale, or not kept by this build) */
export async function readClaudeTransform(fs: Pick<CacheFs, 'readFile' | 'stat'>): Promise<string | null> {
  try {
    const path = claudeTransformPath((await fs.stat(CLAUDE_CODE_CLI_JS)).size);
    if (!path) return null;
    const text = await fs.readFile(path, 'utf8');
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

let writing: Promise<void> | null = null;

/** Save `text`, cli.js as this build transforms it, for the next run; older ones are removed */
export async function saveClaudeTransform(fs: CacheFs, text: string): Promise<void> {
  const path = claudeTransformPath((await fs.stat(CLAUDE_CODE_CLI_JS)).size);
  if (!path) return;
  const name = path.slice(path.lastIndexOf('/') + 1);
  for (const f of await fs.readdir(CLAUDE_CODE_DIR).catch(() => [] as string[])) {
    if (f.startsWith(PREFIX) && f !== name) await fs.unlink(`${CLAUDE_CODE_DIR}/${f}`).catch(() => {});
  }
  // (under another name first: a write cut short is never taken for the text)
  await fs.writeFile(`${path}.partial`, text);
  await fs.rename(`${path}.partial`, path);
}
