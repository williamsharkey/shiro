/**
 * umask [-p] [-S] [MODE] as bash does it (builtins/umask.def): MODE is octal
 * (at most 0777) or symbolic, clauses [ugoa]*[+-=][rwx]* separated by
 * commas (no who means all; one operator per clause; no X, s, t or
 * permission copying, which bash rejects too).
 */

/** The mask printed as `umask` does: 0022 */
export function formatUmask(mask: number): string {
  return mask.toString(8).padStart(4, '0');
}

/** The mask as `umask -S` prints it: the permissions it allows, u=rwx,g=rx,o=rx */
export function symbolicUmask(mask: number): string {
  const allowed = ~mask & 0o777;
  const part = (shift: number) => (allowed >> shift & 4 ? 'r' : '') + (allowed >> shift & 2 ? 'w' : '') + (allowed >> shift & 1 ? 'x' : '');
  return `u=${part(6)},g=${part(3)},o=${part(0)}`;
}

/** The new mask for MODE, or an error message */
export function parseUmask(mode: string, mask: number): number | string {
  if (/^\d/.test(mode)) {
    if (!/^[0-7]+$/.test(mode)) return `${mode}: octal number out of range`;
    const n = parseInt(mode, 8);
    return n > 0o777 ? `${mode}: octal number out of range` : n;
  }
  let bits = ~mask & 0o777; // what is allowed
  let s = 0;
  for (;;) {
    let who = 0;
    while (s < mode.length && 'ugoa'.includes(mode[s])) {
      const c = mode[s++];
      who |= c === 'u' ? 0o700 : c === 'g' ? 0o070 : c === 'o' ? 0o007 : 0o777;
    }
    if (!who) who = 0o777;
    const op = mode[s++];
    if (op !== '+' && op !== '-' && op !== '=') {
      return op === undefined ? `${mode}: invalid symbolic mode operator` : `\`${op}': invalid symbolic mode operator`;
    }
    let perm = 0;
    while (s < mode.length && 'rwx'.includes(mode[s])) {
      const c = mode[s++];
      perm |= c === 'r' ? 0o444 : c === 'w' ? 0o222 : 0o111;
    }
    perm &= who;
    if (op === '+') bits |= perm;
    else if (op === '-') bits &= ~perm;
    else bits = (bits & ~who) | perm;
    if (s >= mode.length) break;
    if (mode[s] !== ',') return `\`${mode[s]}': invalid symbolic mode character`;
    s++;
  }
  return ~bits & 0o777;
}
