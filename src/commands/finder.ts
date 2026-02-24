/**
 * Finder — visual file manager in a draggable/resizable window.
 * Uses createServerWindow (terminal mode) for the window chrome.
 */

import { Command } from './index';
import { readdirEntries, DirEntry } from './flags';
import { createServerWindow } from '../server-window';
import {
  injectFinderStyles, renderBreadcrumb, renderFileGrid,
  showContextMenu, getFileIcon, formatSize,
} from '../finder-ui';

export const finderCmd: Command = {
  name: 'finder',
  description: 'Visual file manager',
  async exec(ctx) {
    const fs = ctx.fs;
    let currentPath = ctx.args[0] ? fs.resolvePath(ctx.args[0], ctx.cwd) : ctx.cwd;
    const selected = new Set<string>();

    // Create window
    const win = createServerWindow({
      mode: 'terminal',
      title: 'Finder',
      width: '36em',
      height: '26em',
      onClose: () => {},
    });

    const root = win.contentDiv!;
    root.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden';
    const finderRoot = document.createElement('div');
    finderRoot.className = 'finder-root';
    finderRoot.style.cssText = 'display:flex;flex-direction:column;height:100%';
    root.appendChild(finderRoot);
    injectFinderStyles(finderRoot);

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'finder-toolbar';
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'finder-breadcrumb';

    const newFolderBtn = document.createElement('button');
    newFolderBtn.textContent = '+ Folder';
    newFolderBtn.onclick = () => createNewFolder();

    const uploadBtn = document.createElement('button');
    uploadBtn.textContent = 'Upload';
    uploadBtn.onclick = () => triggerUpload();

    toolbar.appendChild(breadcrumb);
    toolbar.appendChild(newFolderBtn);
    toolbar.appendChild(uploadBtn);
    finderRoot.appendChild(toolbar);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'finder-grid';
    finderRoot.appendChild(grid);

    // State
    let entries: DirEntry[] = [];

    async function navigateTo(path: string) {
      try {
        const raw = await readdirEntries(fs, path);
        // Sort: dirs first, then alphabetical
        entries = raw.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name);
        });
        currentPath = path;
        selected.clear();
        render();
        win.setTitle('Finder — ' + currentPath);
      } catch (e: any) {
        ctx.stderr += `finder: ${e.message}\n`;
      }
    }

    function render() {
      renderBreadcrumb(breadcrumb, currentPath, navigateTo);
      renderFileGrid(grid, entries, currentPath, {
        onSelect: (name, e) => {
          if (!name) { selected.clear(); }
          else if (e.metaKey || e.ctrlKey) {
            if (selected.has(name)) selected.delete(name);
            else selected.add(name);
          } else if (e.shiftKey && selected.size > 0) {
            // Range select
            const names = entries.map(en => en.name);
            const last = [...selected].pop()!;
            const from = names.indexOf(last);
            const to = names.indexOf(name);
            const [lo, hi] = from < to ? [from, to] : [to, from];
            for (let i = lo; i <= hi; i++) selected.add(names[i]);
          } else {
            selected.clear();
            selected.add(name);
          }
          updateSelection();
        },
        onOpen: (entry) => {
          if (entry.type === 'dir') {
            const next = currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name;
            navigateTo(next);
          } else {
            // Open file in vi editor
            const filePath = currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name;
            const shell = (window as any).__shiro?.shell;
            const term = (window as any).__shiro?.terminal;
            if (shell && term) {
              term.term.writeln('');
              shell.execute(
                `vi "${filePath}"`,
                (s: string) => term.term.write(s),
                (s: string) => term.term.write(`\x1b[31m${s}\x1b[0m`),
              ).then(() => term.showPrompt?.());
            }
          }
        },
        onContextMenu: (entry, e) => {
          if (entry) {
            if (!selected.has(entry.name)) {
              selected.clear();
              selected.add(entry.name);
              updateSelection();
            }
            showFileContextMenu(e.clientX, e.clientY, entry);
          } else {
            showBackgroundContextMenu(e.clientX, e.clientY);
          }
        },
        onDrop: (files) => uploadFiles(files),
        onMoveToDir: async (srcName, destDirName) => {
          const src = joinPath(currentPath, srcName);
          const dest = joinPath(joinPath(currentPath, destDirName), srcName);
          try {
            await fs.rename(src, dest);
            await navigateTo(currentPath);
          } catch (e: any) {
            console.error('Move failed:', e);
          }
        },
      });
      updateSelection();
    }

    function updateSelection() {
      grid.querySelectorAll('.finder-item').forEach(el => {
        const name = el.getAttribute('data-name') || '';
        el.classList.toggle('selected', selected.has(name));
      });
    }

    function joinPath(base: string, name: string): string {
      return base === '/' ? '/' + name : base + '/' + name;
    }

    function showFileContextMenu(x: number, y: number, entry: DirEntry) {
      const items: Array<{ label: string; action: () => void } | 'separator'> = [];
      const filePath = joinPath(currentPath, entry.name);

      items.push({ label: 'Open', action: () => {
        if (entry.type === 'dir') navigateTo(filePath);
        else {
          const shell = (window as any).__shiro?.shell;
          const term = (window as any).__shiro?.terminal;
          if (shell && term) {
            term.term.writeln('');
            shell.execute(`vi "${filePath}"`, (s: string) => term.term.write(s), (s: string) => term.term.write(`\x1b[31m${s}\x1b[0m`)).then(() => term.showPrompt?.());
          }
        }
      }});

      items.push('separator');

      items.push({ label: 'Rename', action: () => startRename(entry.name) });

      if (entry.type === 'file') {
        items.push({ label: `Download (${formatSize(entry.size)})`, action: () => downloadFile(filePath, entry.name) });
      }

      items.push('separator');

      if (selected.size > 1) {
        items.push({ label: `Zip ${selected.size} items`, action: () => zipSelected() });
        items.push('separator');
      }

      items.push({ label: 'Delete', action: () => deleteSelected() });

      showContextMenu(x, y, items, finderRoot);
    }

    function showBackgroundContextMenu(x: number, y: number) {
      showContextMenu(x, y, [
        { label: 'New Folder', action: () => createNewFolder() },
        { label: 'Upload', action: () => triggerUpload() },
      ], finderRoot);
    }

    async function createNewFolder() {
      const name = prompt('Folder name:');
      if (!name) return;
      try {
        await fs.mkdir(joinPath(currentPath, name), { recursive: true });
        await navigateTo(currentPath);
      } catch (e: any) {
        alert('Failed: ' + e.message);
      }
    }

    function triggerUpload() {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => { if (input.files?.length) uploadFiles(input.files); };
      input.click();
    }

    async function uploadFiles(files: FileList) {
      for (const file of Array.from(files)) {
        const buf = new Uint8Array(await file.arrayBuffer());
        await fs.writeFile(joinPath(currentPath, file.name), buf);
      }
      await navigateTo(currentPath);
    }

    async function downloadFile(path: string, name: string) {
      try {
        const data = await fs.readFile(path);
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
        const blob = new Blob([new Uint8Array(bytes) as any]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e: any) {
        console.error('Download failed:', e);
      }
    }

    async function deleteSelected() {
      const names = [...selected];
      if (!names.length) return;
      const msg = names.length === 1 ? `Delete "${names[0]}"?` : `Delete ${names.length} items?`;
      if (!confirm(msg)) return;
      for (const name of names) {
        const path = joinPath(currentPath, name);
        try {
          const stat = await fs.lstat(path);
          if (stat.isDirectory()) {
            await deleteRecursive(path);
          } else {
            await fs.unlink(path);
          }
        } catch {}
      }
      await navigateTo(currentPath);
    }

    async function deleteRecursive(path: string) {
      const children = await fs.readdir(path);
      for (const child of children) {
        const childPath = joinPath(path, child);
        const stat = await fs.lstat(childPath);
        if (stat.isDirectory()) await deleteRecursive(childPath);
        else await fs.unlink(childPath);
      }
      await fs.rmdir(path);
    }

    function startRename(oldName: string) {
      const item = grid.querySelector(`[data-name="${CSS.escape(oldName)}"]`);
      if (!item) return;
      const nameEl = item.querySelector('.finder-item-name') as HTMLElement;
      if (!nameEl) return;
      nameEl.contentEditable = 'true';
      nameEl.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      const finish = async () => {
        nameEl.contentEditable = 'false';
        const newName = nameEl.textContent?.trim();
        if (!newName || newName === oldName) {
          nameEl.textContent = oldName;
          return;
        }
        try {
          await fs.rename(joinPath(currentPath, oldName), joinPath(currentPath, newName));
          await navigateTo(currentPath);
        } catch (e: any) {
          nameEl.textContent = oldName;
          alert('Rename failed: ' + e.message);
        }
      };

      nameEl.onblur = finish;
      nameEl.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
        if (e.key === 'Escape') { nameEl.textContent = oldName; nameEl.blur(); }
      };
    }

    async function zipSelected() {
      const names = [...selected];
      if (names.length < 2) return;
      const zipName = prompt('Zip file name:', 'archive.zip');
      if (!zipName) return;
      const shell = (window as any).__shiro?.shell;
      const term = (window as any).__shiro?.terminal;
      if (!shell || !term) return;
      const paths = names.map(n => `"${joinPath(currentPath, n)}"`).join(' ');
      term.term.writeln('');
      shell.execute(
        `zip "${joinPath(currentPath, zipName)}" ${paths}`,
        (s: string) => term.term.write(s),
        (s: string) => term.term.write(`\x1b[31m${s}\x1b[0m`),
      ).then(() => { term.showPrompt?.(); navigateTo(currentPath); });
    }

    // Initial navigation
    await navigateTo(currentPath);
    return 0;
  },
};
