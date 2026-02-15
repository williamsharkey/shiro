import { CommandContext } from './index';
import { ghApi, parseFlags, getRepoFromFlags, detectRepo, timeAgo, isDryRun } from './gh';

const VALUE_FLAGS = [
  'title', 'notes', 'target', 'repo', 'R', 'json', 'L', 'limit',
];

export async function ghReleaseHandler(ctx: CommandContext, token: string): Promise<number> {
  const relSub = ctx.args[1];
  if (!relSub || relSub === '--help') {
    ctx.stdout = `usage: gh release <command> [flags]

Commands:
  list       List releases
  create     Create a release <tag> [--title] [--notes] [--target] [--draft] [--prerelease]
  view       View a release <tag>
  download   Download release assets <tag>
`;
    return 0;
  }

  if (!token) {
    ctx.stderr = 'error: authentication required. Set GITHUB_TOKEN.\n';
    return 1;
  }

  const { flags, positional } = parseFlags(ctx.args.slice(2), VALUE_FLAGS);
  const repo = getRepoFromFlags(flags) || await detectRepo(ctx);
  if (!repo) {
    ctx.stderr = 'error: could not detect repository. Use --repo owner/repo.\n';
    return 1;
  }
  const base = `/repos/${repo.owner}/${repo.repo}`;

  switch (relSub) {
    case 'list': {
      const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);
      const { status, data } = await ghApi(token, 'GET', `${base}/releases?per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      if (!data || data.length === 0) {
        ctx.stdout = 'No releases found\n';
        return 0;
      }
      for (const rel of data) {
        const tag = rel.tag_name.padEnd(20);
        const title = (rel.name || '').slice(0, 40).padEnd(40);
        const draft = rel.draft ? 'DRAFT' : rel.prerelease ? 'PRE' : 'LATEST';
        const age = timeAgo(rel.published_at || rel.created_at);
        ctx.stdout += `${tag}  ${title}  ${draft.padEnd(8)}  ${age}\n`;
      }
      return 0;
    }

    case 'create': {
      const tag = positional[0];
      if (!tag) {
        ctx.stderr = 'error: tag name is required\nusage: gh release create <tag> [--title] [--notes]\n';
        return 1;
      }
      const title = flags['title'] || tag;
      const notes = flags['notes'] || '';
      const target = flags['target'] || '';
      const draft = flags['draft'] === 'true';
      const prerelease = flags['prerelease'] === 'true';

      if (isDryRun(flags)) {
        ctx.stdout = `[dry-run] Would POST ${base}/releases\n`;
        ctx.stdout += `  tag: ${tag}\n`;
        ctx.stdout += `  title: ${JSON.stringify(title)}\n`;
        if (notes) ctx.stdout += `  notes: ${JSON.stringify(notes)}\n`;
        if (draft) ctx.stdout += `  draft: true\n`;
        if (prerelease) ctx.stdout += `  prerelease: true\n`;
        return 0;
      }

      const payload: any = {
        tag_name: tag,
        name: title,
        body: notes,
        draft,
        prerelease,
      };
      if (target) payload.target_commitish = target;

      const { status, data } = await ghApi(token, 'POST', `${base}/releases`, payload);
      if (status === 201) {
        ctx.stdout = `Created release ${data.tag_name}: ${data.name}\n${data.html_url}\n`;
      } else {
        ctx.stderr = `error: failed to create release (HTTP ${status}): ${data?.message || ''}\n`;
        return 1;
      }
      return 0;
    }

    case 'view': {
      const tag = positional[0];
      if (!tag) {
        ctx.stderr = 'usage: gh release view <tag>\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/releases/tags/${tag}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      ctx.stdout = `${data.tag_name}  ${data.name || ''}\n`;
      ctx.stdout += `Author: ${data.author?.login || 'unknown'}\n`;
      ctx.stdout += `Published: ${timeAgo(data.published_at || data.created_at)}\n`;
      if (data.draft) ctx.stdout += `Status: DRAFT\n`;
      if (data.prerelease) ctx.stdout += `Status: PRE-RELEASE\n`;
      if (data.body) ctx.stdout += `\n${data.body}\n`;
      const assets = data.assets || [];
      if (assets.length > 0) {
        ctx.stdout += `\nAssets:\n`;
        for (const a of assets) {
          ctx.stdout += `  ${a.name} (${(a.size / 1024).toFixed(1)} KB, ${a.download_count} downloads)\n`;
        }
      }
      ctx.stdout += `\n${data.html_url}\n`;
      return 0;
    }

    case 'download': {
      const tag = positional[0];
      if (!tag) {
        ctx.stderr = 'usage: gh release download <tag>\n';
        return 1;
      }
      const { status, data } = await ghApi(token, 'GET', `${base}/releases/tags/${tag}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const assets = data.assets || [];
      if (assets.length === 0) {
        ctx.stdout = 'No assets found for this release\n';
        return 0;
      }
      ctx.stdout = `Assets for ${tag}:\n`;
      for (const a of assets) {
        ctx.stdout += `  ${a.name} (${(a.size / 1024).toFixed(1)} KB)\n`;
        ctx.stdout += `    ${a.browser_download_url}\n`;
      }
      ctx.stdout += '\nNote: binary download is limited in browser environments. Use the URLs above.\n';
      return 0;
    }

    default:
      ctx.stderr = `gh release: '${relSub}' is not a valid subcommand. Valid: list, create, view, download\n`;
      return 1;
  }
}
