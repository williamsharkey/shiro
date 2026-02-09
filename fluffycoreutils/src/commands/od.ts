import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const od: FluffyCommand = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["t", "N", "j", "w", "A"]);

    const typeSpec = values.t || "o2"; // default: octal 2-byte
    const maxBytes = values.N ? parseInt(values.N) : undefined;
    const skip = values.j ? parseInt(values.j) : 0;
    const width = values.w ? parseInt(values.w) : 16;
    const addressRadix = values.A || "o"; // o=octal, d=decimal, x=hex, n=none

    const traditional = flags.b || flags.c || flags.d || flags.o || flags.s || flags.x;

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      let data = content.substring(skip, maxBytes ? skip + maxBytes : undefined);
      const output: string[] = [];

      // Parse type specification
      let formatType = "o"; // o=octal, x=hex, d=decimal, c=char, a=named char
      let formatSize = 2; // bytes per unit

      if (traditional) {
        // Traditional options override -t
        if (flags.b) { formatType = "o"; formatSize = 1; }
        else if (flags.c) { formatType = "c"; formatSize = 1; }
        else if (flags.d || flags.s) { formatType = "d"; formatSize = 2; }
        else if (flags.o) { formatType = "o"; formatSize = 2; }
        else if (flags.x) { formatType = "x"; formatSize = 2; }
      } else if (typeSpec) {
        formatType = typeSpec[0] || "o";
        formatSize = parseInt(typeSpec.substring(1)) || 2;
      }

      let offset = skip;

      for (let i = 0; i < data.length; i += width) {
        const chunk = data.substring(i, i + width);
        const addr = formatAddress(offset, addressRadix);
        const values = formatChunk(chunk, formatType, formatSize);

        output.push(`${addr} ${values}`);
        offset += chunk.length;
      }

      // Final address
      if (addressRadix !== "n") {
        output.push(formatAddress(offset, addressRadix));
      }

      return {
        stdout: output.join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `od: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

function formatAddress(offset: number, radix: string): string {
  switch (radix) {
    case "o": return offset.toString(8).padStart(7, "0");
    case "d": return offset.toString(10).padStart(7, " ");
    case "x": return offset.toString(16).padStart(7, "0");
    case "n": return "";
    default: return offset.toString(8).padStart(7, "0");
  }
}

function formatChunk(chunk: string, type: string, size: number): string {
  const values: string[] = [];

  for (let i = 0; i < chunk.length; i += size) {
    const bytes = chunk.substring(i, i + size);
    let value = 0;

    // Convert bytes to number
    for (let j = 0; j < bytes.length; j++) {
      value = (value << 8) | bytes.charCodeAt(j);
    }

    switch (type) {
      case "o":
        values.push(value.toString(8).padStart(size * 3, "0"));
        break;
      case "x":
        values.push(value.toString(16).padStart(size * 2, "0"));
        break;
      case "d":
        values.push(value.toString(10).padStart(size * 3, " "));
        break;
      case "c":
        values.push(formatChar(bytes.charCodeAt(0)));
        break;
      case "a":
        values.push(namedChar(bytes.charCodeAt(0)));
        break;
      default:
        values.push(value.toString(8).padStart(size * 3, "0"));
    }
  }

  return values.join(" ");
}

function formatChar(code: number): string {
  if (code >= 32 && code < 127) return `  ${String.fromCharCode(code)}`;
  if (code === 0) return " \\0";
  if (code === 7) return " \\a";
  if (code === 8) return " \\b";
  if (code === 9) return " \\t";
  if (code === 10) return " \\n";
  if (code === 11) return " \\v";
  if (code === 12) return " \\f";
  if (code === 13) return " \\r";
  return code.toString(8).padStart(3, "0");
}

function namedChar(code: number): string {
  const names: Record<number, string> = {
    0: "nul", 7: "bel", 8: "bs", 9: "ht", 10: "nl", 11: "vt", 12: "ff", 13: "cr",
    32: "sp", 127: "del"
  };
  return names[code] || String.fromCharCode(code);
}
