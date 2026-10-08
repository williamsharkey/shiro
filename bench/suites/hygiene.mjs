// Memory hygiene: what stays behind after short processes and after
// opening/closing panes. Each round's numbers are deltas against the state
// before that round (after a forced GC), so a steady leak shows as a
// positive median. Retained Workers come from Playwright's worker list,
// SharedArrayBuffers/shared memories from bench/lib/inpage.js's weak refs.
import { MB } from '../lib/harness.mjs';
import { setupKbench } from './kernel.mjs';

export const name = 'hygiene';

async function snapshot(h) {
  const m = await h.memory({ uasm: false });
  const k = await h.eval(() => ({ ...window.__bench.kernelStats(), ...window.__bench.liveShared(), terminals: document.querySelectorAll('.xterm').length }));
  return { ...m, ...k, workers: h.page.workers().length };
}

function deltas(before, after) {
  const d = {};
  for (const k of Object.keys(after)) if (typeof after[k] === 'number' && typeof before[k] === 'number') d[k] = after[k] - before[k];
  return d;
}

export async function run(h) {
  const rounds = h.quick ? 2 : h.runs;
  const procMode = await h.eval(() => (crossOriginIsolated ? 'sab' : typeof WebAssembly.Suspending === 'function' ? 'jspi' : 'none'));
  if (procMode !== 'none') await setupKbench(h);

  await h.try('hygiene.procs100', 'MiB', async () => {
    const ds = [];
    let first = null, last = null;
    for (let r = 0; r < rounds; r++) {
      const before = await snapshot(h);
      first ??= before;
      await h.eval(async (wasm) => {
        const B = window.__bench;
        for (let i = 0; i < 50; i++) await B.sh('echo hi | cat > /dev/null');
        if (wasm) for (let i = 0; i < 50; i++) await B.runProcs([['/home/user/b/kbench.wasm', 'nop']]);
        else for (let i = 0; i < 50; i++) await B.runProcs([['true']]);
      }, procMode !== 'none');
      await h.page.waitForTimeout(500); // let workers terminate
      last = await snapshot(h);
      ds.push(deltas(before, last));
    }
    const what = procMode !== 'none' ? '50 shell pipelines + 50 kbench.wasm spawns' : '50 shell pipelines + 50 builtin spawns';
    h.sample('hygiene.procs100.js_heap_delta', ds.map((d) => d.jsHeapUsed / MB), 'MiB', { notes: `per round of ${what}, after GC` });
    h.sample('hygiene.procs100.rss_delta', ds.map((d) => d.rendererRss / MB), 'MiB', { notes: 'renderer RSS change per round' });
    h.sample('hygiene.procs100.workers_left', [last.workers - first.workers], 'count', { notes: `live Workers added over ${rounds} rounds (${last.workers} total now)` });
    h.sample('hygiene.procs100.sabs_left', [last.sabs - first.sabs], 'count', { notes: `SharedArrayBuffers still reachable after GC (${(last.sabBytes / MB).toFixed(1)} MiB total)` });
    h.sample('hygiene.procs100.shared_mem_left', [last.sharedMemories - first.sharedMemories], 'count', { notes: 'shared WebAssembly.Memory objects still reachable after GC' });
    h.sample('hygiene.procs100.kernel_procs_left', [last.procs - first.procs], 'count', { notes: `kernel process table growth (zombies now: ${last.zombies})` });
    h.sample('hygiene.procs100.fds_left', [last.fds - first.fds], 'count', { notes: 'open fds summed over all kernel processes, growth' });
    h.sample('hygiene.procs100.total_heap_growth', [(last.jsHeapUsed - first.jsHeapUsed) / MB], 'MiB', { notes: `JS heap growth over ${rounds * 100} processes` });
  });

  await h.try('hygiene.panes10', 'MiB', async () => {
    const ds = [];
    let first = null, last = null;
    let opened = 0;
    for (let r = 0; r < rounds; r++) {
      const before = await snapshot(h);
      first ??= before;
      for (let i = 0; i < 10; i++) {
        const box = await h.page.locator('#terminal > .shiro-corner.tr').boundingBox();
        if (!box) throw new Error('no pane corner');
        await h.page.mouse.move(box.x + 4, box.y + 2);
        await h.page.mouse.down();
        await h.page.mouse.move(box.x - 150, box.y + 10, { steps: 4 });
        await h.page.mouse.move(box.x - 300, box.y + 20, { steps: 4 });
        await h.page.mouse.up();
        opened = Math.max(opened, await h.eval(() => document.querySelectorAll('.shiro-pane').length));
        await h.eval(() => window.__shiroPanes.reset());
      }
      await h.page.waitForTimeout(300);
      last = await snapshot(h);
      ds.push(deltas(before, last));
    }
    if (opened < 2) throw new Error('dragging the corner did not split the pane');
    h.sample('hygiene.panes10.js_heap_delta', ds.map((d) => d.jsHeapUsed / MB), 'MiB', { notes: 'per round of 10 pane splits + closes, after GC' });
    h.sample('hygiene.panes10.dom_nodes_delta', ds.map((d) => d.nodes), 'count', { notes: 'DOM nodes left per round' });
    h.sample('hygiene.panes10.listeners_delta', ds.map((d) => d.listeners), 'count', { notes: 'JS event listeners left per round' });
    h.sample('hygiene.panes10.terminals_left', [last.terminals - first.terminals], 'count', { notes: '.xterm elements left after all rounds' });
    h.sample('hygiene.panes10.total_heap_growth', [(last.jsHeapUsed - first.jsHeapUsed) / MB], 'MiB', { notes: `JS heap growth over ${rounds * 10} pane open/close cycles` });
  });
}
