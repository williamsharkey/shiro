/**
 * Which desktop app an X client's windows belong to, when its WM_CLASS
 * instance isn't the app's id (Inkscape's is "org.inkscape.inkscape",
 * NetSurf's "netsurf-gtk"). src/gui/apps.ts fills these on launch; rootless
 * windows look up their _NET_WM_PID (GTK, Qt), then the WM_CLASS alias.
 */
export const pidAppIds = new Map<number, string>();
export const appIdAliases = new Map<string, string>();
