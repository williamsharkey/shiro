// CPU profiles through CDP: BENCH_PROFILE=<regex> profiles every metric whose
// name matches (main thread), writes bench/.cache/profiles/<metric>.cpuprofile
// (open in Chrome DevTools → Performance) and logs the top self-time functions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'profiles');

export async function startProfile(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
}

export async function stopProfile(cdp, name, log, top = 15) {
  const { profile } = await cdp.send('Profiler.stop');
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${name.replace(/[^\w.-]/g, '_')}.cpuprofile`);
  writeFileSync(file, JSON.stringify(profile));
  for (const line of summarize(profile, top)) log(`      ${line}`);
  log(`      profile: ${file}`);
  return file;
}

/** Top functions by self time: "12.3%  45 ms  fn  file:line". */
export function summarize(profile, top = 15) {
  const dt = new Map();
  const { samples, timeDeltas, nodes } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) || 0) + (timeDeltas[i] || 0));
  const agg = new Map();
  let total = 0;
  for (const [id, us] of dt) {
    const n = byId.get(id);
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'}  ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) || 0) + us);
    total += us;
  }
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, us]) => `${((us / total) * 100).toFixed(1).padStart(5)}%  ${String(Math.round(us / 1000)).padStart(6)} ms  ${k}`);
}
