/**
 * Tiling panes for the main terminal area.
 *
 * Every pane has four tiny corner triangles. Dragging one splits the pane: move
 * mostly sideways for a side-by-side (vertical) split, mostly up/down for a
 * stacked (horizontal) split. The new pane opens on the side of the corner you
 * grabbed and follows the pointer until release, then gets its own shell.
 * Dividers drag to resize (double-click to even out). `exit` or Ctrl-D at an
 * extra pane's prompt closes it. The layout (not the content) is saved in
 * localStorage and rebuilt on reload with fresh shells.
 *
 * The first pane is always #terminal, the main terminal (window.__shiro.terminal).
 */

import { ShiroTerminal } from './terminal';
import type { Shell } from './shell';
import { setActiveTerminal } from './active-terminal';

type Dir = 'row' | 'column'; // row = side by side (vertical divider), column = stacked

interface Leaf {
  kind: 'leaf';
  el: HTMLElement;
  term: ShiroTerminal | null;
  main: boolean;
  parent: Split | null;
}

interface Split {
  kind: 'split';
  el: HTMLElement;
  divider: HTMLElement;
  dir: Dir;
  a: PaneNode;
  b: PaneNode;
  ratio: number; // share of `a`
  parent: Split | null;
}

type PaneNode = Leaf | Split;

type Saved = { s: 'main' | 'shell' } | { d: Dir; r: number; a: Saved; b: Saved };

const STORAGE_KEY = 'shiro-panes';
const MIN_PANE_PX = 40;      // smallest a pane can be dragged to
const KEEP_PANE_PX = 80;     // a new pane released smaller than this is discarded
const DRAG_THRESHOLD_PX = 6; // movement before a corner drag picks a direction

let host: HTMLElement;
let root: PaneNode;
let mainLeaf: Leaf;
let makeShell: () => Shell;

const CSS = `
#shiro-panes { flex: 1; min-width: 0; min-height: 0; display: flex;
  height: calc(100% - clamp(0px, calc(100vh - 20em), 1em)); }
#shiro-panes #terminal { height: auto; }
.shiro-split { display: flex; min-width: 0; min-height: 0; }
.shiro-split.row { flex-direction: row; }
.shiro-split.column { flex-direction: column; }
.shiro-pane { position: relative; min-width: 0; min-height: 0; padding: 4px; overflow: hidden; }
.shiro-divider { flex: 0 0 5px; background: #3a3a5c; touch-action: none; }
.shiro-split.row > .shiro-divider { cursor: col-resize; border-left: 1px solid #6c6cff55; }
.shiro-split.column > .shiro-divider { cursor: row-resize; border-top: 1px solid #6c6cff55; }
.shiro-divider:hover, .shiro-divider.drag { background: #7a7aff; }
.shiro-corner { position: absolute; width: 8px; height: 8px; z-index: 7; background: #3a3a5c;
  cursor: crosshair; touch-action: none; }
.shiro-corner:hover { background: #7a7aff; }
.shiro-corner.tl { top: 0; left: 0; clip-path: polygon(0 0, 100% 0, 0 100%); }
.shiro-corner.tr { top: 0; right: 0; clip-path: polygon(0 0, 100% 0, 100% 100%); }
.shiro-corner.bl { bottom: 0; left: 0; clip-path: polygon(0 0, 0 100%, 100% 100%); }
.shiro-corner.br { bottom: 0; right: 0; clip-path: polygon(100% 0, 100% 100%, 0 100%); }
body.shiro-pane-drag, body.shiro-pane-drag * { user-select: none !important; }
body.shiro-pane-drag.row, body.shiro-pane-drag.row * { cursor: col-resize !important; }
body.shiro-pane-drag.column, body.shiro-pane-drag.column * { cursor: row-resize !important; }
.become-active #shiro-panes { display: none !important; }
`;

export function initPanes(mainTerminal: ShiroTerminal, shellFactory: () => Shell): void {
  const terminalEl = document.getElementById('terminal');
  if (!terminalEl?.parentElement || document.getElementById('shiro-panes')) return;
  makeShell = shellFactory;

  const style = document.createElement('style');
  style.id = 'shiro-panes-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  host = document.createElement('div');
  host.id = 'shiro-panes';
  terminalEl.parentElement.insertBefore(host, terminalEl);

  terminalEl.classList.add('shiro-pane');
  mainLeaf = { kind: 'leaf', el: terminalEl, term: mainTerminal, main: true, parent: null };
  addCorners(mainLeaf);

  root = restore() || mainLeaf;
  root.parent = null;
  root.el.style.flex = '1 1 0px';
  host.appendChild(root.el);
  for (const leaf of leaves(root)) if (!leaf.term) startShell(leaf, false);

  setActiveTerminal(mainTerminal);
  mainTerminal.term.focus();

  (window as any).__shiroPanes = { layout: () => serialize(root), reset: resetPanes };
}

/** Close every extra pane, leaving only the main terminal. */
export function resetPanes(): void {
  for (const leaf of leaves(root)) if (!leaf.main) closeLeaf(leaf);
}

// ── Tree operations ──────────────────────────────────────────────────

function newLeaf(parent: Split | null): Leaf {
  const el = document.createElement('div');
  el.className = 'shiro-pane';
  const leaf: Leaf = { kind: 'leaf', el, term: null, main: false, parent };
  addCorners(leaf);
  return leaf;
}

function newSplit(dir: Dir, ratio: number, parent: Split | null): Split {
  const el = document.createElement('div');
  el.className = `shiro-split ${dir}`;
  const divider = document.createElement('div');
  divider.className = 'shiro-divider';
  const split = { kind: 'split', el, divider, dir, ratio, parent } as unknown as Split; // a and b are set by the caller
  divider.addEventListener('pointerdown', (e) => dragDivider(split, e));
  divider.addEventListener('dblclick', () => { setRatio(split, 0.5); save(); });
  return split;
}

function setRatio(split: Split, ratio: number): void {
  split.ratio = ratio;
  split.a.el.style.flex = `${ratio} 1 0px`;
  split.b.el.style.flex = `${1 - ratio} 1 0px`;
}

/** Put `next` where `prev` was: same DOM slot, same parent link, same size. */
function replaceNode(prev: PaneNode, next: PaneNode): void {
  next.el.style.flex = prev.el.style.flex;
  prev.el.replaceWith(next.el);
  next.parent = prev.parent;
  if (!prev.parent) root = next;
  else if (prev.parent.a === prev) prev.parent.a = next;
  else prev.parent.b = next;
}

function splitLeaf(leaf: Leaf, dir: Dir, newFirst: boolean): { split: Split; created: Leaf } {
  const split = newSplit(dir, newFirst ? 0 : 1, leaf.parent);
  const created = newLeaf(split);
  const hadFocus = leaf.el.contains(document.activeElement);
  replaceNode(leaf, split);
  split.a = newFirst ? created : leaf;
  split.b = newFirst ? leaf : created;
  leaf.parent = split;
  split.el.append(split.a.el, split.divider, split.b.el);
  setRatio(split, split.ratio);
  if (hadFocus) leaf.term?.term.focus(); // moving the element drops focus
  return { split, created };
}

function closeLeaf(leaf: Leaf): void {
  const split = leaf.parent;
  if (!split || leaf.main) return;
  const sibling = split.a === leaf ? split.b : split.a;
  const hadFocus = leaf.el.contains(document.activeElement);
  replaceNode(split, sibling);
  leaf.term?.dispose();
  leaf.term = null;
  if (hadFocus) {
    const next = leaves(sibling)[0];
    if (next.term) { setActiveTerminal(next.term); next.term.term.focus(); }
  }
  save();
}

function leaves(node: PaneNode): Leaf[] {
  return node.kind === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

function startShell(leaf: Leaf, focus: boolean): void {
  const shell = makeShell();
  const t = new ShiroTerminal(leaf.el, shell);
  shell.setTerminal(t);
  t.onExit = () => closeLeaf(leaf);
  leaf.term = t;
  t.startPane();
  if (focus) t.term.focus();
}

// ── Dragging ─────────────────────────────────────────────────────────

/** Track a pointer on window, so moving elements around mid-drag can't drop it. */
function track(e: PointerEvent, move: (ev: PointerEvent) => void, done: (ev: PointerEvent) => void): void {
  const id = e.pointerId;
  const onMove = (ev: PointerEvent) => { if (ev.pointerId === id) move(ev); };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('shiro-pane-drag', 'row', 'column');
    done(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function ratioAt(split: Split, ev: PointerEvent): number {
  const r = split.el.getBoundingClientRect();
  const size = split.dir === 'row' ? r.width : r.height;
  if (size <= 0) return split.ratio;
  const pos = split.dir === 'row' ? ev.clientX - r.left : ev.clientY - r.top;
  const min = Math.min(0.45, MIN_PANE_PX / size);
  return Math.min(1 - min, Math.max(min, pos / size));
}

function dragDivider(split: Split, e: PointerEvent): void {
  e.preventDefault();
  split.divider.classList.add('drag');
  document.body.classList.add('shiro-pane-drag', split.dir);
  track(e, (ev) => setRatio(split, ratioAt(split, ev)), () => {
    split.divider.classList.remove('drag');
    save();
  });
}

function addCorners(leaf: Leaf): void {
  for (const pos of ['tl', 'tr', 'bl', 'br'] as const) {
    const corner = document.createElement('div');
    corner.className = `shiro-corner ${pos}`;
    corner.title = 'Drag to split: sideways for side by side, up or down for stacked';
    corner.addEventListener('pointerdown', (e) => dragCorner(leaf, pos, e));
    leaf.el.appendChild(corner);
  }
}

function dragCorner(leaf: Leaf, pos: 'tl' | 'tr' | 'bl' | 'br', e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY;
  let made: { split: Split; created: Leaf } | null = null;
  track(e, (ev) => {
    if (!made) {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? 'row' : 'column';
      // The new pane opens on the grabbed corner's side and grows as you drag inward
      const newFirst = dir === 'row' ? pos[1] === 'l' : pos[0] === 't';
      made = splitLeaf(leaf, dir, newFirst);
      document.body.classList.add('shiro-pane-drag', dir);
    }
    setRatio(made.split, ratioAt(made.split, ev));
  }, () => {
    if (!made) return;
    const { split, created } = made;
    const r = created.el.getBoundingClientRect();
    if ((split.dir === 'row' ? r.width : r.height) < KEEP_PANE_PX) {
      replaceNode(split, leaf); // too small: undo
      leaf.term?.term.focus();
      return;
    }
    startShell(created, true);
    save();
  });
}

// ── Persistence ──────────────────────────────────────────────────────

function serialize(node: PaneNode): Saved {
  if (node.kind === 'leaf') return { s: node.main ? 'main' : 'shell' };
  return { d: node.dir, r: Math.round(node.ratio * 1000) / 1000, a: serialize(node.a), b: serialize(node.b) };
}

function save(): void {
  try {
    if (root.kind === 'leaf') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(root)));
  } catch { /* storage unavailable */ }
}

function valid(s: any, depth = 0): boolean {
  if (!s || typeof s !== 'object' || depth > 12) return false;
  if ('s' in s) return s.s === 'main' || s.s === 'shell';
  return (s.d === 'row' || s.d === 'column') && typeof s.r === 'number' && s.r > 0 && s.r < 1
    && valid(s.a, depth + 1) && valid(s.b, depth + 1);
}

function countMain(s: Saved): number {
  return 's' in s ? (s.s === 'main' ? 1 : 0) : countMain(s.a) + countMain(s.b);
}

function restore(): PaneNode | null {
  let saved: any;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  if (!saved || !valid(saved) || countMain(saved) !== 1 || 's' in saved) return null;
  const build = (s: Saved, parent: Split | null): PaneNode => {
    if ('s' in s) {
      if (s.s === 'main') { mainLeaf.parent = parent; return mainLeaf; }
      return newLeaf(parent);
    }
    const split = newSplit(s.d, s.r, parent);
    split.a = build(s.a, split);
    split.b = build(s.b, split);
    split.el.append(split.a.el, split.divider, split.b.el);
    setRatio(split, s.r);
    return split;
  };
  return build(saved, null);
}
