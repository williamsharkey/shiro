/** About This Computer */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { ICONS } from '../icons';
import buildNumber from '../../../build-number.txt?raw';

export function open(ctx: AppContext): DesktopWindow {
  const { wm, kernel } = ctx;
  const root = document.createElement('div');
  root.className = 'sd-app';
  root.style.cssText = 'align-items:center;justify-content:center;text-align:center;padding:24px';
  const isolated = !!(globalThis as any).crossOriginIsolated;
  root.innerHTML = `
    <div style="width:84px;height:84px">${ICONS.about}</div>
    <h2 style="font-size:22px;font-weight:700;margin-top:10px;letter-spacing:-.01em">unix.computer</h2>
    <div class="sd-muted sd-small">Build #${buildNumber.trim()} · Shiro kernel</div>
    <div class="sd-card sd-small" style="margin-top:16px;text-align:left;min-width:280px">
      <div class="sd-row"><span class="sd-grow sd-muted">Processes</span><span data-k="procs">${kernel.procs.size}</span></div>
      <div class="sd-row"><span class="sd-grow sd-muted">Programs</span>WASI · WASIX · x86-64 Linux</div>
      <div class="sd-row"><span class="sd-grow sd-muted">Syscalls from workers</span>${isolated ? 'SharedArrayBuffer' : 'JSPI / in-page'}</div>
      <div class="sd-row"><span class="sd-grow sd-muted">Threads</span>${navigator.hardwareConcurrency || '?'}</div>
      <div class="sd-row"><span class="sd-grow sd-muted">Disk used</span><span data-k="disk">…</span></div>
    </div>
    <div class="sd-small sd-muted" style="margin-top:14px">Everything runs in this tab. Files live in your browser's storage.</div>`;
  navigator.storage?.estimate?.().then(e => {
    const d = root.querySelector('[data-k=disk]');
    if (d) d.textContent = `${((e.usage ?? 0) / 1048576).toFixed(1)} MB of ${((e.quota ?? 0) / 1073741824).toFixed(0)} GB`;
  }).catch(() => {});
  return wm.createWindow({ appId: 'about', title: 'About This Computer', width: 380, height: 400, resizable: false, content: { kind: 'dom', element: root } });
}
