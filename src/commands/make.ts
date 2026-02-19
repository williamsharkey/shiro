
import type { Command } from './index';
import { parseArgs, readFileText } from './flags';
export const make: Command = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(ctx) {
    const args = ctx.args;
    const { values, positional, flags } = parseArgs(args, ["f", "file", "C", "j"]);

    const makefile = values.f || values.file || "Makefile";
    const directory = values.C;
    const jobs = values.j || "1";
    const dryRun = flags.n || flags["dry-run"];
    const justPrint = flags.p || flags.print;

    const targets = positional.length > 0 ? positional : ["all"];

    try {
      // Change to directory if specified
      const cwd = directory ? ctx.fs.resolvePath(directory, ctx.cwd) : ctx.cwd;

      // Read Makefile
      const makefilePath = ctx.fs.resolvePath(makefile, cwd);
      let content: string;
      try {
        content = await readFileText(ctx.fs, makefilePath);
      } catch {
        ctx.stderr += `make: ${makefile}: No such file or directory\n`;
        return 2;
      }

      // Parse Makefile
      const rules = parseMakefile(content);

      const output: string[] = [];

      // Execute targets
      for (const target of targets) {
        const rule = rules.get(target);
        if (!rule) {
          ctx.stderr += `make: *** No rule to make target '${target}'. Stop.\n`;
          return 2;
        }

        // Check prerequisites
        for (const prereq of rule.prerequisites) {
          const prereqRule = rules.get(prereq);
          if (prereqRule) {
            // Recursively build prerequisite
            for (const cmd of prereqRule.commands) {
              if (justPrint || dryRun) {
                output.push(cmd);
              } else {
                output.push(`# ${cmd}`);
                // In a real implementation, would execute the command
              }
            }
          }
        }

        // Execute target commands
        for (const cmd of rule.commands) {
          if (justPrint || dryRun) {
            output.push(cmd);
          } else {
            output.push(`# ${cmd}`);
            // In a real implementation, would execute the command
            // For browser environment, we just show what would be run
          }
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `make: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

interface MakeRule {
  target: string;
  prerequisites: string[];
  commands: string[];
}

function parseMakefile(content: string): Map<string, MakeRule> {
  const rules = new Map<string, MakeRule>();
  const lines = content.split("\n");
  let currentRule: MakeRule | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") {
      continue;
    }

    // Check for rule definition (target: prerequisites)
    if (line.includes(":") && !line.startsWith("\t")) {
      const colonIndex = line.indexOf(":");
      const target = line.substring(0, colonIndex).trim();
      const prereqStr = line.substring(colonIndex + 1).trim();
      const prerequisites = prereqStr ? prereqStr.split(/\s+/) : [];

      currentRule = { target, prerequisites, commands: [] };
      rules.set(target, currentRule);
    }
    // Check for command (starts with tab)
    else if (line.startsWith("\t") && currentRule) {
      currentRule.commands.push(line.substring(1));
    }
  }

  return rules;
}
