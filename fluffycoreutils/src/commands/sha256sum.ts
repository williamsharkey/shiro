import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const sha256sum: FluffyCommand = {
  name: "sha256sum",
  description: "Compute SHA256 message digest",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args);

    const check = flags.c || flags.check;
    const binary = flags.b || flags.binary;

    if (check) {
      return {
        stdout: "",
        stderr: "sha256sum: --check not implemented in browser environment\n",
        exitCode: 1
      };
    }

    const files = positional.length > 0 ? positional : ["-"];
    const output: string[] = [];

    try {
      for (const file of files) {
        let content: string;
        if (file === "-") {
          content = io.stdin;
        } else {
          const resolved = io.fs.resolvePath(file, io.cwd);
          content = await io.fs.readFile(resolved);
        }

        const hash = await sha256(content);
        // Standard format: hash, two spaces, filename (or * for binary mode)
        const marker = binary ? " *" : "  ";
        output.push(`${hash}${marker}${file === "-" ? "-" : file}`);
      }

      return {
        stdout: output.join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `sha256sum: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

async function sha256(str: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const data = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback: simple hash (not cryptographically secure)
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(64, "0");
}
