/**
 * Remote Panel - floating activity panel for MCP remote connections.
 *
 * Each MCP session gets its own draggable panel showing a timestamped
 * activity log (commands, reads, writes, evals, errors) and an input bar
 * for sending messages back to the remote agent.
 */

export type LogType = 'exec' | 'read' | 'write' | 'eval' | 'info' | 'error' | 'user';

export interface RemotePanel {
  element: HTMLDivElement;
  log(type: LogType, message: string): void;
  setTitle(title: string): void;
  close(): void;
  minimize(): void;
  deactivate(): void;
  setStatus(status: 'connected' | 'disconnected' | 'connecting'): void;
  onUserMessage?: (message: string) => void;
}

const LOG_COLORS: Record<LogType, string> = {
  exec: '#27c93f',   // green
  read: '#6699ff',   // blue
  write: '#6699ff',  // blue
  eval: '#febc2e',   // yellow
  info: '#66cccc',   // cyan
  error: '#ff5f57',  // red
  user: '#cccccc',   // white
};

const STATUS_COLORS: Record<string, string> = {
  connected: '#27c93f',
  disconnected: '#ff5f57',
  connecting: '#febc2e',
};

// Track panel count for stacking offset
let panelCount = 0;

export function createRemotePanel(sessionId: string, sessionName: string): RemotePanel {
  const offset = panelCount * 30;
  panelCount++;

  // Main wrapper
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-remote-panel', sessionId);
  const S = wrapper.style;
  S.position = 'fixed';
  S.top = `${60 + offset}px`;
  S.right = `${20 + offset}px`;
  S.width = '32em';
  S.height = '20em';
  S.zIndex = '2147483647';
  S.borderRadius = '8px';
  S.overflow = 'hidden';
  S.boxShadow = 'rgb(206,170,227) 0px 5px 11px -3px';
  S.fontFamily = '-apple-system,BlinkMacSystemFont,sans-serif';
  S.display = 'flex';
  S.flexDirection = 'column';
  S.background = '#1a1a2e';

  // Title bar
  const titleBar = document.createElement('div');
  const T = titleBar.style;
  T.background = '#1a1a2e';
  T.height = '32px';
  T.display = 'flex';
  T.alignItems = 'center';
  T.padding = '0 10px';
  T.cursor = 'grab';
  T.userSelect = 'none';
  T.flexShrink = '0';

  // Traffic light dots
  const dots = document.createElement('div');
  dots.style.display = 'flex';
  dots.style.gap = '6px';

  const onTap = (el: HTMLElement, handler: () => void) => {
    el.onclick = (e) => { e.stopPropagation(); handler(); };
    el.ontouchend = (e) => { e.preventDefault(); e.stopPropagation(); handler(); };
  };

  // Close button (red)
  const closeBtn = document.createElement('div');
  closeBtn.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#ff5f57;cursor:pointer';

  // Minimize button (yellow)
  const miniBtn = document.createElement('div');
  miniBtn.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#febc2e;cursor:pointer';
  let minimized = false;
  let savedH = 0;

  dots.appendChild(closeBtn);
  dots.appendChild(miniBtn);

  // Title text
  const title = document.createElement('span');
  title.textContent = sessionName;
  title.style.cssText = 'color:#8888cc;font-size:13px;font-weight:600;margin-left:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

  // Status dot
  const statusDot = document.createElement('div');
  statusDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#febc2e;margin-left:8px;flex-shrink:0';

  titleBar.appendChild(dots);
  titleBar.appendChild(title);
  titleBar.appendChild(statusDot);

  // Activity log
  const activityLog = document.createElement('div');
  const L = activityLog.style;
  L.flex = '1';
  L.overflowY = 'auto';
  L.padding = '6px 10px';
  L.fontFamily = 'monospace';
  L.fontSize = '12px';
  L.lineHeight = '1.4';
  L.background = '#0a0a1a';
  L.color = '#ccc';

  // Input bar
  const inputBar = document.createElement('div');
  inputBar.style.cssText = 'display:flex;padding:4px 6px;background:#1a1a2e;border-top:1px solid #333;flex-shrink:0';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Send message...';
  input.style.cssText = 'flex:1;background:#0a0a1a;border:1px solid #444;border-radius:4px;color:#ccc;padding:4px 8px;font-size:12px;font-family:monospace;outline:none';

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '>';
  sendBtn.style.cssText = 'background:#333;color:#ccc;border:none;border-radius:4px;margin-left:4px;padding:4px 8px;cursor:pointer;font-size:12px';

  let deactivated = false;

  const sendMessage = () => {
    if (deactivated) return;
    const text = input.value.trim();
    if (text && panel.onUserMessage) {
      panel.onUserMessage(text);
      input.value = '';
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  onTap(sendBtn, sendMessage);

  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);

  // Assemble
  wrapper.appendChild(titleBar);
  wrapper.appendChild(activityLog);
  wrapper.appendChild(inputBar);

  // --- Minimize ---
  onTap(miniBtn, () => {
    minimized = !minimized;
    if (minimized) {
      savedH = wrapper.offsetHeight;
      activityLog.style.display = 'none';
      inputBar.style.display = 'none';
      wrapper.style.height = '32px';
    } else {
      activityLog.style.display = 'block';
      inputBar.style.display = 'flex';
      wrapper.style.height = savedH + 'px';
    }
  });

  // --- Dragging ---
  let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
  titleBar.onmousedown = (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left; dy = r.top;
    titleBar.style.cursor = 'grabbing';
    e.preventDefault();
  };
  titleBar.ontouchstart = (e) => {
    dragging = true;
    const touch = e.touches[0];
    sx = touch.clientX; sy = touch.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left; dy = r.top;
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    wrapper.style.left = (dx + e.clientX - sx) + 'px';
    wrapper.style.top = (dy + e.clientY - sy) + 'px';
    wrapper.style.right = 'auto';
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!dragging) return;
    const touch = e.touches[0];
    wrapper.style.left = (dx + touch.clientX - sx) + 'px';
    wrapper.style.top = (dy + touch.clientY - sy) + 'px';
    wrapper.style.right = 'auto';
  };
  const onEnd = () => {
    dragging = false;
    titleBar.style.cursor = 'grab';
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onEnd);

  const cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onEnd);
    panelCount = Math.max(0, panelCount - 1);
  };

  // --- Close ---
  onTap(closeBtn, () => {
    cleanup();
    wrapper.remove();
  });

  document.body.appendChild(wrapper);

  // --- Log function ---
  function addLogEntry(type: LogType, message: string) {
    if (deactivated) return;
    const entry = document.createElement('div');
    entry.style.marginBottom = '2px';
    entry.style.wordBreak = 'break-all';

    const time = new Date();
    const ts = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;

    const timeSpan = document.createElement('span');
    timeSpan.textContent = ts + ' ';
    timeSpan.style.color = '#666';

    const msgSpan = document.createElement('span');
    msgSpan.style.color = LOG_COLORS[type];
    // Truncate long messages in display
    const display = message.length > 500 ? message.slice(0, 500) + '...' : message;
    msgSpan.textContent = display;

    entry.appendChild(timeSpan);
    entry.appendChild(msgSpan);
    activityLog.appendChild(entry);

    // Auto-scroll to bottom
    activityLog.scrollTop = activityLog.scrollHeight;
  }

  const panel: RemotePanel = {
    element: wrapper,
    setTitle(newTitle: string) { title.textContent = newTitle; },
    log: addLogEntry,
    close() {
      cleanup();
      wrapper.remove();
    },
    minimize() {
      miniBtn.click();
    },
    deactivate() {
      deactivated = true;
      panel.onUserMessage = undefined;
      // Dim the whole panel
      wrapper.style.opacity = '0.5';
      // Gray out title
      title.style.color = '#555';
      // Status dot → gray
      statusDot.style.background = '#555';
      // Disable input: keep text, change placeholder, gray out
      input.placeholder = 'Disconnected';
      input.style.color = '#555';
      input.style.borderColor = '#333';
      sendBtn.style.opacity = '0.3';
      sendBtn.style.cursor = 'default';
      // Lower z-index so new panels appear on top
      wrapper.style.zIndex = '2147483646';
    },
    setStatus(status) {
      if (deactivated) return;
      statusDot.style.background = STATUS_COLORS[status] || '#febc2e';
    },
  };

  return panel;
}

export function findRemotePanel(sessionId: string): RemotePanel | null {
  const el = document.querySelector(`[data-remote-panel="${sessionId}"]`) as HTMLDivElement | null;
  if (!el) return null;
  // Return a minimal wrapper for the existing element
  return {
    element: el,
    log() {},
    setTitle() {},
    close() { el.remove(); },
    minimize() {},
    deactivate() {},
    setStatus() {},
  };
}

export function closeRemotePanel(sessionId: string): void {
  const el = document.querySelector(`[data-remote-panel="${sessionId}"]`);
  if (el) {
    (el as any)._cleanup?.();
    el.remove();
    panelCount = Math.max(0, panelCount - 1);
  }
}
