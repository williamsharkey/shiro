// ~/.gitconfig parsing, apart from git.ts so callers (gh auth) don't load isomorphic-git

export const GLOBAL_GITCONFIG = '/home/user/.gitconfig';

/** Parse a git-style INI file into { "section.key": value } ("section.sub.key" for [section "sub"]). */
export function parseGitConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[([^\s\]"]+)(?:\s+"([^"]*)")?\]$/);
    if (sec) { section = sec[2] !== undefined ? `${sec[1]}.${sec[2]}` : sec[1]; continue; }
    const kv = line.match(/^([\w-]+)\s*(?:=\s*(.*))?$/);
    if (kv && section) out[`${section}.${kv[1]}`.toLowerCase()] = (kv[2] ?? 'true').replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function formatGitConfig(values: Record<string, string>): string {
  const sections: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    const i = key.lastIndexOf('.');
    const sec = key.slice(0, i), name = key.slice(i + 1);
    const j = sec.indexOf('.');
    const header = j < 0 ? `[${sec}]` : `[${sec.slice(0, j)} "${sec.slice(j + 1)}"]`;
    (sections[header] ??= []).push(`\t${name} = ${value}`);
  }
  return Object.entries(sections).map(([h, lines]) => [h, ...lines].join('\n')).join('\n') + '\n';
}
