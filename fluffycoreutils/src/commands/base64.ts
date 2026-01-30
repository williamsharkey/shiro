import type { FluffyCommand } from "../types.js";
import { parseArgs, readInput } from "../flags.js";

export const base64: FluffyCommand = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);

    const decode = flags.d || flags.decode;
    const wrap = flags.w ? parseInt(flags.w as any) : 76;
    const ignoreGarbage = flags.i || flags["ignore-garbage"];

    try {
      const { content } = await readInput(
        positional,
        io.stdin,
        io.fs,
        io.cwd,
        io.fs.resolvePath
      );

      let result: string;

      if (decode) {
        // Decode base64
        const cleaned = ignoreGarbage
          ? content.replace(/[^A-Za-z0-9+/=]/g, "")
          : content.replace(/\s/g, "");

        try {
          // Browser-compatible base64 decode
          const decoded = (globalThis as any).atob(cleaned);
          result = decoded;
        } catch (e) {
          return {
            stdout: "",
            stderr: `base64: invalid input\n`,
            exitCode: 1
          };
        }
      } else {
        // Encode base64
        const encoded = (globalThis as any).btoa(content);

        // Wrap lines
        if (wrap > 0) {
          const lines: string[] = [];
          for (let i = 0; i < encoded.length; i += wrap) {
            lines.push(encoded.substring(i, i + wrap));
          }
          result = lines.join("\n");
        } else {
          result = encoded;
        }
      }

      return {
        stdout: result + (result ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `base64: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};
