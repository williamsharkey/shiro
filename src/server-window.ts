/**
 * Server Window - macOS-style window wrapper for iframe content
 *
 * Creates a draggable, resizable window with traffic light controls
 * and a title bar showing the server info.
 */

export interface ServerWindowOptions {
  port?: number;
  path?: string;
  directory?: string;
  width?: string;
  height?: string;
  container?: HTMLElement;
  mode?: 'iframe' | 'terminal';
  title?: string;
  onClose?: () => void;
}

export interface ServerWindow {
  element: HTMLDivElement;
  iframe: HTMLIFrameElement;
  contentDiv: HTMLDivElement | null;
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  setTitle: (title: string) => void;
  updateIframe: (html: string) => void;
}

export function createServerWindow(options: ServerWindowOptions): ServerWindow {
  const { port, path = '/', directory, width = '32em', height = '22em', container = document.body, mode = 'iframe', onClose } = options;

  // Build title
  const titleText = options.title
    ? options.title
    : directory
      ? `${directory}:${port}${path}`
      : port != null ? `localhost:${port}${path}` : 'terminal';

  // Calculate responsive positioning
  // If viewport can't contain the window with 10% margin on each side, constrain it
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 0.1; // 10% margin on each side
  const maxWidth = vw * (1 - margin * 2); // 80% of viewport

  // Convert em width to pixels (assume 16px base font)
  const emMatch = width.match(/^([\d.]+)em$/);
  const requestedWidth = emMatch ? parseFloat(emMatch[1]) * 16 : 512;

  // Determine actual width and positioning
  const needsConstrain = requestedWidth > maxWidth;
  const actualWidth = needsConstrain ? `${maxWidth}px` : width;
  const horizontalPos = needsConstrain
    ? { left: `${vw * margin}px`, right: 'auto' }
    : { right: '20px', left: 'auto' };

  // Main wrapper
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-server-window', port != null ? String(port) : (options.title || 'terminal'));
  const S = wrapper.style;
  S.position = 'fixed';
  S.bottom = '20px';
  S.left = horizontalPos.left;
  S.right = horizontalPos.right;
  S.width = actualWidth;
  S.height = height;
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

  // Traffic light container
  const dots = document.createElement('div');
  dots.style.display = 'flex';
  dots.style.gap = '6px';

  // Helper to add both click and touch handlers (mobile Safari needs touchend)
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

  // Maximize button (green)
  const maxBtn = document.createElement('div');
  maxBtn.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#27c93f;cursor:pointer';
  let maximized = false;
  let savedState = { width: '', height: '', top: '', left: '', bottom: '', right: '', borderRadius: '' };

  // Wire up button handlers with touch support
  onTap(closeBtn, () => {
    onClose?.();
    (wrapper as any)._cleanup?.();
    wrapper.remove();
  });

  onTap(miniBtn, () => {
    minimized = !minimized;
    if (minimized) {
      savedH = wrapper.offsetHeight;
      contentElement.style.display = 'none';
      resizeHandle.style.display = 'none';
      wrapper.style.height = '32px';
    } else {
      contentElement.style.display = mode === 'terminal' ? 'flex' : 'block';
      resizeHandle.style.display = 'block';
      wrapper.style.height = savedH + 'px';
    }
  });

  onTap(maxBtn, () => {
    if (maximized) {
      // Restore
      wrapper.style.width = savedState.width;
      wrapper.style.height = savedState.height;
      wrapper.style.top = savedState.top;
      wrapper.style.left = savedState.left;
      wrapper.style.bottom = savedState.bottom;
      wrapper.style.right = savedState.right;
      wrapper.style.borderRadius = savedState.borderRadius;
      resizeHandle.style.display = 'block';
    } else {
      // Maximize
      savedState = {
        width: wrapper.style.width,
        height: wrapper.style.height,
        top: wrapper.style.top,
        left: wrapper.style.left,
        bottom: wrapper.style.bottom,
        right: wrapper.style.right,
        borderRadius: wrapper.style.borderRadius,
      };
      wrapper.style.width = '100vw';
      wrapper.style.height = '100vh';
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.bottom = 'auto';
      wrapper.style.right = 'auto';
      wrapper.style.borderRadius = '0';
      resizeHandle.style.display = 'none';
    }
    maximized = !maximized;
  });

  dots.appendChild(closeBtn);
  dots.appendChild(miniBtn);
  dots.appendChild(maxBtn);

  // Title
  const title = document.createElement('span');
  title.textContent = titleText;
  title.style.cssText = 'color:#8888cc;font-size:13px;font-weight:600;margin-left:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

  titleBar.appendChild(dots);
  titleBar.appendChild(title);

  // Content area: iframe or terminal div
  let iframe: HTMLIFrameElement;
  let contentDiv: HTMLDivElement | null = null;
  let contentElement: HTMLElement;

  if (mode === 'terminal') {
    contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'flex:1;overflow:hidden;display:flex;background:#1a1a2e';
    contentElement = contentDiv;
    // Create a dummy iframe for the interface
    iframe = document.createElement('iframe');
    iframe.style.display = 'none';
  } else {
    iframe = document.createElement('iframe');
    iframe.style.cssText = 'border:none;width:100%;flex:1;background:#0a0a1a;visibility:visible;opacity:1;display:block';
    if (port != null) iframe.setAttribute('data-virtual-port', String(port));
    iframe.setAttribute('data-virtual-path', path);
    contentElement = iframe;
  }

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.style.cssText = 'position:absolute;bottom:0;right:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#555 50%)';

  wrapper.appendChild(titleBar);
  wrapper.appendChild(contentElement);
  wrapper.appendChild(resizeHandle);

  // Click-to-focus: bring window to front
  wrapper.onmousedown = () => { wrapper.style.zIndex = String(Date.now() % 2147483647); };

  // Dragging
  let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
  titleBar.onmousedown = (e) => {
    if (maximized) return; // Don't drag when maximized
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left;
    dy = r.top;
    titleBar.style.cursor = 'grabbing';
    e.preventDefault();
  };

  // Touch dragging for mobile
  titleBar.ontouchstart = (e) => {
    if (maximized) return;
    dragging = true;
    const touch = e.touches[0];
    sx = touch.clientX;
    sy = touch.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left;
    dy = r.top;
    e.preventDefault();
  };

  // Resizing
  let resizing = false;
  resizeHandle.onmousedown = (e) => {
    resizing = true;
    e.preventDefault();
    e.stopPropagation();
  };

  resizeHandle.ontouchstart = (e) => {
    resizing = true;
    e.preventDefault();
    e.stopPropagation();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragging) {
      wrapper.style.left = (dx + e.clientX - sx) + 'px';
      wrapper.style.top = (dy + e.clientY - sy) + 'px';
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';
    }
    if (resizing) {
      const rr = wrapper.getBoundingClientRect();
      const nw = Math.max(300, e.clientX - rr.left);
      const nh = Math.max(200, e.clientY - rr.top);
      wrapper.style.width = nw + 'px';
      wrapper.style.height = nh + 'px';
      savedH = nh;
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (dragging) {
      wrapper.style.left = (dx + touch.clientX - sx) + 'px';
      wrapper.style.top = (dy + touch.clientY - sy) + 'px';
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';
    }
    if (resizing) {
      const rr = wrapper.getBoundingClientRect();
      const nw = Math.max(300, touch.clientX - rr.left);
      const nh = Math.max(200, touch.clientY - rr.top);
      wrapper.style.width = nw + 'px';
      wrapper.style.height = nh + 'px';
      savedH = nh;
    }
  };

  const onEnd = () => {
    dragging = false;
    resizing = false;
    titleBar.style.cursor = 'grab';
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onEnd);

  // Store cleanup handlers
  (wrapper as any)._cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onEnd);
  };

  container.appendChild(wrapper);

  return {
    element: wrapper,
    iframe,
    contentDiv,
    close: () => {
      onClose?.();
      (wrapper as any)._cleanup?.();
      wrapper.remove();
    },
    minimize: () => miniBtn.click(),
    maximize: () => maxBtn.click(),
    setTitle: (newTitle: string) => {
      title.textContent = newTitle;
    },
    updateIframe: (html: string) => {
      iframe.srcdoc = html;
    },
  };
}

/**
 * Find an existing server window by port
 */
export function findServerWindow(port: number): ServerWindow | null {
  const el = document.querySelector(`[data-server-window="${port}"]`) as HTMLDivElement | null;
  if (!el) return null;

  const iframe = el.querySelector('iframe') as HTMLIFrameElement;
  return {
    element: el,
    iframe,
    contentDiv: null,
    close: () => {
      (el as any)._cleanup?.();
      el.remove();
    },
    minimize: () => {},
    maximize: () => {},
    setTitle: () => {},
    updateIframe: (html: string) => {
      iframe.srcdoc = html;
    },
  };
}

/**
 * Close all server windows
 */
export function closeAllServerWindows(): void {
  document.querySelectorAll('[data-server-window]').forEach(el => {
    (el as any)._cleanup?.();
    el.remove();
  });
}
