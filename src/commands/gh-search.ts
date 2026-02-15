import { CommandContext } from './index';
import { ghApi, parseFlags, isDryRun } from './gh';

const VALUE_FLAGS = ['L', 'limit', 'json'];

export async function ghSearchHandler(ctx: CommandContext, token: string): Promise<number> {
  const sub = ctx.args[1];
  if (!sub || sub === '--help') {
    ctx.stdout = `usage: gh search <command> <query> [flags]

Commands:
  issues   Search issues
  repos    Search repositories
`;
    return 0;
  }

  const { flags, positional } = parseFlags(ctx.args.slice(2), VALUE_FLAGS);
  const query = positional.join(' ');
  if (!query) {
    ctx.stderr = `error: search query is required\nusage: gh search ${sub} <query>\n`;
    return 1;
  }
  const limit = parseInt(flags['L'] || flags['limit'] || '30', 10);

  switch (sub) {
    case 'issues': {
      const { status, data } = await ghApi(token, 'GET', `/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const items = data.items || [];
      if (items.length === 0) {
        ctx.stdout = 'No issues found\n';
        return 0;
      }
      for (const item of items) {
        const repo = item.repository_url?.split('/').slice(-2).join('/') || '';
        const num = `#${item.number}`.padEnd(7);
        const title = (item.title || '').slice(0, 60);
        ctx.stdout += `${repo}  ${num}  ${title}\n`;
      }
      ctx.stdout += `\n${data.total_count} results\n`;
      return 0;
    }

    case 'repos': {
      const { status, data } = await ghApi(token, 'GET', `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`);
      if (status !== 200) {
        ctx.stderr = `error: API returned ${status}: ${data?.message || ''}\n`;
        return 1;
      }
      const items = data.items || [];
      if (items.length === 0) {
        ctx.stdout = 'No repositories found\n';
        return 0;
      }
      for (const item of items) {
        const name = (item.full_name || '').padEnd(35);
        const stars = `★${item.stargazers_count || 0}`.padEnd(8);
        const desc = (item.description || '').slice(0, 50);
        ctx.stdout += `${name}  ${stars}  ${desc}\n`;
      }
      ctx.stdout += `\n${data.total_count} results\n`;
      return 0;
    }

    default:
      ctx.stderr = `gh search: '${sub}' is not a valid subcommand. Valid: issues, repos\n`;
      return 1;
  }
}
