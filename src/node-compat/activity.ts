/**
 * In-flight async work started by node scripts (fetch, fs.promises), so a script
 * whose synchronous part has returned can exit as soon as it goes quiet instead
 * of waiting out the full deferred-exit timeout. Page-wide: overlapping scripts
 * share fetch and can't be told apart, which errs toward waiting longer.
 */
export const activity = { pending: 0, last: 0 };

export function trackAsync<T>(p: Promise<T>): Promise<T> {
  activity.pending++;
  activity.last = performance.now();
  const done = () => { activity.pending--; activity.last = performance.now(); };
  p.then(done, done);
  return p;
}

/** Wrap every promise-returning function on a module object (fs.promises and friends). */
export function trackModule<T extends Record<string, any>>(mod: T): T {
  if (!mod || (mod as any).__shiroTracked) return mod;
  const out: any = {};
  for (const [key, value] of Object.entries(mod)) {
    out[key] = typeof value === 'function'
      ? function (this: any, ...args: any[]) {
          const r = value.apply(this, args);
          return r && typeof r.then === 'function' ? trackAsync(r) : r;
        }
      : value;
  }
  Object.defineProperty(out, '__shiroTracked', { value: true });
  return out;
}
