/** About This Computer: what this is, measured status, what's real and what's emulated. */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { ICONS } from '../icons';
import { BRAND } from '../../brand';
import buildNumber from '../../../build-number.txt?raw';

const REPO = 'https://github.com/williamsharkey/tabcomputer/blob/main/docs';

/**
 * Measured numbers, each with the document that records it. Update these
 * with the docs: they are claims a visitor will check.
 */
const STATUS = [
  { label: 'Debian 13 top-500 packages', value: '496/500', note: 'install with apt and run (popcon ranks 1–500)', doc: 'DEBIAN_SCORE.md' },
  { label: 'LTP syscall tests, x86-64', value: '237/320', note: 'pass under the x86-64 engine', doc: 'CONFORMANCE.md' },
];

export function open(ctx: AppContext): DesktopWindow {
  const { wm, kernel } = ctx;
  const root = document.createElement('div');
  root.className = 'sd-app sd-about';
  root.tabIndex = -1;
  const isolated = !!(globalThis as any).crossOriginIsolated;
  root.innerHTML = `
    <div class="sd-scroll"><div class="sd-panel" style="max-width:none">
      <div style="display:flex;gap:16px;align-items:center">
        <div class="sd-brand-mark" style="width:64px;flex:none">${ICONS.logo}</div>
        <div><h2>${BRAND.name}</h2><div class="sd-muted sd-small">${BRAND.tagline} · build #${buildNumber.trim()}</div></div>
      </div>
      <h3>Status</h3>
      <div class="sd-card">
        ${STATUS.map(s => `<div class="sd-row"><span class="sd-grow">${s.label}<div class="sd-small sd-muted">${s.note} · <a class="sd-link" href="${REPO}/${s.doc}" target="_blank" rel="noopener">${s.doc}</a></div></span><b style="font-variant-numeric:tabular-nums">${s.value}</b></div>`).join('')}
      </div>
      <h3>What's real</h3>
      <p class="sd-small sd-muted" style="line-height:1.6">A Unix kernel written for the browser: processes, file descriptors, pipes, ptys,
        signals, job control and sockets. Programs are real binaries: WebAssembly (WASI/WASIX) builds, and unmodified x86-64 Linux programs, including
        Debian's own (glibc, apt, dpkg) after <code>debian install</code>. TCP connections reach real hosts.
        Everything runs in this tab, on this device.</p>
      <h3>What's emulated</h3>
      <p class="sd-small sd-muted" style="line-height:1.6">The x86-64 CPU (Blink, compiled to WebAssembly, with a JIT). The disk: files live in this
        browser's IndexedDB. The network: TCP goes through a WebSocket relay (this site's, or your own in Settings → Network), on ports 22, 80,
        443 and 9418; UDP is DNS only.
        Graphical Linux apps draw through an X server inside the page.</p>
      <h3>Not here</h3>
      <p class="sd-small sd-muted" style="line-height:1.6">Hardware devices, kernel modules, and any access to your own machine: the browser's
        sandbox holds everything. Not yet: file watching (inotify), a D-Bus session bus. x86-64 programs start
        slowly. Some programs still fail; the scoreboards list which and why.</p>
      <h3>This tab</h3>
      <div class="sd-card sd-small">
        <div class="sd-row"><span class="sd-grow sd-muted">Kernel processes</span><span data-k="procs">${kernel.procs.size}</span></div>
        <div class="sd-row"><span class="sd-grow sd-muted">Syscalls from workers</span>${isolated ? 'SharedArrayBuffer (blocking)' : 'JSPI / in-page'}</div>
        <div class="sd-row"><span class="sd-grow sd-muted">Processor threads</span>${navigator.hardwareConcurrency || '?'}</div>
        <div class="sd-row"><span class="sd-grow sd-muted">Disk used</span><span data-k="disk">…</span></div>
      </div>
      <div class="sd-row" style="margin-top:14px;gap:14px;border:0">
        <a class="sd-link" href="${REPO}/DESKTOP.md" target="_blank" rel="noopener">Desktop &amp; /dom</a>
        <a class="sd-link" href="${REPO}/DEBIAN.md" target="_blank" rel="noopener">Debian</a>
        <a class="sd-link" href="${REPO}/CONFORMANCE.md" target="_blank" rel="noopener">Conformance</a>
        <a class="sd-link" href="${REPO}/BENCHMARKS.md" target="_blank" rel="noopener">Benchmarks</a>
      </div>
    </div></div>`;
  navigator.storage?.estimate?.().then(e => {
    const d = root.querySelector('[data-k=disk]');
    if (d) d.textContent = `${((e.usage ?? 0) / 1048576).toFixed(1)} MB of ${((e.quota ?? 0) / 1073741824).toFixed(0)} GB`;
  }).catch(() => {});
  return wm.createWindow({ appId: 'about', title: 'About This Computer', width: 520, height: 560, minWidth: 360, content: { kind: 'dom', element: root } });
}
