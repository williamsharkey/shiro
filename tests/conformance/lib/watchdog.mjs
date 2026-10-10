/**
 * A per-test deadline that a hung guest can't defeat. The harnesses poll
 * their own timeout with setTimeout on the thread that runs the kernel, so a
 * guest that keeps that thread busy (a synchronous spin, an Atomics.wait on
 * it) stops the poll too, and the run hangs with no result. The watchdog is a
 * worker thread with its own event loop: arm(name, ms) before a test,
 * disarm() after it. If the test is still armed `grace` ms past its deadline,
 * the harness thread is stuck: the watchdog records the test as a timeout in
 * the journal (and its detail file), says so on stderr, and kills the process,
 * so a *_RESUME=1 run continues after it instead of the run hanging for good.
 */
import { Worker } from 'node:worker_threads';

const SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
let armed = null;
parentPort.on('message', (m) => { armed = m; });
setInterval(() => {
  if (!armed || Date.now() < armed.deadline + workerData.grace) return;
  const { name, deadline } = armed;
  const reason = 'timeout: the harness stopped responding (watchdog)';
  try { appendFileSync(workerData.journal, JSON.stringify({ name, ok: false, reason, timeout: true }) + '\\n'); } catch {}
  try { writeFileSync(join(workerData.detailDir, name + '.txt'), '[watchdog] ' + reason + ' ' + (Date.now() - deadline) + ' ms past the deadline\\n[exit timeout]\\n'); } catch {}
  // (fd 2 itself: a worker's process.stderr goes through the stuck thread)
  writeSync(2, '[watchdog] ' + name + ' hung the harness; recorded as a timeout. Rerun with the suite\\'s _RESUME=1 to continue.\\n');
  process.kill(process.pid, 'SIGKILL');
}, 1000);
`;

/**
 * journal: the run's .jsonl; detailDir: where NAME.txt goes; grace: how long
 * past a deadline the harness may take to notice it itself.
 */
export function startWatchdog({ journal, detailDir, grace = 60_000 }) {
  // (a data: URL module: an eval'd worker is ESM or CommonJS depending on the parent)
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SOURCE)}`), { workerData: { journal, detailDir, grace } });
  worker.unref();
  return {
    arm(name, ms) { worker.postMessage({ name, deadline: Date.now() + ms }); },
    disarm() { worker.postMessage(null); },
    stop() { void worker.terminate(); },
  };
}
