/**
 * The built-in gh's command lines, checked against what each subcommand
 * does (williamsharkey/tabcomputer#11). A flag it doesn't implement is an
 * error, as in upstream gh ("unknown flag: --web"), never silently
 * dropped. The rest is normalized for the handlers: short names and
 * `--flag=value` become `--long value`, and `--body-file FILE` / `-F FILE`
 * (`-` is stdin) become `--body CONTENT` (`--notes-file` → `--notes`).
 *
 * `--json FIELDS [--jq EXPR]` is done here too, with gh's field names
 * (url, author.login, createdAt, state OPEN/CLOSED/MERGED, ...): the
 * handler returns the API objects, mapped and filtered afterwards.
 */
import type { CommandContext } from './index';
import { evaluateJq } from './jq';

/** `name|s=` takes a value, `name|s` doesn't; `|s` is the short form */
const SPECS: Record<string, string> = {
  'issue list': 'state|s= limit|L= label|l= assignee|a= search|S= milestone|m= json= jq|q= template|t=',
  'issue create': 'title|t= body|b= body-file|F= label|l= assignee|a= milestone|m= project|p= dry-run',
  'issue view': 'json= jq|q= template|t=',
  'issue close': 'dry-run',
  'issue reopen': '',
  'issue comment': 'body|b= body-file|F= dry-run',
  'issue edit': 'title|t= body|b= body-file|F= add-label= dry-run',
  'issue delete': 'yes dry-run',
  'issue lock': '',
  'issue label': 'add= remove=',
  'pr list': 'state|s= limit|L= json= jq|q= template|t=',
  'pr create': 'title|t= body|b= body-file|F= base|B= head|H= draft|d label|l= reviewer|r= assignee|a= dry-run',
  'pr view': 'json= jq|q= template|t=',
  'pr merge': 'merge|m squash|s rebase|r delete-branch|d auto body|b= body-file|F= dry-run',
  'pr close': 'dry-run',
  'pr reopen': '',
  'pr comment': 'body|b= body-file|F= dry-run',
  'pr diff': '',
  'pr checks': '',
  'pr review': 'approve|a request-changes|r comment|c body|b= body-file|F= dry-run',
  'pr edit': 'title|t= body|b= body-file|F= base|B= dry-run',
  'pr ready': '',
  'release list': 'limit|L= json= jq|q= template|t=',
  'release create': 'title|t= notes|n= notes-file|F= target= draft|d prerelease|p dry-run',
  'release view': 'json= jq|q= template|t=',
  'release download': '',
  'label list': 'limit|L= json= jq|q= template|t=',
  'label create': 'color|c= description|d=',
  'search issues': 'limit|L= json= jq|q= template|t=',
  'search repos': 'limit|L= json= jq|q= template|t=',
  'workflow list': 'limit|L= json= jq|q= template|t=',
  'workflow view': '',
  'run list': 'limit|L= json= jq|q= template|t=',
  'run view': '',
  'repo view': 'json= jq|q= template|t=',
  'repo list': 'limit|L=',
  'repo create': 'public private internal source|s= description|d= homepage|h= remote|r= push clone',
  'repo delete': 'yes confirm',
  'repo clone': '',
  'auth status': 'hostname|h= show-token|t',
  'auth login': 'scopes|s= hostname|h= git-protocol|p= with-token web|w',
  'auth logout': 'hostname|h=',
  'auth refresh': 'scopes|s= remove-scopes|r= hostname|h=',
  'auth token': 'hostname|h=',
  'api': 'method|X= raw-field|f= field|F= header|H= jq|q= template|t= paginate dry-run',
};

export class GhUsageError extends Error {}

interface Opt { long: string; value: boolean }

function parseSpec(spec: string): Map<string, Opt> {
  const m = new Map<string, Opt>();
  for (const tok of ['repo|R=', 'help|h', ...spec.split(/\s+/).filter(Boolean)]) {
    const value = tok.endsWith('=');
    const [long, short] = tok.replace(/=$/, '').split('|');
    m.set('--' + long, { long, value });
    if (short) m.set('-' + short, { long, value });
  }
  return m;
}

/** What `gh GROUP SUB ...` gets after its flags are checked and normalized; null when there's no table for it */
export async function normalizeGhArgs(ctx: CommandContext, args: string[]): Promise<string[] | null> {
  const group = args[0];
  const key = group === 'api' ? 'api' : `${group} ${args[1] ?? ''}`;
  const spec = SPECS[key];
  if (spec === undefined) return null;
  const head = group === 'api' ? 1 : 2;
  const opts = parseSpec(spec);
  const out = args.slice(0, head);
  const rest = args.slice(head);
  let positionalOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (positionalOnly || a === '-' || !a.startsWith('-') || /^-\d/.test(a)) { out.push(a); continue; }
    if (a === '--') { positionalOnly = true; continue; }
    let name = a, attached: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { name = a.slice(0, eq); attached = a.slice(eq + 1); }
    } else if (a.length > 2) {
      name = a.slice(0, 2); attached = a.slice(2); // -L5, -Rowner/repo
    }
    const opt = opts.get(name);
    if (!opt) {
      throw new GhUsageError(a.startsWith('--')
        ? `unknown flag: ${name}`
        : `unknown shorthand flag: '${a[1]}' in ${a}`);
    }
    if (!opt.value) {
      if (attached !== undefined && name.startsWith('-') && !name.startsWith('--')) {
        throw new GhUsageError(`unknown shorthand flag: '${attached[0]}' in ${a}`);
      }
      if (attached === undefined || attached === 'true') out.push('--' + opt.long);
      continue;
    }
    let v = attached;
    if (v === undefined) {
      if (i + 1 >= rest.length) throw new GhUsageError(`flag needs an argument: ${name}`);
      v = rest[++i];
    }
    if (opt.long === 'body-file' || opt.long === 'notes-file') {
      // the file's text becomes the body (gh: "-" reads standard input)
      let text: string;
      if (v === '-') text = ctx.stdin;
      else {
        try {
          const data = await ctx.fs.readFile(ctx.fs.resolvePath(v, ctx.cwd), 'utf8');
          text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        } catch {
          throw new GhUsageError(`open ${v}: no such file or directory`);
        }
      }
      out.push(opt.long === 'body-file' ? '--body' : '--notes', text);
      continue;
    }
    if (group === 'api' && (opt.long === 'raw-field' || opt.long === 'field' || opt.long === 'header' || opt.long === 'method')) {
      // gh-api.ts reads these by their short names
      out.push({ 'raw-field': '-f', field: '-F', header: '-H', method: '-X' }[opt.long]!, v);
      continue;
    }
    out.push('--' + opt.long, v);
  }
  return out;
}

// ── --json, with gh's field names ────────────────────────────────────────

const person = (u: any) => (u ? { login: u.login, ...(u.name ? { name: u.name } : {}), ...(u.type === 'Bot' ? { is_bot: true } : {}) } : null);
const label = (l: any) => ({ id: l.node_id, name: l.name, description: l.description ?? '', color: l.color });
const upper = (s: any) => String(s ?? '').toUpperCase();

const ISSUE: Record<string, (d: any) => any> = {
  assignees: (d) => (d.assignees ?? []).map(person),
  author: (d) => person(d.user),
  body: (d) => d.body ?? '',
  closed: (d) => d.state === 'closed',
  closedAt: (d) => d.closed_at,
  comments: (d) => d.comments,
  createdAt: (d) => d.created_at,
  id: (d) => d.node_id,
  isPinned: () => false,
  labels: (d) => (d.labels ?? []).map(label),
  locked: (d) => !!d.locked,
  milestone: (d) => (d.milestone ? { number: d.milestone.number, title: d.milestone.title, description: d.milestone.description ?? '', dueOn: d.milestone.due_on } : null),
  number: (d) => d.number,
  state: (d) => upper(d.state),
  stateReason: (d) => upper(d.state_reason ?? ''),
  title: (d) => d.title,
  updatedAt: (d) => d.updated_at,
  url: (d) => d.html_url,
};

const PR: Record<string, (d: any) => any> = {
  ...ISSUE,
  additions: (d) => d.additions,
  baseRefName: (d) => d.base?.ref,
  changedFiles: (d) => d.changed_files,
  deletions: (d) => d.deletions,
  headRefName: (d) => d.head?.ref,
  headRefOid: (d) => d.head?.sha,
  headRepositoryOwner: (d) => person(d.head?.repo?.owner),
  isDraft: (d) => !!d.draft,
  mergeable: (d) => (d.mergeable === true ? 'MERGEABLE' : d.mergeable === false ? 'CONFLICTING' : 'UNKNOWN'),
  mergedAt: (d) => d.merged_at,
  mergeCommit: (d) => (d.merge_commit_sha ? { oid: d.merge_commit_sha } : null),
  reviewRequests: (d) => (d.requested_reviewers ?? []).map(person),
  state: (d) => (d.merged_at ? 'MERGED' : upper(d.state)),
};

const RELEASE: Record<string, (d: any) => any> = {
  assets: (d) => (d.assets ?? []).map((a: any) => ({ name: a.name, size: a.size, url: a.browser_download_url, contentType: a.content_type, downloadCount: a.download_count })),
  author: (d) => person(d.author),
  body: (d) => d.body ?? '',
  createdAt: (d) => d.created_at,
  id: (d) => d.node_id,
  isDraft: (d) => !!d.draft,
  isPrerelease: (d) => !!d.prerelease,
  name: (d) => d.name ?? '',
  publishedAt: (d) => d.published_at,
  tagName: (d) => d.tag_name,
  targetCommitish: (d) => d.target_commitish,
  url: (d) => d.html_url,
};

const LABEL: Record<string, (d: any) => any> = {
  color: (d) => d.color, description: (d) => d.description ?? '', id: (d) => d.node_id, isDefault: (d) => !!d.default, name: (d) => d.name, url: (d) => d.url,
};

const REPO_SEARCH: Record<string, (d: any) => any> = {
  createdAt: (d) => d.created_at, description: (d) => d.description ?? '', forksCount: (d) => d.forks_count, fullName: (d) => d.full_name,
  isArchived: (d) => !!d.archived, isFork: (d) => !!d.fork, isPrivate: (d) => !!d.private, language: (d) => d.language ?? '',
  name: (d) => d.name, owner: (d) => person(d.owner), stargazersCount: (d) => d.stargazers_count, updatedAt: (d) => d.updated_at,
  url: (d) => d.html_url, visibility: (d) => d.visibility,
};

const RUN: Record<string, (d: any) => any> = {
  conclusion: (d) => d.conclusion ?? '', createdAt: (d) => d.created_at, databaseId: (d) => d.id, displayTitle: (d) => d.display_title,
  event: (d) => d.event, headBranch: (d) => d.head_branch, headSha: (d) => d.head_sha, name: (d) => d.name, number: (d) => d.run_number,
  status: (d) => d.status, updatedAt: (d) => d.updated_at, url: (d) => d.html_url, workflowDatabaseId: (d) => d.workflow_id, workflowName: (d) => d.name,
};

const WORKFLOW: Record<string, (d: any) => any> = {
  id: (d) => d.id, name: (d) => d.name, path: (d) => d.path, state: (d) => d.state,
};

/** The gh field table for `gh GROUP SUB --json` (null: the handler writes gh's fields itself, as repo view does) */
function fieldsFor(group: string, sub: string): Record<string, (d: any) => any> | null {
  if (group === 'issue') return ISSUE;
  if (group === 'pr') return PR;
  if (group === 'release') return RELEASE;
  if (group === 'label') return LABEL;
  if (group === 'search') return sub === 'repos' ? REPO_SEARCH : ISSUE;
  if (group === 'run') return RUN;
  if (group === 'workflow') return WORKFLOW;
  return null;
}

export interface JsonRequest { fields: string[] | null; jq?: string; table: Record<string, (d: any) => any> | null }

/** Take --json/--jq/--template out of normalized args: what the handler should do instead, and what to do with its output */
export function takeJsonFlags(args: string[]): { args: string[]; req: JsonRequest | null } {
  const out: string[] = [];
  let json: string | undefined, jq: string | undefined, template: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = args[++i];
    else if (args[i] === '--jq') jq = args[++i];
    else if (args[i] === '--template') template = args[++i];
    else out.push(args[i]);
  }
  if (args[0] === 'api') {
    // gh api has no --json; its --jq is gh-api.ts's
    if (template !== undefined) throw new GhUsageError('--template is not supported by the built-in gh; use --jq');
    return { args: [...out, ...(jq !== undefined ? ['--jq', jq] : [])], req: null };
  }
  if (template !== undefined) throw new GhUsageError('--template is not supported by the built-in gh; use --jq');
  if (json === undefined) {
    if (jq !== undefined) throw new GhUsageError('cannot use `--jq` without specifying `--json`');
    return { args: out, req: null };
  }
  const table = fieldsFor(args[0], args[1]);
  const fields = json.split(',').map((f) => f.trim()).filter(Boolean);
  if (table) {
    const unknown = fields.find((f) => !(f in table));
    if (!fields.length || unknown) {
      throw new GhUsageError((unknown ? `Unknown JSON field: "${unknown}"\n` : 'Specify one or more comma-separated fields for `--json`:\n')
        + `Available fields:\n${Object.keys(table).sort().map((f) => '  ' + f).join('\n')}`);
    }
    // the handler prints the API's objects whole ("*"); they're mapped afterwards
    return { args: [...out, '--json', '*'], req: { fields, jq, table } };
  }
  return { args: [...out, '--json', json], req: { fields: null, jq, table: null } };
}

/** The handler's JSON output, as gh prints it for the request */
export function finishJson(ctx: CommandContext, req: JsonRequest, sub: string): number {
  let data: any;
  try {
    data = JSON.parse(ctx.stdout);
  } catch {
    // "No issues match your search" and the like: an empty list
    if (sub === 'list' || sub === 'issues' || sub === 'repos') data = [];
    else return 0;
  }
  if (req.table && req.fields) {
    const pick = (d: any) => Object.fromEntries(req.fields!.map((f) => [f, req.table![f](d)]));
    data = Array.isArray(data) ? data.map(pick) : pick(data);
  }
  if (req.jq !== undefined) {
    // like gh: string results raw (jq -r)
    let result: string;
    try { result = evaluateJq(data, req.jq, true, true); } catch (e: any) {
      ctx.stdout = '';
      ctx.stderr += `failed to parse jq expression: ${e?.message ?? e}\n`;
      return 1;
    }
    ctx.stdout = result.split('\n').map((line) => {
      if (!line.startsWith('"')) return line;
      try { const v = JSON.parse(line); return typeof v === 'string' ? v : line; } catch { return line; }
    }).join('\n');
    if (ctx.stdout && !ctx.stdout.endsWith('\n')) ctx.stdout += '\n';
    return 0;
  }
  ctx.stdout = JSON.stringify(data, null, 2) + '\n';
  return 0;
}
