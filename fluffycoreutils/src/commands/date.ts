import type { FluffyCommand } from "../types.js";

export const date: FluffyCommand = {
  name: "date",
  description: "Display date and time",
  async exec(args) {
    const now = new Date();

    if (args.length > 0 && args[0].startsWith("+")) {
      const fmt = args[0].slice(1);
      const result = formatDate(now, fmt);
      return { stdout: result + "\n", stderr: "", exitCode: 0 };
    }

    return { stdout: now.toString() + "\n", stderr: "", exitCode: 0 };
  },
};

function formatDate(d: Date, fmt: string): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return fmt
    .replace(/%Y/g, String(d.getFullYear()))
    .replace(/%m/g, pad2(d.getMonth() + 1))
    .replace(/%d/g, pad2(d.getDate()))
    .replace(/%H/g, pad2(d.getHours()))
    .replace(/%M/g, pad2(d.getMinutes()))
    .replace(/%S/g, pad2(d.getSeconds()))
    .replace(/%s/g, String(Math.floor(d.getTime() / 1000)))
    .replace(/%n/g, "\n")
    .replace(/%t/g, "\t")
    .replace(/%%/g, "%");
}
