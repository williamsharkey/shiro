export type { FluffyCommand, FluffyFS, FluffyEntry, FluffyStat, CommandIO, CommandResult } from "./types.js";

// Command imports
import { basename } from "./commands/basename.js";
import { cat } from "./commands/cat.js";
import { chmod } from "./commands/chmod.js";
import { clear } from "./commands/clear.js";
import { cp } from "./commands/cp.js";
import { cut } from "./commands/cut.js";
import { date } from "./commands/date.js";
import { diff } from "./commands/diff.js";
import { dirname } from "./commands/dirname.js";
import { echo } from "./commands/echo.js";
import { env } from "./commands/env.js";
import { false as falseCmd } from "./commands/false.js";
import { find } from "./commands/find.js";
import { grep } from "./commands/grep.js";
import { head } from "./commands/head.js";
import { hostname } from "./commands/hostname.js";
import { ln } from "./commands/ln.js";
import { ls } from "./commands/ls.js";
import { mkdir } from "./commands/mkdir.js";
import { mv } from "./commands/mv.js";
import { printf } from "./commands/printf.js";
import { pwd } from "./commands/pwd.js";
import { readlink } from "./commands/readlink.js";
import { rm } from "./commands/rm.js";
import { sed } from "./commands/sed.js";
import { sort } from "./commands/sort.js";
import { tail } from "./commands/tail.js";
import { tee } from "./commands/tee.js";
import { test } from "./commands/test.js";
import { touch } from "./commands/touch.js";
import { tr } from "./commands/tr.js";
import { true as trueCmd } from "./commands/true.js";
import { uniq } from "./commands/uniq.js";
import { uname } from "./commands/uname.js";
import { wc } from "./commands/wc.js";
import { whoami } from "./commands/whoami.js";
import { xargs } from "./commands/xargs.js";

import type { FluffyCommand } from "./types.js";

// Re-export individual commands
export {
  basename, cat, chmod, clear, cp, cut, date, diff, dirname,
  echo, env, find, grep, head, hostname, ln, ls, mkdir, mv,
  printf, pwd, readlink, rm, sed, sort, tail, tee, test, touch,
  tr, uniq, uname, wc, whoami, xargs,
  falseCmd as false,
  trueCmd as true,
};

/** All commands as a name→command map for easy registration in a shell. */
export const allCommands: Record<string, FluffyCommand> = {
  basename, cat, chmod, clear, cp, cut, date, diff, dirname,
  echo, env, false: falseCmd, find, grep, head, hostname, ln,
  ls, mkdir, mv, printf, pwd, readlink, rm, sed, sort, tail,
  tee, test, touch, tr, true: trueCmd, uniq, uname, wc, whoami, xargs,
};

/** Array of all commands for iteration. */
export const commandList: FluffyCommand[] = Object.values(allCommands);
