import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const tr: FluffyCommand = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, []);
    const deleteMode = flags.d;
    const squeeze = flags.s;
    const complement = flags.c || flags.C;
    const truncate = flags.t;

    let set1 = expandSet(positional[0] ?? "");
    let set2 = expandSet(positional[1] ?? "");
    const input = io.stdin;

    // Handle complement flag
    if (complement && set1) {
      set1 = getComplement(set1);
    }

    // Handle truncate flag - truncate set1 to length of set2
    if (truncate && set2) {
      set1 = set1.slice(0, set2.length);
    }

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

    // Handle squeeze - can be used alone or with delete/translate
    if (squeeze) {
      const squeezeChars = set2 ? new Set(set2.split("")) : (set1 ? new Set(set1.split("")) : null);
      if (squeezeChars) {
        let squeezed = "";
        let lastChar = "";
        for (const c of result) {
          if (squeezeChars.has(c) && c === lastChar) continue;
          squeezed += c;
          lastChar = c;
        }
        result = squeezed;
      }
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
  result = result.replace(/\[:punct:\]/g, "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
  result = result.replace(/\[:print:\]/g, " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~");

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

function getComplement(set: string): string {
  // Return all printable ASCII characters NOT in the set
  const chars = new Set(set.split(""));
  let complement = "";

  // Include all printable ASCII (32-126) plus common whitespace
  for (let i = 9; i <= 126; i++) {
    // Include tab (9), newline (10), carriage return (13), and printable chars (32-126)
    if (i === 9 || i === 10 || i === 13 || (i >= 32 && i <= 126)) {
      const char = String.fromCharCode(i);
      if (!chars.has(char)) {
        complement += char;
      }
    }
  }

  return complement;
}
