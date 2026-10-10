/**
 * isomorphic-git with one `cache` object shared by every call while a git
 * command runs. Without a cache, each object read parses the pack's .idx and
 * reads the whole .pack again: `git log` over 2,222 commits of a 28 MiB pack
 * took 64 s. Packs are named by their content, and new ones are found by
 * listing objects/pack on every read, so a cache can't go stale; it is
 * dropped when the last git command finishes, to free the pack.
 */
import isogit from 'isomorphic-git';
export { TREE, STAGE, WORKDIR } from 'isomorphic-git';

let cache: object | null = null;
let active = 0;

/** Run `fn` with the shared cache (nested and concurrent runs share one) */
export async function withGitCache<T>(fn: () => Promise<T>): Promise<T> {
  active++;
  cache ??= {};
  try {
    return await fn();
  } finally {
    if (--active === 0) cache = null;
  }
}

const git: typeof isogit = new Proxy(isogit, {
  get(target, key, receiver) {
    const v = Reflect.get(target, key, receiver);
    if (typeof v !== 'function') return v;
    return (args?: any, ...rest: any[]) => {
      if (cache && args && typeof args === 'object' && args.cache === undefined) args = { ...args, cache };
      return v.call(target, args, ...rest);
    };
  },
});

export default git;
