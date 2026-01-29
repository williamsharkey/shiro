import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const uname: FluffyCommand = {
  name: "uname",
  description: "Print system information",
  async exec(args, io) {
    const { flags } = parseArgs(args);
    const all = flags.a;

    const sysname = io.env.UNAME_SYSNAME ?? "FluffyOS";
    const nodename = io.env.HOSTNAME ?? "localhost";
    const release = io.env.UNAME_RELEASE ?? "1.0.0";
    const version = io.env.UNAME_VERSION ?? "#1";
    const machine = io.env.UNAME_MACHINE ?? "wasm64";

    if (all) {
      return { stdout: `${sysname} ${nodename} ${release} ${version} ${machine}\n`, stderr: "", exitCode: 0 };
    }
    if (flags.s || (!flags.n && !flags.r && !flags.v && !flags.m)) {
      return { stdout: sysname + "\n", stderr: "", exitCode: 0 };
    }

    const parts: string[] = [];
    if (flags.s) parts.push(sysname);
    if (flags.n) parts.push(nodename);
    if (flags.r) parts.push(release);
    if (flags.v) parts.push(version);
    if (flags.m) parts.push(machine);

    return { stdout: parts.join(" ") + "\n", stderr: "", exitCode: 0 };
  },
};
