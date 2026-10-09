/**
 * In-flight async work started by a node script (fetch, fs.promises), so a
 * script whose synchronous part has returned can exit as soon as it goes quiet
 * instead of waiting out the full deferred-exit timeout.
 *
 * One tracker per script: a page-wide count let a parent script waiting on its
 * child (pnpm run → node app.js) keep the child from ever looking idle, and
 * each waited on the other until the deferred-exit cap. Overlapping scripts
 * still share the page's fetch, which errs toward waiting longer.
 */
export interface ActivityTracker {
  activity: { pending: number; last: number };
  trackAsync<T>(p: Promise<T>): Promise<T>;
  /** Wrap every promise-returning function on a module object (fs.promises and friends). */
  trackModule<T extends Record<string, any>>(mod: T): T;
}

export function createActivity(): ActivityTracker {
  const activity = { pending: 0, last: 0 };
  const marker = Symbol('shiroTracked');
  const trackAsync = <T>(p: Promise<T>): Promise<T> => {
    activity.pending++;
    activity.last = performance.now();
    const done = () => { activity.pending--; activity.last = performance.now(); };
    p.then(done, done);
    return p;
  };
  const trackModule = <T extends Record<string, any>>(mod: T): T => {
    if (!mod || (mod as any)[marker]) return mod;
    const out: any = {};
    for (const [key, value] of Object.entries(mod)) {
      out[key] = typeof value === 'function'
        ? function (this: any, ...args: any[]) {
            const r = value.apply(this, args);
            return r && typeof r.then === 'function' ? trackAsync(r) : r;
          }
        : value;
    }
    Object.defineProperty(out, marker, { value: true });
    return out;
  };
  return { activity, trackAsync, trackModule };
}
