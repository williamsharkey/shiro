
import type { Command } from './index';
import { parseArgs, readFileText } from './flags';
export const comm: Command = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);

    if (positional.length < 2) {
      ctx.stderr += "comm: missing operand\n";
      return 1;
    }

    const suppress1 = flags["1"];
    const suppress2 = flags["2"];
    const suppress3 = flags["3"];

    try {
      // Read both files
      const file1Path = ctx.fs.resolvePath(positional[0], ctx.cwd);
      const file2Path = ctx.fs.resolvePath(positional[1], ctx.cwd);

      const content1 = await readFileText(ctx.fs, file1Path);
      const content2 = await readFileText(ctx.fs, file2Path);

      const lines1 = content1.split("\n").filter(l => l !== "" || content1.endsWith("\n"));
      const lines2 = content2.split("\n").filter(l => l !== "" || content2.endsWith("\n"));

      // Remove trailing empty lines
      if (lines1.length > 0 && lines1[lines1.length - 1] === "") lines1.pop();
      if (lines2.length > 0 && lines2[lines2.length - 1] === "") lines2.pop();

      const output: string[] = [];
      let i = 0, j = 0;

      while (i < lines1.length || j < lines2.length) {
        const line1 = i < lines1.length ? lines1[i] : null;
        const line2 = j < lines2.length ? lines2[j] : null;

        if (line1 === null) {
          // Only line2 remains
          if (!suppress2) {
            const indent = suppress1 ? "" : "\t";
            output.push(indent + line2);
          }
          j++;
        } else if (line2 === null) {
          // Only line1 remains
          if (!suppress1) {
            output.push(line1);
          }
          i++;
        } else if (line1 < line2) {
          // line1 is unique
          if (!suppress1) {
            output.push(line1);
          }
          i++;
        } else if (line1 > line2) {
          // line2 is unique
          if (!suppress2) {
            const indent = suppress1 ? "" : "\t";
            output.push(indent + line2);
          }
          j++;
        } else {
          // Lines are equal (in both files)
          if (!suppress3) {
            let indent = "";
            if (!suppress1) indent += "\t";
            if (!suppress2) indent += "\t";
            output.push(indent + line1);
          }
          i++;
          j++;
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `comm: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
