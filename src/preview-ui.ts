/**
 * Who shows previews of in-tab servers (docs/DESKTOP.md "Previews"). The
 * desktop registers its Preview windows here: `serve open` / `serve --split`
 * open one, and a server that starts listening (node's http, express, a
 * "listening on port N" line) offers one. Without a registered UI, the
 * classic layout's split pane and floating windows are used (split-view.ts,
 * server-window.ts). A module of its own so registering costs nothing at boot.
 */

export interface PreviewUI {
  /** Show `path` of the server on `port` (a window, focused; reused per port) */
  open(port: number, path?: string, title?: string): Promise<void> | void;
  /** A server started listening: offer to open it (not a pop-up) */
  listening(port: number, title?: string): void;
}

let ui: PreviewUI | null = null;

export function setPreviewUI(u: PreviewUI | null): void { ui = u; }
export function previewUI(): PreviewUI | null { return ui; }
