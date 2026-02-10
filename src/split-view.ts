// split-view.ts — docked split pane beside/below terminal

export interface SplitView {
  pane: HTMLDivElement;
  iframe: HTMLIFrameElement;
  port: number;
  direction: 'right' | 'bottom';
  close: () => void;
}

let activeSplit: SplitView | null = null;

export function getActiveSplit(): SplitView | null {
  return activeSplit;
}

export function createSplitView(opts: {
  port: number;
  direction?: 'right' | 'bottom';
  title?: string;
  onClose?: () => void;
}): SplitView {
  // Close existing split first
  if (activeSplit) closeSplitView();

  const dir = opts.direction || 'right';
  const layout = document.getElementById('shiro-layout')!;

  // Create pane
  const pane = document.createElement('div');
  pane.id = 'split-pane';

  // Title bar
  const titlebar = document.createElement('div');
  titlebar.className = 'split-titlebar';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'split-close';
  closeBtn.onclick = () => closeSplitView();

  const titleEl = document.createElement('span');
  titleEl.className = 'split-title';
  titleEl.textContent = opts.title || `localhost:${opts.port}`;

  titlebar.appendChild(closeBtn);
  titlebar.appendChild(titleEl);
  pane.appendChild(titlebar);

  // Iframe
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-virtual-port', String(opts.port));
  pane.appendChild(iframe);

  // Add to layout
  layout.classList.add(dir === 'bottom' ? 'split-bottom' : 'split-right');
  layout.appendChild(pane);

  const split: SplitView = {
    pane,
    iframe,
    port: opts.port,
    direction: dir,
    close: () => closeSplitView(),
  };

  activeSplit = split;
  return split;
}

export function closeSplitView(): boolean {
  if (!activeSplit) return false;

  const layout = document.getElementById('shiro-layout');
  if (layout) {
    layout.classList.remove('split-right', 'split-bottom');
  }

  activeSplit.pane.remove();
  activeSplit = null;
  return true;
}
