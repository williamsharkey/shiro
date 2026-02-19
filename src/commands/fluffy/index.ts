/**
 * Barrel export: all fluffycoreutils commands, pre-adapted to Shiro Command interface.
 */

export type { FluffyCommand, FluffyFS, FluffyEntry, FluffyStat, CommandIO, CommandResult } from './types';

import { alias } from './alias';
import { arrayHelper } from './array';
import { awk } from './awk';
import { base64 } from './base64';
import { basename } from './basename';
import { bc } from './bc';
import { breakCmd } from './break';
import { caseCmd, esac } from './case';
import { cat } from './cat';
import { cc, gcc } from './gcc';
import { chmod } from './chmod';
import { chown } from './chown';
import { clear } from './clear';
import { column } from './column';
import { comm } from './comm';
import { continueCmd } from './continue';
import { cp } from './cp';
import { curl } from './curl';
import { cut } from './cut';
import { date } from './date';
import { declare, local, readonly, unset } from './local';
import { df } from './df';
import { diff } from './diff';
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
import { find } from './find';
import { fmt } from './fmt';
import { fold } from './fold';
import { free } from './free';
import { getopts } from './getopts';
import { grep } from './grep';
import { hash } from './hash';
import { head } from './head';
import { heredoc } from './heredoc';
import { hexdump } from './hexdump';
import { hostname } from './hostname';
import { id } from './id';
import { install } from './install';
import { join } from './join';
import { less } from './less';
import { letCmd, arithmeticExpansion } from './let';
import { ln } from './ln';
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
import { rm } from './rm';
import { sed } from './sed';
import { seq } from './seq';
import { set } from './set';
import { sha256sum } from './sha256sum';
import { shift } from './shift';
import { shrine } from './shrine';
import { sleep } from './sleep';
import { sort } from './sort';
import { source, dot } from './source';
import { stat } from './stat';
import { strings } from './strings';
import { tail } from './tail';
import { tar } from './tar';
import { tee } from './tee';
import { test } from './test';
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
import { uname } from './uname';
import { uptime } from './uptime';
import { watch } from './watch';
import { wc } from './wc';
import { which } from './which';
import { whoami } from './whoami';
import { xargs } from './xargs';
import { yes } from './yes';

import type { FluffyCommand } from './types';
import type { Command } from '../index';
import { wrapFluffyCommand } from './adapt';

/** All fluffy commands as a name→FluffyCommand map. */
const fluffyCommands: Record<string, FluffyCommand> = {
  ".": dot, alias, array: arrayHelper, awk, base64, basename, bc, break: breakCmd, case: caseCmd, cc, cat, chmod, chown, clear, column, comm, continue: continueCmd, cp, curl, cut, date, declare, df, diff, dirname, do: doCmd, done, du,
  echo, elif, else: elseCmd, env, esac, eval: evalCmd, exit, expand, expr, export: exportCmd, false: falseCmd, fi, file, find, fmt, fold, for: forCmd, free, function: functionCmd, gcc, getopts, grep, hash, head, heredoc, hexdump, hostname, id, if: ifCmd, in: inCmd, install, join, kill, less, let: letCmd, ln, local, ls,
  make, md5sum, mkdir, mv, nl, nohup, od, paste, patch, "pkg-config": pkgConfig, pr, "process-substitution": processSubstitution, printenv, printf, pwd, read, readlink, readonly, realpath, return: returnCmd, rm, sed, seq, set, sha256sum, shift, shrine, sleep, sort, source, stat, strings,
  tail, tar, tee, test, then, time, timeout, touch, tr, trap, true: trueCmd, tsort, type, ulimit, umask, unalias, unexpand, uniq, unset, uname, until, uptime, watch, wc, which, while: whileCmd, whoami, xargs, yes,
};

/** All commands pre-adapted to Shiro Command interface. */
export const allCommands: Record<string, Command> = {};
for (const [name, fluffy] of Object.entries(fluffyCommands)) {
  allCommands[name] = wrapFluffyCommand(fluffy);
}

/** Array of all adapted commands for iteration. */
export const commandList: Command[] = Object.values(allCommands);

/** Arithmetic expansion helper for $(( )) syntax */
export { arithmeticExpansion };

/** Re-export adapt utilities for test helpers */
export { wrapFluffyCommand, createFluffyFS } from './adapt';
