import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const hexdump: FluffyCommand = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["n", "s", "C"]);

    const canonical = flags.C;
    const length = values.n ? parseInt(values.n) : undefined;
    const skip = values.s ? parseInt(values.s) : 0;

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      let data = content.substring(skip, length ? skip + length : undefined);
      const output: string[] = [];

      if (canonical) {
        // Canonical hex+ASCII display
        for (let i = 0; i < data.length; i += 16) {
          const chunk = data.substring(i, i + 16);
          const offset = (skip + i).toString(16).padStart(8, "0");

          // Hex part (two groups of 8 bytes)
          const hex1 = formatHexGroup(chunk.substring(0, 8));
          const hex2 = formatHexGroup(chunk.substring(8, 16));

          // ASCII part
          const ascii = formatAscii(chunk);

          output.push(`${offset}  ${hex1}  ${hex2}  |${ascii}|`);
        }

        // Final offset
        const finalOffset = (skip + data.length).toString(16).padStart(8, "0");
        output.push(finalOffset);
      } else {
        // Default hexdump format
        for (let i = 0; i < data.length; i += 16) {
          const chunk = data.substring(i, i + 16);
          const offset = (skip + i).toString(16).padStart(7, "0");

          const words: string[] = [];
          for (let j = 0; j < chunk.length; j += 2) {
            const byte1 = chunk.charCodeAt(j);
            const byte2 = j + 1 < chunk.length ? chunk.charCodeAt(j + 1) : 0;
            const word = ((byte1 << 8) | byte2).toString(16).padStart(4, "0");
            words.push(word);
          }

          output.push(`${offset} ${words.join(" ")}`);
        }

        // Final offset
        const finalOffset = (skip + data.length).toString(16).padStart(7, "0");
        output.push(finalOffset);
      }

      return {
        stdout: output.join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `hexdump: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

function formatHexGroup(chunk: string): string {
  const bytes: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (i < chunk.length) {
      bytes.push(chunk.charCodeAt(i).toString(16).padStart(2, "0"));
    } else {
      bytes.push("  ");
    }
  }
  return bytes.join(" ");
}

function formatAscii(chunk: string): string {
  let result = "";
  for (let i = 0; i < 16; i++) {
    if (i < chunk.length) {
      const code = chunk.charCodeAt(i);
      result += (code >= 32 && code < 127) ? chunk[i] : ".";
    } else {
      result += " ";
    }
  }
  return result;
}
