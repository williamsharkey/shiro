/**
 * Which desktop app an X client's windows belong to, when its WM_CLASS
 * instance isn't the app's id (Inkscape's is "org.inkscape.inkscape",
 * NetSurf's "netsurf-gtk"). src/gui/apps.ts fills these on launch; rootless
 * windows look up their _NET_WM_PID (GTK, Qt) and its parents (an app that a
 * launcher program starts: LibreOffice's oosplash runs soffice.bin), then the
 * WM_CLASS alias.
 */
export const pidAppIds = new Map<number, string>();
export const appIdAliases = new Map<string, string>();

/** A process's parent (set by src/gui/apps.ts from the kernel's process table) */
export let parentPid: (pid: number) => number | undefined = () => undefined;
export function setParentPid(f: (pid: number) => number | undefined): void { parentPid = f; }

/** The app a process belongs to: its own entry, else its nearest launched ancestor's */
export function appIdOfPid(pid: number): string | undefined {
  for (let p: number | undefined = pid, n = 0; p && p > 1 && n < 16; p = parentPid(p), n++) {
    const id = pidAppIds.get(p);
    if (id) return id;
  }
  return undefined;
}
