/**
 * Activity: the kernel's process table (what `ps` and `top` see) plus the
 * page's own jobs, refreshed every second, with a few machine meters.
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { processTable } from '../../process-table';

interface Row { pid: number; ppid: number | ''; name: string; cmd: string; state: string; cpu: number; syscalls: number | ''; started: number; kernel: boolean }

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function open(ctx: AppContext): DesktopWindow {
  const { wm, kernel } = ctx;
  const root = document.createElement('div');
  root.className = 'sd-app';
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="sd-toolbar" style="gap:18px;flex-wrap:wrap">
      <div style="min-width:110px"><div class="sd-small sd-muted">Processes</div><b data-k="count">–</b></div>
      <div style="min-width:110px"><div class="sd-small sd-muted">Running</div><b data-k="running">–</b></div>
      <div style="min-width:140px;flex:1"><div class="sd-small sd-muted">Page memory <span data-k="memtext"></span></div><div class="sd-meter" style="margin-top:6px"><i data-k="mem" style="width:0"></i></div></div>
      <div style="min-width:90px"><div class="sd-small sd-muted">Up</div><b data-k="up">–</b></div>
      <button class="sd-btn" data-act="kill" disabled title="Send SIGTERM">Quit Process</button>
    </div>
    <div class="sd-scroll"><table class="sd-table"><thead><tr>
      <th class="sd-num">PID</th><th>Name</th><th>State</th><th class="sd-num">CPU</th><th class="sd-num">Syscalls</th><th>Started</th><th>Command</th>
    </tr></thead><tbody></tbody></table></div>`;
  const tbody = root.querySelector('tbody')!;
  const k = (key: string) => root.querySelector<HTMLElement>(`[data-k=${key}]`)!;
  const killBtn = root.querySelector<HTMLButtonElement>('[data-act=kill]')!;
  let selected: number | null = null;
  let rows: Row[] = [];

  const collect = (): Row[] => {
    const out = new Map<number, Row>();
    for (const p of kernel.procs.values()) {
      const argv = p.argv ?? [];
      out.set(p.pid, {
        pid: p.pid, ppid: p.ppid, name: (argv[0] ?? '').split('/').pop() || (p.pid === 1 ? 'init' : '?'), cmd: argv.join(' '),
        state: p.state, cpu: p.kernelMs ?? 0, syscalls: p.syscalls ?? 0, started: p.startTime, kernel: true,
      });
    }
    for (const p of processTable.list()) {
      if (out.has(p.pid)) continue;
      out.set(p.pid, { pid: p.pid, ppid: '', name: p.command.split(/\s+/)[0] ?? '', cmd: p.command, state: p.status, cpu: 0, syscalls: '', started: p.startTime, kernel: false });
    }
    return [...out.values()].sort((a, b) => a.pid - b.pid);
  };

  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
  const render = () => {
    rows = collect();
    k('count').textContent = String(rows.length);
    k('running').textContent = String(rows.filter(r => r.state === 'running').length);
    k('up').textContent = fmtDur(performance.now());
    const mem = (performance as any).memory;
    if (mem?.jsHeapSizeLimit) {
      k('mem').style.width = `${Math.min(100, (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100 * 8).toFixed(1)}%`;
      k('memtext').textContent = `· ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB JS heap`;
    }
    tbody.innerHTML = rows.map(r => `<tr data-pid="${r.pid}"${r.pid === selected ? ' class="sd-selected"' : ''}>
      <td class="sd-num">${r.pid}</td><td><b>${esc(r.name)}</b></td><td>${esc(r.state)}</td>
      <td class="sd-num">${r.kernel ? (r.cpu / 1000).toFixed(2) + 's' : '—'}</td><td class="sd-num">${r.syscalls}</td>
      <td class="sd-muted">${timeFmt.format(r.started)}</td><td class="sd-muted" title="${esc(r.cmd)}">${esc(r.cmd)}</td></tr>`).join('');
    killBtn.disabled = selected === null || selected === 1 || !rows.some(r => r.pid === selected);
  };

  tbody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr');
    selected = tr ? Number(tr.dataset.pid) : null;
    render();
  });
  killBtn.addEventListener('click', () => {
    if (selected === null) return;
    const row = rows.find(r => r.pid === selected);
    if (!row) return;
    if (row.kernel) kernel.kill(selected, 15); else processTable.kill(selected);
    setTimeout(render, 100);
  });

  const win = wm.createWindow({ appId: 'activity', title: 'Activity', width: 760, height: 420, minWidth: 420, content: { kind: 'dom', element: root } });
  render();
  const timer = setInterval(() => { if (win.state !== 'minimized') render(); }, 1000);
  win.on('close', () => clearInterval(timer));
  return win;
}
