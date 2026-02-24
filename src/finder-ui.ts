/**
 * Finder UI rendering helpers — scoped CSS, file grid, breadcrumb, context menu.
 * Kept separate from finder.ts to stay under 300 lines each.
 */

import type { DirEntry } from './commands/flags';

/** Inject scoped CSS for the finder into a root element */
export function injectFinderStyles(root: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = `
    .finder-root {
      display: flex; flex-direction: column; height: 100%; background: #12121e;
      color: rgba(255,255,255,0.85); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; user-select: none; -webkit-user-select: none;
    }
    .finder-toolbar {
      display: flex; align-items: center; gap: 6px; padding: 6px 10px;
      background: #1a1a2e; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;
    }
    .finder-toolbar button {
      height: 26px; padding: 0 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); font-size: 12px;
      cursor: pointer; font-family: inherit; white-space: nowrap;
    }
    .finder-toolbar button:hover { background: rgba(255,255,255,0.1); }
    .finder-breadcrumb {
      display: flex; align-items: center; gap: 2px; flex: 1; overflow: hidden;
    }
    .finder-crumb {
      color: rgba(255,255,255,0.5); cursor: pointer; padding: 2px 4px; border-radius: 3px;
      white-space: nowrap; font-size: 12px;
    }
    .finder-crumb:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); }
    .finder-crumb-sep { color: rgba(255,255,255,0.2); font-size: 11px; }
    .finder-grid {
      flex: 1; overflow-y: auto; padding: 8px; display: grid;
      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 4px;
      align-content: start;
    }
    .finder-item {
      display: flex; flex-direction: column; align-items: center; padding: 8px 4px;
      border-radius: 6px; cursor: default; min-width: 0;
    }
    .finder-item:hover { background: rgba(255,255,255,0.04); }
    .finder-item.selected { background: rgba(50,100,255,0.2); }
    .finder-item-icon { font-size: 28px; line-height: 1.2; }
    .finder-item-name {
      font-size: 11px; color: rgba(255,255,255,0.75); text-align: center;
      word-break: break-all; max-width: 100%; margin-top: 4px; line-height: 1.3;
    }
    .finder-item-name[contenteditable] {
      background: rgba(255,255,255,0.1); border-radius: 3px; padding: 1px 4px;
      outline: none; color: #fff;
    }
    .finder-ctx {
      position: fixed; z-index: 2147483647; background: #1e1e32;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
      padding: 4px 0; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .finder-ctx-item {
      padding: 6px 14px; cursor: pointer; font-size: 13px; color: rgba(255,255,255,0.8);
    }
    .finder-ctx-item:hover { background: rgba(50,100,255,0.3); }
    .finder-ctx-sep {
      height: 1px; background: rgba(255,255,255,0.06); margin: 4px 0;
    }
    .finder-empty {
      color: rgba(255,255,255,0.25); font-size: 13px; padding: 20px;
      text-align: center; grid-column: 1 / -1;
    }
  `;
  root.appendChild(style);
}

/** File type icon lookup */
export function getFileIcon(name: string, type: 'file' | 'dir' | 'symlink'): string {
  if (type === 'dir') return '📁';
  if (type === 'symlink') return '🔗';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: '🟨', ts: '🔷', jsx: '⚛️', tsx: '⚛️',
    py: '🐍', html: '🌐', css: '🎨', json: '📋',
    md: '📝', txt: '📄', sh: '⚙️', yaml: '📋', yml: '📋',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp3: '🎵', wav: '🎵', mp4: '🎬', webm: '🎬',
    zip: '📦', gz: '📦', tar: '📦',
    wasm: '⚙️', toml: '📋', lock: '🔒',
  };
  return map[ext] || '📄';
}

/** Render breadcrumb path bar */
export function renderBreadcrumb(
  container: HTMLElement,
  path: string,
  onNavigate: (path: string) => void,
): void {
  container.innerHTML = '';
  const parts = path === '/' ? [''] : path.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'finder-crumb-sep';
      sep.textContent = '/';
      container.appendChild(sep);
    }
    const crumb = document.createElement('span');
    crumb.className = 'finder-crumb';
    crumb.textContent = i === 0 ? '/' : parts[i];
    const target = i === 0 ? '/' : parts.slice(0, i + 1).join('/');
    crumb.onclick = () => onNavigate(target);
    container.appendChild(crumb);
  }
}

export interface GridCallbacks {
  onSelect: (name: string, e: MouseEvent) => void;
  onOpen: (entry: DirEntry) => void;
  onContextMenu: (entry: DirEntry | null, e: MouseEvent) => void;
  onDrop: (files: FileList) => void;
  onMoveToDir: (srcName: string, destDir: string) => void;
}

/** Render the file grid into a container */
export function renderFileGrid(
  container: HTMLElement,
  entries: DirEntry[],
  currentPath: string,
  cb: GridCallbacks,
): void {
  container.innerHTML = '';
  container.ondragover = (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; };
  container.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) cb.onDrop(e.dataTransfer.files);
  };
  container.oncontextmenu = (e) => {
    if (e.target === container) { e.preventDefault(); cb.onContextMenu(null, e); }
  };

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'finder-empty';
    empty.textContent = 'Empty folder';
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'finder-item';
    item.draggable = true;
    item.setAttribute('data-name', entry.name);

    const icon = document.createElement('div');
    icon.className = 'finder-item-icon';
    icon.textContent = getFileIcon(entry.name, entry.type);

    const name = document.createElement('div');
    name.className = 'finder-item-name';
    name.textContent = entry.name;

    item.appendChild(icon);
    item.appendChild(name);
    container.appendChild(item);

    item.onclick = (e) => { e.stopPropagation(); cb.onSelect(entry.name, e); };
    item.ondblclick = () => cb.onOpen(entry);
    item.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); cb.onContextMenu(entry, e); };

    // Drag-to-move: drag a file onto a folder
    if (entry.type === 'dir') {
      item.ondragover = (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.style.outline = '2px solid rgba(50,100,255,0.5)';
        e.dataTransfer!.dropEffect = 'move';
      };
      item.ondragleave = () => { item.style.outline = ''; };
      item.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.style.outline = '';
        const srcName = e.dataTransfer?.getData('text/x-finder-name');
        if (srcName && srcName !== entry.name) {
          cb.onMoveToDir(srcName, entry.name);
        }
      };
    }

    item.ondragstart = (e) => {
      e.dataTransfer?.setData('text/x-finder-name', entry.name);
    };
  }

  // Click on empty space to deselect
  container.onclick = (e) => {
    if (e.target === container) cb.onSelect('', e);
  };
}

/** Show a positioned context menu, returns cleanup function */
export function showContextMenu(
  x: number, y: number,
  items: Array<{ label: string; action: () => void } | 'separator'>,
  root: HTMLElement,
): () => void {
  // Remove any existing context menu
  root.querySelectorAll('.finder-ctx').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'finder-ctx';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'finder-ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'finder-ctx-item';
    row.textContent = item.label;
    row.onclick = (e) => { e.stopPropagation(); cleanup(); item.action(); };
    menu.appendChild(row);
  }

  root.appendChild(menu);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });

  const cleanup = () => menu.remove();
  const onClickAway = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) { cleanup(); document.removeEventListener('click', onClickAway, true); }
  };
  setTimeout(() => document.addEventListener('click', onClickAway, true), 0);
  return cleanup;
}

/** Format file size for display */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
