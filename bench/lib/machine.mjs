// Which machine a results file was recorded on. Timings are only comparable
// between runs on the same machine (CPU, memory, kernel, browser); compare.mjs
// refuses to flag anything across machines. BENCH_MACHINE=<label> names a
// machine explicitly (e.g. two containers with the same CPU model that you
// know differ, or a CI runner class); otherwise the id is a hash of the
// hardware/software fields every results file records.
import { createHash } from 'node:crypto';

export function machineOf(env) {
  if (env?.machine?.id) return env.machine;
  const fields = [env?.cpu?.model, env?.cpu?.count, env?.memoryGiB, env?.os, env?.chromium];
  const id = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12);
  return { id, label: `${env?.cpu?.count ?? '?'}× ${env?.cpu?.model ?? '?'}, ${env?.memoryGiB ?? '?'} GiB, ${env?.os ?? '?'}, Chromium ${env?.chromium ?? '?'}` };
}

export function machineFor(env) {
  const m = machineOf({ ...env, machine: undefined });
  const label = process.env.BENCH_MACHINE;
  return label ? { id: `${label}:${m.id}`, label: `${label} (${m.label})` } : m;
}
