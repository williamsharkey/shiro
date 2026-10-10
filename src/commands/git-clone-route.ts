// Small on purpose: main.ts gives it to git's lazy stub, before git.ts (isomorphic-git) loads.

/**
 * With the full git installed, `git clone` of an http(s) URL is still done by
 * the built-in git (axios: 12 s, against 96 s for the full git in Blink),
 * with the full git's defaults (all history, branches and tags), and the full
 * git takes the repository from there: the format on disk is the same. Only
 * for options the built-in clone has; anything else is the full git's.
 */
export function builtinCloneHandles(args: string[]): boolean {
  if (args[0] !== 'clone') return false;
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (['-q', '--quiet', '--single-branch', '--no-single-branch', '--no-tags'].includes(a)) continue;
    if (['--depth', '-b', '--branch', '-o', '--origin'].includes(a)) { if (++i >= args.length) return false; continue; }
    if (/^--(depth|branch|origin)=./.test(a)) continue;
    if (a.startsWith('-')) return false;
    positional.push(a);
  }
  // (credentials in the URL, user:token@host: the full git and its own handling of them)
  return positional.length >= 1 && positional.length <= 2 && /^https?:\/\/[^/@]+(\/|$)/.test(positional[0]);
}
