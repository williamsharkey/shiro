import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, isDryRun } from './gh';
import { evaluateJq } from './jq';

export async function ghApiHandler(ctx: CommandContext, token: string): Promise<number> {
  const valueFlags = ['X', 'f', 'F', 'H', 'repo', 'R', 'jq', 'template'];
  const { flags, positional } = parseFlags(ctx.args.slice(1), valueFlags);
  const path = positional[0];
  if (!path) {
    ctx.stderr = 'usage: gh api <path> [-X METHOD] [-f key=value] [--jq EXPR] [--paginate] [--dry-run]\n';
    return 1;
  }

  let method = (flags['X'] || 'GET').toUpperCase();

  // Parse -f/-F key=value fields into body
  let body: Record<string, any> | undefined;
  const fieldArgs = ctx.args.slice(1);
  for (let i = 0; i < fieldArgs.length; i++) {
    if ((fieldArgs[i] === '-f' || fieldArgs[i] === '-F') && fieldArgs[i + 1]) {
      const kv = fieldArgs[++i];
      const eq = kv.indexOf('=');
      if (eq > 0) {
        if (!body) body = {};
        const key = kv.slice(0, eq);
        const val = kv.slice(eq + 1);
        if (fieldArgs[i - 1] === '-F') {
          // -F: try to parse as JSON
          try { body[key] = JSON.parse(val); } catch { body[key] = val; }
        } else {
          body[key] = val;
        }
      }
    }
  }

  // Parse -H headers
  const extraHeaders: Record<string, string> = {};
  for (let i = 0; i < fieldArgs.length; i++) {
    if (fieldArgs[i] === '-H' && fieldArgs[i + 1]) {
      const hdr = fieldArgs[++i];
      const colon = hdr.indexOf(':');
      if (colon > 0) {
        extraHeaders[hdr.slice(0, colon).trim()] = hdr.slice(colon + 1).trim();
      }
    }
  }

  // Expand {owner}/{repo} placeholders
  let resolvedPath = path;
  if (resolvedPath.includes('{owner}') || resolvedPath.includes('{repo}')) {
    const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
    if (repo) {
      resolvedPath = resolvedPath.replace('{owner}', repo.owner).replace('{repo}', repo.repo);
    }
  }

  // Bug fix: GraphQL must use POST
  if (resolvedPath === 'graphql' || resolvedPath === '/graphql') {
    method = 'POST';
  }

  // Bug fix: GET requests can't have a body — convert fields to query params
  if (method === 'GET' && body) {
    const sep = resolvedPath.includes('?') ? '&' : '?';
    const params = Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    resolvedPath += sep + params;
    body = undefined;
  }

  // Bug fix: --dry-run shows preview instead of executing
  if (isDryRun(flags) && method !== 'GET') {
    ctx.stdout = `[dry-run] Would ${method} /${resolvedPath.replace(/^\//, '')}\n`;
    if (body) {
      for (const [k, v] of Object.entries(body)) {
        ctx.stdout += `  ${k}: ${JSON.stringify(v)}\n`;
      }
    }
    return 0;
  }

  if (!token) {
    ctx.stderr = 'warning: no token set, request may fail for private resources\n';
  }

  const jqExpr = flags['jq'];
  const paginate = flags['paginate'] === 'true';

  if (paginate) {
    // Append per_page=100 for efficiency
    const pageSep = resolvedPath.includes('?') ? '&' : '?';
    if (!resolvedPath.includes('per_page=')) {
      resolvedPath += pageSep + 'per_page=100';
    }
    // Collect all pages
    let allData: any[] = [];
    let nextUrl: string | null = resolvedPath;
    while (nextUrl) {
      const { status, data, headers } = await ghApi(token, method, nextUrl, body, extraHeaders);
      if (status >= 400) {
        ctx.stderr = `error: API returned ${status}\n`;
        ctx.stdout = JSON.stringify(data, null, 2) + '\n';
        return 1;
      }
      if (Array.isArray(data)) {
        allData = allData.concat(data);
      } else {
        allData.push(data);
      }
      // Parse Link header for next page
      nextUrl = null;
      const link = headers.get('link') || headers.get('Link');
      if (link) {
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        if (m) nextUrl = m[1];
      }
    }
    const result = allData;
    if (jqExpr) {
      ctx.stdout = evaluateJq(result, jqExpr);
    } else {
      ctx.stdout = JSON.stringify(result, null, 2) + '\n';
    }
    return 0;
  }

  const { status, data } = await ghApi(token, method, resolvedPath, body, extraHeaders);
  if (status >= 400) {
    ctx.stderr = `error: API returned ${status}\n`;
  }

  // Bug fix: --jq filters the output
  if (jqExpr) {
    ctx.stdout = evaluateJq(data, jqExpr);
  } else {
    ctx.stdout = JSON.stringify(data, null, 2) + '\n';
  }
  return status >= 400 ? 1 : 0;
}
