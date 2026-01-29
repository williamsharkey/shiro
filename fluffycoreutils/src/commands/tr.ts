import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const tr: FluffyCommand = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);
    const deleteMode = flags.d;
    const squeeze = flags.s;

    const set1 = expandSet(positional[0] ?? "");
    const set2 = expandSet(positional[1] ?? "");
    const input = io.stdin;

    let result: string;

    if (deleteMode) {
      const chars = new Set(set1.split(""));
      result = input.split("").filter((c) => !chars.has(c)).join("");
    } else if (set1 && set2) {
      const map = new Map<string, string>();
      for (let i = 0; i < set1.length; i++) {
        map.set(set1[i], set2[Math.min(i, set2.length - 1)]);
      }
      result = input.split("").map((c) => map.get(c) ?? c).join("");
    } else {
      result = input;
    }

    if (squeeze && set2) {
      const squeezeChars = new Set(set2.split(""));
      let squeezed = "";
      let lastChar = "";
      for (const c of result) {
        if (squeezeChars.has(c) && c === lastChar) continue;
        squeezed += c;
        lastChar = c;
      }
      result = squeezed;
    }

    return { stdout: result, stderr: "", exitCode: 0 };
  },
};

function expandSet(s: string): string {
  // Handle character classes like [:upper:], [:lower:], ranges like a-z
  let result = s;
  result = result.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  result = result.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz");
  result = result.replace(/\[:digit:\]/g, "0123456789");
  result = result.replace(/\[:space:\]/g, " \t\n\r");
  result = result.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
  result = result.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");

  // Expand ranges like a-z
  let expanded = "";
  let i = 0;
  while (i < result.length) {
    if (i + 2 < result.length && result[i + 1] === "-") {
      const start = result.charCodeAt(i);
      const end = result.charCodeAt(i + 2);
      for (let c = start; c <= end; c++) {
        expanded += String.fromCharCode(c);
      }
      i += 3;
    } else {
      expanded += result[i];
      i++;
    }
  }

  return expanded;
}
