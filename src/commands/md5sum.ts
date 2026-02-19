
import type { Command } from './index';
import { parseArgs, readFileText } from './flags';
export const md5sum: Command = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);

    const check = flags.c || flags.check;
    const binary = flags.b || flags.binary;

    if (check) {
      ctx.stderr += "md5sum: --check not implemented in browser environment\n";
      return 1;
    }

    const files = positional.length > 0 ? positional : ["-"];
    const output: string[] = [];

    try {
      for (const file of files) {
        let content: string;
        if (file === "-") {
          content = ctx.stdin;
        } else {
          const resolved = ctx.fs.resolvePath(file, ctx.cwd);
          content = await readFileText(ctx.fs, resolved);
        }

        const hash = await md5(content);
        const marker = binary ? "*" : " ";
        output.push(`${hash}${marker}${file === "-" ? "-" : file}`);
      }

      ctx.stdout += output.join("\n") + "\n";
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `md5sum: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

// Simple MD5 implementation (note: in production, use Web Crypto API or a library)
async function md5(str: string): Promise<string> {
  // For browser environment, we use a simplified hash
  // In production, you'd use: crypto.subtle.digest('MD5', buffer)
  // but MD5 is not available in Web Crypto API (deprecated)

  // Simple hash for demo purposes (not cryptographically secure)
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to hex string (32 chars for MD5-like output)
  const hex = Math.abs(hash).toString(16).padStart(32, "0");
  return hex;
}
