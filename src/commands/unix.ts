/**
 * Barrel export: all Unix commands (formerly fluffycoreutils).
 * These are native Shiro Command implementations for standard Unix utilities.
 */

import type { Command } from './index';

import { alias } from './alias';
import { arrayHelper } from './array';
import { awk } from './awk';
import { base64 } from './base64';
import { basename } from './basename';
import { bc } from './bc';
import { breakCmd } from './break';
import { caseCmd, esac } from './case';
import { cat } from './cat';
import { chmod } from './chmod';
import { chown } from './chown';
import { clear } from './clear';
import { column } from './column';
import { comm } from './comm';
import { continueCmd } from './continue';
import { cp } from './cp';
import { cut } from './cut';
import { date } from './date';
import { declare, local, readonly, unset } from './local';
import { df } from './df';
import { dirname } from './dirname';
import { doCmd, done, until, whileCmd } from './while';
import { du } from './du';
import { echo } from './echo';
import { elif, elseCmd, fi, ifCmd, then } from './if';
import { env } from './env';
import { evalCmd } from './eval';
import { exit } from './exit';
import { expand } from './expand';
import { expr } from './expr';
import { exportCmd } from './export';
import { false as falseCmd } from './false';
import { forCmd, inCmd } from './for';
import { functionCmd } from './function';
import { file } from './file';
import { fmt } from './fmt';
import { fold } from './fold';
import { free } from './free';
import { getopts } from './getopts';
import { hash } from './hash';
import { head } from './head';
import { heredoc } from './heredoc';
import { hexdump } from './hexdump';
import { id } from './id';
import { install } from './install';
import { join } from './join';
import { less } from './less';
import { letCmd, arithmeticExpansion } from './let';
import { ls } from './ls';
import { make } from './make';
import { md5sum } from './md5sum';
import { mkdir } from './mkdir';
import { mv } from './mv';
import { nl } from './nl';
import { nohup } from './nohup';
import { od } from './od';
import { paste } from './paste';
import { patch } from './patch';
import { pkgConfig } from './pkg-config';
import { pr } from './pr';
import { printenv } from './printenv';
import { printf } from './printf';
import { processSubstitution } from './process-substitution';
import { pwd } from './pwd';
import { read } from './read';
import { readlink } from './readlink';
import { realpath } from './realpath';
import { returnCmd } from './return';
import { seq } from './seq';
import { set } from './set';
import { sha256sum } from './sha256sum';
import { shift } from './shift';
import { shrine } from './shrine';
import { sleep } from './sleep';
import { sort } from './sort';
import { stat } from './stat';
import { strings } from './strings';
import { tail } from './tail';
import { tar } from './tar';
import { tee } from './tee';
import { test } from './posix-test';
import { time } from './time';
import { timeout } from './timeout';
import { touch } from './touch';
import { tr } from './tr';
import { kill, trap } from './trap';
import { true as trueCmd } from './true';
import { tsort } from './tsort';
import { type } from './type';
import { ulimit } from './ulimit';
import { umask } from './umask';
import { unalias } from './unalias';
import { unexpand } from './unexpand';
import { uniq } from './uniq';
import { uptime } from './uptime';
import { watch } from './watch';
import { wc } from './wc';
import { which } from './which';
import { whoami } from './whoami';
import { xargs } from './xargs';
import { yes } from './yes';

/** All Unix commands as an array for registration. */
export const unixCommands: Command[] = [
  alias, arrayHelper, awk, base64, basename, bc, breakCmd,
  caseCmd, esac, cat, chmod, chown, clear, column, comm, continueCmd, cp, cut,
  date, declare, local, readonly, unset, df, dirname, doCmd, done, until, whileCmd,
  du, echo, elif, elseCmd, fi, ifCmd, then, env, evalCmd, exit, expand, expr,
  exportCmd, falseCmd, forCmd, inCmd, functionCmd, file, fmt, fold, free,
  getopts, hash, head, heredoc, hexdump, id, install, join, kill, less, letCmd,
  ls, make, md5sum, mkdir, mv, nl, nohup, od, paste, patch, pkgConfig, pr,
  printenv, printf, processSubstitution, pwd, read, readlink, realpath, returnCmd,
  seq, set, sha256sum, shift, shrine, sleep, sort, stat, strings, tail, tar, tee,
  test, time, timeout, touch, tr, trap, trueCmd, tsort, type, ulimit, umask,
  unalias, unexpand, uniq, uptime, watch, wc, which, whoami, xargs, yes,
];

/** Arithmetic expansion helper for $(( )) syntax */
export { arithmeticExpansion };
