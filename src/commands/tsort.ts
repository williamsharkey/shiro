import type { Command } from './index';
import { readOperands } from './flags';

interface Item {
  str: string;
  printed: boolean;
  count: number;
  /** Successors, most recently added first (as GNU's linked list) */
  top: Item[];
  qlink: Item | null;
}

/**
 * tsort, as GNU coreutils (Knuth's algorithm T): nodes with no remaining
 * predecessors are taken in byte order of their names, a successor joins
 * the queue as soon as its last predecessor is printed, `a a` declares a
 * node, and a loop is reported on stderr and broken (exit 1).
 */
export const tsort: Command = {
  name: "tsort",
  description: "Perform topological sort",
  async exec(ctx) {
    const files: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { files.push(...ctx.args.slice(i + 1)); break; }
      if (a.length > 1 && a[0] === '-') {
        ctx.stderr += a.startsWith('--') ? `tsort: unrecognized option '${a}'\n` : `tsort: invalid option -- '${a[1]}'\n`;
        ctx.stderr += "Try 'tsort --help' for more information.\n";
        return 1;
      }
      files.push(a);
    }
    if (files.length > 1) {
      ctx.stderr += `tsort: extra operand '${files[1]}'\nTry 'tsort --help' for more information.\n`;
      return 1;
    }
    const file = files[0] ?? '-';
    const { content, status } = await readOperands(ctx, 'tsort', [file]);
    if (status) return 1;

    const tokens = content.split(/[ \t\n\v\f\r]+/).filter(Boolean);
    if (tokens.length % 2 !== 0) {
      ctx.stderr += `tsort: ${file}: input contains an odd number of tokens\n`;
      return 1;
    }
    const items = new Map<string, Item>();
    const get = (s: string): Item => {
      let it = items.get(s);
      if (!it) {
        it = { str: s, printed: false, count: 0, top: [], qlink: null };
        items.set(s, it);
      }
      return it;
    };
    for (let i = 0; i < tokens.length; i += 2) {
      const j = get(tokens[i]);
      const k = get(tokens[i + 1]);
      if (j !== k) {
        k.count++;
        j.top.unshift(k);
      }
    }
    // GNU walks a search tree in order: byte order of the names
    const sorted = [...items.values()].sort((a, b) => (a.str < b.str ? -1 : a.str > b.str ? 1 : 0));
    let remaining = sorted.length;
    let out = '';
    let ok = true;
    let head: Item | null = null;
    let zeros: Item | null = null;
    while (remaining > 0) {
      for (const k of sorted) {
        if (k.count === 0 && !k.printed) {
          if (head === null) head = k;
          else zeros!.qlink = k;
          zeros = k;
        }
      }
      while (head) {
        out += head.str + '\n';
        head.printed = true;
        remaining--;
        for (const s of head.top) {
          s.count--;
          if (s.count === 0) {
            zeros!.qlink = s;
            zeros = s;
          }
        }
        const next: Item | null = head.qlink;
        head.qlink = null;
        head = next;
      }
      if (remaining > 0) {
        // The input contains a loop: print it and break one relation
        ctx.stdout += out;
        out = '';
        ctx.stderr += `tsort: ${file}: input contains a loop:\n`;
        ok = false;
        let loop: Item | null = null;
        const detect = (k: Item): boolean => {
          if (k.count <= 0 || k.printed) return false;
          if (loop === null) { loop = k; return false; }
          for (let p = 0; p < k.top.length; p++) {
            if (k.top[p] !== loop) continue;
            if (k.qlink) {
              // Found a loop: retrace the path we took to get here
              while (loop) {
                const tmp: Item | null = loop.qlink;
                ctx.stderr += `tsort: ${loop.str}\n`;
                if (loop === k) {
                  k.top[p].count--;
                  k.top.splice(p, 1);
                  break;
                }
                loop.qlink = null;
                loop = tmp;
              }
              while (loop) {
                const tmp: Item | null = loop.qlink;
                loop.qlink = null;
                loop = tmp;
              }
              return true;
            }
            k.qlink = loop;
            loop = k;
            break;
          }
          return false;
        };
        let guard = 0;
        do {
          for (const k of sorted) if (detect(k)) break;
        } while (loop && ++guard < 1_000_000);
        head = null;
        zeros = null;
      }
    }
    ctx.stdout += out;
    return ok ? 0 : 1;
  },
};
