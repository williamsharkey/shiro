/**
 * Floating HUD panel — appears when the terminal HUD scrolls out of view.
 *
 * Compact state: small pill showing "白 shiro" docked top-left.
 * Expanded state: shows quick action links (files, claude, remote, help).
 * Draggable via the compact header.
 */

import type { Shell } from './shell';
import { showTemplatePalette } from './template-palette';
import { spawnInWindow } from './commands/spawn';

export interface HudPanel {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createHudPanel(shell: Shell): HudPanel {
  const wrapper = document.createElement('div');
  wrapper.id = 'shiro-hud-panel';

  // Start hidden
  wrapper.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    opacity: 0;
    transform: translateY(-8px);
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
  `;

  // Compact pill (always visible when panel is shown)
  const pill = document.createElement('div');
  pill.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(15, 15, 26, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  `;

  const logo = document.createElement('span');
  logo.textContent = '白';
  logo.style.cssText = 'font-size: 14px; color: #fff; line-height: 1;';

  const label = document.createElement('span');
  label.textContent = 'shiro';
  label.style.cssText = 'font-size: 13px; color: rgba(255,255,255,0.7); font-weight: 500;';

  const expandBtn = document.createElement('span');
  expandBtn.textContent = '›';
  expandBtn.style.cssText = `
    font-size: 16px;
    color: rgba(255,255,255,0.3);
    margin-left: 2px;
    transition: transform 0.2s ease, color 0.15s;
    line-height: 1;
  `;

  pill.appendChild(logo);
  pill.appendChild(label);
  pill.appendChild(expandBtn);

  // Expanded menu
  const menu = document.createElement('div');
  menu.style.cssText = `
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.2s ease, opacity 0.15s ease, margin 0.2s ease;
    margin-top: 0;
    background: rgba(15, 15, 26, 0.9);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  `;

  // Menu items
  const items = [
    { label: 'Files', desc: 'File manager', icon: '↕', action: 'files' },
    { label: 'Claude', desc: 'AI assistant', icon: '◆', action: 'claude' },
    { label: 'Templates', desc: 'Starter projects', icon: '◇', action: 'templates' },
    { label: 'Remote', desc: 'MCP connection', icon: '○', action: 'remote' },
    { label: 'About', desc: 'shiro.computer', icon: '白', action: 'about' },
    { label: 'Help', desc: 'Commands & guide', icon: '?', action: 'help' },
  ];

  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
      ${i < items.length - 1 ? 'border-bottom: 1px solid rgba(255,255,255,0.04);' : ''}
    `;
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.06)'; };
    row.onmouseleave = () => { row.style.background = 'none'; };

    const iconEl = document.createElement('span');
    iconEl.textContent = item.icon;
    iconEl.style.cssText = 'font-size: 14px; color: #6cf; width: 18px; text-align: center; flex-shrink: 0;';

    const textCol = document.createElement('div');
    textCol.style.cssText = 'display: flex; flex-direction: column;';

    const nameEl = document.createElement('span');
    nameEl.textContent = item.label;
    nameEl.style.cssText = 'font-size: 13px; color: rgba(255,255,255,0.85); font-weight: 500;';

    const descEl = document.createElement('span');
    descEl.textContent = item.desc;
    descEl.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 1px;';

    textCol.appendChild(nameEl);
    textCol.appendChild(descEl);
    row.appendChild(iconEl);
    row.appendChild(textCol);
    menu.appendChild(row);

    const onTap = (handler: () => void) => {
      row.onclick = (e) => { e.stopPropagation(); handler(); };
      row.ontouchend = (e) => { e.preventDefault(); e.stopPropagation(); handler(); };
    };

    onTap(() => {
      collapse();
      handleAction(item.action, shell);
    });
  });

  wrapper.appendChild(pill);
  wrapper.appendChild(menu);
  document.body.appendChild(wrapper);

  // Update claude label async
  shell.fs.exists('/usr/local/bin/claude').then(installed => {
    const claudeRow = menu.children[1] as HTMLElement;
    if (!claudeRow) return;
    const nameEl = claudeRow.querySelector('span') as HTMLElement;
    const descEl = claudeRow.querySelectorAll('span')[2] as HTMLElement;
    if (installed) {
      if (nameEl) nameEl.textContent = 'Claude';
      if (descEl) descEl.textContent = 'Open assistant';
    }
  });

  // Expand / collapse
  let expanded = false;

  const expand = () => {
    expanded = true;
    menu.style.maxHeight = '320px';
    menu.style.opacity = '1';
    menu.style.marginTop = '6px';
    expandBtn.style.transform = 'rotate(90deg)';
    expandBtn.style.color = 'rgba(255,255,255,0.6)';
  };

  const collapse = () => {
    expanded = false;
    menu.style.maxHeight = '0';
    menu.style.opacity = '0';
    menu.style.marginTop = '0';
    expandBtn.style.transform = 'rotate(0deg)';
    expandBtn.style.color = 'rgba(255,255,255,0.3)';
  };

  // Toggle on pill click (but not during drag)
  let didDrag = false;
  pill.addEventListener('click', (e) => {
    if (didDrag) { didDrag = false; return; }
    e.stopPropagation();
    if (expanded) collapse(); else expand();
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (expanded && !wrapper.contains(e.target as Node)) {
      collapse();
    }
  });

  // --- Dragging ---
  let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
  pill.onmousedown = (e) => {
    dragging = true;
    didDrag = false;
    sx = e.clientX; sy = e.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left; dy = r.top;
    pill.style.cursor = 'grabbing';
    e.preventDefault();
  };
  pill.ontouchstart = (e) => {
    dragging = true;
    didDrag = false;
    const touch = e.touches[0];
    sx = touch.clientX; sy = touch.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left; dy = r.top;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    const moveX = e.clientX - sx;
    const moveY = e.clientY - sy;
    if (Math.abs(moveX) > 3 || Math.abs(moveY) > 3) didDrag = true;
    wrapper.style.left = (dx + moveX) + 'px';
    wrapper.style.top = (dy + moveY) + 'px';
    wrapper.style.right = 'auto';
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!dragging) return;
    const touch = e.touches[0];
    const moveX = touch.clientX - sx;
    const moveY = touch.clientY - sy;
    if (Math.abs(moveX) > 3 || Math.abs(moveY) > 3) didDrag = true;
    wrapper.style.left = (dx + moveX) + 'px';
    wrapper.style.top = (dy + moveY) + 'px';
    wrapper.style.right = 'auto';
  };
  const onEnd = () => {
    dragging = false;
    pill.style.cursor = 'grab';
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onEnd);

  // --- Show / hide ---
  let visible = false;

  const show = () => {
    if (visible) return;
    visible = true;
    wrapper.style.opacity = '1';
    wrapper.style.transform = 'translateY(0)';
    wrapper.style.pointerEvents = 'auto';
  };

  const hide = () => {
    if (!visible) return;
    visible = false;
    collapse();
    wrapper.style.opacity = '0';
    wrapper.style.transform = 'translateY(-8px)';
    wrapper.style.pointerEvents = 'none';
  };

  const destroy = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onEnd);
    wrapper.remove();
  };

  return { show, hide, destroy };
}

/**
 * Run a shell command through the global terminal, matching
 * the pattern used by shiro:// link handlers in terminal.ts.
 */
function runInTerminal(shell: Shell, cmd: string) {
  const term = (window as any).__shiro?.terminal as any;
  if (!term?.term) return;
  term.term.writeln('');
  shell.execute(
    cmd,
    (s: string) => term.term.write(s),
    (s: string) => term.term.write(`\x1b[31m${s}\x1b[0m`)
  ).then(() => {
    // showPrompt is private, but accessible via any cast
    term.showPrompt?.();
  });
}

/** Handle menu item clicks — dispatch to appropriate shell actions */
function handleAction(action: string, shell: Shell) {
  switch (action) {
    case 'files': {
      runInTerminal(shell, 'finder');
      break;
    }
    case 'claude': {
      shell.fs.exists('/usr/local/bin/claude').then(installed => {
        runInTerminal(shell, installed ? 'sc' : 'curl -fsSL https://claude.ai/install.sh | bash');
      });
      break;
    }
    case 'remote': {
      import('./commands/remote').then(m => m.openRemotePanel());
      break;
    }
    case 'templates': {
      showTemplatePalette(
        (name, cmd, splitPort) => spawnInWindow(shell, cmd, name, splitPort),
        (templateId) => {
          import('./living-templates').then(({ livingTemplates }) => {
            import('./template-runner').then(({ runLivingTemplate }) => {
              const tmpl = livingTemplates.find(t => t.id === templateId);
              if (tmpl) runLivingTemplate(shell, tmpl);
            });
          });
        },
      );
      break;
    }
    case 'about': {
      window.open('/about', '_blank');
      break;
    }
    case 'help': {
      runInTerminal(shell, 'help');
      break;
    }
  }
}
