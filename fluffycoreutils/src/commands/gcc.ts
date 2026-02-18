import type { FluffyCommand } from "../types.js";

/**
 * gcc/cc - Stub that defers to the real xcc/wcc C compiler in Shiro.
 * The real implementation is in Shiro's src/commands/cc.ts.
 */
export const gcc: FluffyCommand = {
  name: "gcc",
  description: "C compiler (use cc for real compilation)",
  async exec(_args, _io) {
    return {
      stdout: "",
      stderr: "gcc: use 'cc' for real C compilation (xcc/wcc compiler)\n",
      exitCode: 1
    };
  },
};

export const cc: FluffyCommand = {
  name: "cc",
  description: "C compiler (stub — overridden by Shiro's real cc)",
  async exec(_args, _io) {
    return {
      stdout: "",
      stderr: "cc: this stub should be overridden by the real compiler\n",
      exitCode: 1
    };
  },
};
