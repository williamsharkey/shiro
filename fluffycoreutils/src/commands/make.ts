import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const make: FluffyCommand = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(args, io) {
    const { values, positional, flags } = parseArgs(args, ["f", "file", "C", "j"]);

    const makefile = values.f || values.file || "Makefile";
    const directory = values.C;
    const jobs = values.j || "1";
    const dryRun = flags.n || flags["dry-run"];
    const justPrint = flags.p || flags.print;

    const targets = positional.length > 0 ? positional : ["all"];

    try {
      // Change to directory if specified
      const cwd = directory ? io.fs.resolvePath(directory, io.cwd) : io.cwd;

      // Read Makefile
      const makefilePath = io.fs.resolvePath(makefile, cwd);
      let content: string;
      try {
        content = await io.fs.readFile(makefilePath);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${makefile}: No such file or directory\n`,
          exitCode: 2
        };
      }

      // Parse Makefile
      const rules = parseMakefile(content);

      const output: string[] = [];

      // Execute targets
      for (const target of targets) {
        const rule = rules.get(target);
        if (!rule) {
          return {
            stdout: "",
            stderr: `make: *** No rule to make target '${target}'. Stop.\n`,
            exitCode: 2
          };
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

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `make: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 2
      };
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
