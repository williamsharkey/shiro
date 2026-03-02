/**
 * File association registry — maps file extensions to commands.
 * Used by `open` to pick the right editor/viewer for a file.
 */

const associations: Map<string, string> = new Map();

const defaults: Record<string, string> = {
  // Text/code files → code editor (lighter, faster)
  ts: 'code', js: 'code', tsx: 'code', jsx: 'code',
  mjs: 'code', cjs: 'code',
  py: 'code', rs: 'code', go: 'code', c: 'code', h: 'code',
  cpp: 'code', cc: 'code', hpp: 'code',
  css: 'code', scss: 'code', less: 'code',
  html: 'code', htm: 'code',
  json: 'code', md: 'mdview',
  yaml: 'code', yml: 'code', toml: 'code',
  sh: 'code', bash: 'code', zsh: 'code',
  txt: 'code', xml: 'code', sql: 'code',
  java: 'code', rb: 'code', php: 'code',
  // Images
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', svg: 'img', webp: 'img',
};

export function initFileAssociations(): void {
  for (const [ext, cmd] of Object.entries(defaults)) {
    if (!associations.has(ext)) associations.set(ext, cmd);
  }
}

export function getAssociation(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return associations.get(ext) || null;
}

export function setAssociation(ext: string, command: string): void {
  associations.set(ext.toLowerCase(), command);
}

export function listAssociations(): Map<string, string> {
  return new Map(associations);
}
