/**
 * A first-visit tour: three short cards in the corner (what this is, Debian,
 * where files live). Non-blocking, dismissible, shown once per browser
 * (localStorage `shiro-desktop-tour`).
 */

import { BRAND } from '../brand';
import { GLYPHS } from './icons';
import type { AppContext } from './index';

export const TOUR_KEY = 'shiro-desktop-tour';

interface Card { title: string; body: string; action?: { label: string; run: (ctx: AppContext) => void } }

const CARDS: Card[] = [
  {
    title: 'A computer in a tab',
    body: `<p>${BRAND.name} is a Unix-like computer that runs in this browser tab: a kernel with processes, pipes, terminals and signals, and a shell. Programs run here, on your device, not on a server.</p>`,
  },
  {
    title: 'Real Linux programs',
    body: `<p>Install software with <code>apt install</code> — vim, htop, python3, git and more. For a whole Debian 13 system, run <code>debian install</code>: Debian's own x86-64 binaries run here in an emulator.</p>`,
    action: { label: 'Open Terminal', run: (ctx) => { ctx.openTerminal({ cwd: '/home/user' }); } },
  },
  {
    title: 'Your files stay here',
    body: `<p>Files are saved in this browser's storage on this device and survive reloads. Nothing is uploaded. Clearing this site's data erases them.</p>
      <p>Press <code>Ctrl+Space</code> to find apps, commands and files.</p>`,
  },
];

function seen(): boolean {
  try { return !!localStorage.getItem(TOUR_KEY); } catch { return true; }
}

/** Show the tour if this browser hasn't seen it. */
export function maybeShowTour(ctx: AppContext): void {
  if (seen()) return;
  showTour(ctx);
}

/** Show the tour now (Help menu). */
export function showTour(ctx: AppContext): void {
  // Marked at once: a reload mid-tour doesn't bring it back
  try { localStorage.setItem(TOUR_KEY, String(Date.now())); } catch {}
  document.querySelector('.sd-tour')?.remove();
  const box = document.createElement('div');
  box.className = 'sd-tour';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Welcome');
  let i = 0;
  const render = () => {
    const c = CARDS[i];
    const last = i === CARDS.length - 1;
    box.innerHTML = `
      <button class="sd-tour-x" type="button" aria-label="Close" data-act="close">${GLYPHS.x}</button>
      <h3>${c.title}</h3>${c.body}
      <div class="sd-tour-foot">
        <span class="sd-tour-dots">${CARDS.map((_, n) => `<i class="${n === i ? 'sd-on' : ''}"></i>`).join('')}</span>
        ${c.action ? `<button class="sd-btn" type="button" data-act="action">${c.action.label}</button>` : ''}
        <button class="sd-btn sd-primary" type="button" data-act="${last ? 'close' : 'next'}">${last ? 'Done' : 'Next'}</button>
      </div>`;
  };
  box.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') box.remove();
    else if (act === 'next') { i++; render(); }
    else if (act === 'action') CARDS[i].action?.run(ctx);
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.remove(); });
  render();
  ctx.wm.root.appendChild(box);
}
