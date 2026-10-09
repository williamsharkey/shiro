/**
 * The parts of the WASI CPython package (`pkg install python3`) that Shiro
 * runs itself: `python -m pip`, `python -m venv` and `python -m ensurepip`.
 */
import type { CommandContext } from './index';
import { pipMain, venvMain, venvOf, venvTarget, systemTarget } from './pip';

export async function runPythonFrontend(ctx: CommandContext, args: string[], invokedPath: string): Promise<number> {
  const i = args.indexOf('-m');
  const mod = args[i + 1];
  const rest = args.slice(i + 2);
  if (mod === 'venv') return venvMain(ctx, rest);
  if (mod === 'ensurepip') {
    ctx.stdout += 'pip is built into tabcomputer (python -m pip, pip); nothing to bootstrap.\n';
    return 0;
  }
  // a venv's python installs into that venv, like real pip
  const venv = await venvOf(ctx.fs, invokedPath);
  return pipMain(ctx, rest, venv ? venvTarget(venv) : systemTarget());
}
