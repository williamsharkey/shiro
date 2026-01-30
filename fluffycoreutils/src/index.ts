export type { FluffyCommand, FluffyFS, FluffyEntry, FluffyStat, CommandIO, CommandResult } from "./types.js";

// Command imports
import { awk } from "./commands/awk.js";
import { base64 } from "./commands/base64.js";
import { basename } from "./commands/basename.js";
import { cat } from "./commands/cat.js";
import { chmod } from "./commands/chmod.js";
import { chown } from "./commands/chown.js";
import { clear } from "./commands/clear.js";
import { comm } from "./commands/comm.js";
import { cp } from "./commands/cp.js";
import { curl } from "./commands/curl.js";
import { cut } from "./commands/cut.js";
import { date } from "./commands/date.js";
import { df } from "./commands/df.js";
import { diff } from "./commands/diff.js";
import { dirname } from "./commands/dirname.js";
import { du } from "./commands/du.js";
import { echo } from "./commands/echo.js";
import { env } from "./commands/env.js";
import { expand } from "./commands/expand.js";
import { expr } from "./commands/expr.js";
import { exportCmd } from "./commands/export.js";
import { false as falseCmd } from "./commands/false.js";
import { file } from "./commands/file.js";
import { find } from "./commands/find.js";
import { fmt } from "./commands/fmt.js";
import { fold } from "./commands/fold.js";
import { free } from "./commands/free.js";
import { grep } from "./commands/grep.js";
import { head } from "./commands/head.js";
import { hexdump } from "./commands/hexdump.js";
import { hostname } from "./commands/hostname.js";
import { id } from "./commands/id.js";
import { install } from "./commands/install.js";
import { join } from "./commands/join.js";
import { less } from "./commands/less.js";
import { ln } from "./commands/ln.js";
import { ls } from "./commands/ls.js";
import { make } from "./commands/make.js";
import { md5sum } from "./commands/md5sum.js";
import { mkdir } from "./commands/mkdir.js";
import { mv } from "./commands/mv.js";
import { nl } from "./commands/nl.js";
import { od } from "./commands/od.js";
import { paste } from "./commands/paste.js";
import { patch } from "./commands/patch.js";
import { printenv } from "./commands/printenv.js";
import { printf } from "./commands/printf.js";
import { pwd } from "./commands/pwd.js";
import { readlink } from "./commands/readlink.js";
import { realpath } from "./commands/realpath.js";
import { rm } from "./commands/rm.js";
import { sed } from "./commands/sed.js";
import { seq } from "./commands/seq.js";
import { sha256sum } from "./commands/sha256sum.js";
import { sleep } from "./commands/sleep.js";
import { sort } from "./commands/sort.js";
import { stat } from "./commands/stat.js";
import { strings } from "./commands/strings.js";
import { tail } from "./commands/tail.js";
import { tar } from "./commands/tar.js";
import { tee } from "./commands/tee.js";
import { test } from "./commands/test.js";
import { time } from "./commands/time.js";
import { timeout } from "./commands/timeout.js";
import { touch } from "./commands/touch.js";
import { tr } from "./commands/tr.js";
import { true as trueCmd } from "./commands/true.js";
import { type } from "./commands/type.js";
import { unexpand } from "./commands/unexpand.js";
import { uniq } from "./commands/uniq.js";
import { uname } from "./commands/uname.js";
import { uptime } from "./commands/uptime.js";
import { wc } from "./commands/wc.js";
import { which } from "./commands/which.js";
import { whoami } from "./commands/whoami.js";
import { xargs } from "./commands/xargs.js";
import { yes } from "./commands/yes.js";

import type { FluffyCommand } from "./types.js";

// Re-export individual commands
export {
  awk, base64, basename, cat, chmod, chown, clear, comm, cp, curl, cut, date, df, diff, dirname, du,
  echo, env, expand, expr, exportCmd, file, find, fmt, fold, free, grep, head, hexdump, hostname, id, install, join, less, ln, ls,
  make, md5sum, mkdir, mv, nl, od, paste, patch, printenv, printf, pwd, readlink, realpath, rm, sed, seq, sha256sum, sleep, sort, stat, strings,
  tail, tar, tee, test, time, timeout, touch, tr, type, unexpand, uniq, uname, uptime, wc, which, whoami, xargs, yes,
  falseCmd as false,
  trueCmd as true,
};

/** All commands as a name→command map for easy registration in a shell. */
export const allCommands: Record<string, FluffyCommand> = {
  awk, base64, basename, cat, chmod, chown, clear, comm, cp, curl, cut, date, df, diff, dirname, du,
  echo, env, expand, expr, export: exportCmd, false: falseCmd, file, find, fmt, fold, free, grep, head, hexdump, hostname, id, install, join, less, ln,
  ls, make, md5sum, mkdir, mv, nl, od, paste, patch, printenv, printf, pwd, readlink, realpath, rm, sed, seq, sha256sum, sleep, sort, stat, strings,
  tail, tar, tee, test, time, timeout, touch, tr, true: trueCmd, type, unexpand, uniq, uname, uptime, wc, which, whoami, xargs, yes,
};

/** Array of all commands for iteration. */
export const commandList: FluffyCommand[] = Object.values(allCommands);
