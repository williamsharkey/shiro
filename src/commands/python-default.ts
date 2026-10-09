/**
 * `python`, `python3`, `pip` and `pip3` when the profile's python shim is
 * "cpython" (docs/PROFILES.md): the prebuilt CPython package (`pkg install
 * python3`, WASI, scripts/pkgbuild/python3.sh), installed on first use. Once
 * it is installed its /usr/bin links shadow these builtins, so this only
 * runs the first time (and in Debian mode, Debian's python3 wins once apt
 * has installed it). Pyodide stays available as `pyodide`.
 */
import type { Command, CommandContext } from './index';

const PY_PACKAGE = 'python3';

/** Install the CPython package if it isn't; returns an exit code (0 = ready). */
async function ensureCPython(ctx: CommandContext, name: string): Promise<number> {
  const pm = await import('../pkg-manager');
  if ((await pm.readStatus(ctx.fs))[PY_PACKAGE]) return 0;
  // Say so on the terminal only: scripts' stderr stays clean
  ctx.terminal?.writeOutput(`${name}: installing CPython (pkg install ${PY_PACKAGE}) on first use...\r\n`);
  try {
    await pm.installPackages(ctx.fs, await pm.loadIndex(ctx.fs), [PY_PACKAGE], { env: ctx.env });
    return 0;
  } catch (e: any) {
    ctx.stderr += `${name}: could not install ${PY_PACKAGE}: ${e?.message ?? e}\n`;
    return 1;
  }
}

function cpython(name: string): Command {
  return {
    name,
    description: 'Python 3 interpreter (CPython for WASI; installs the python3 package on first use)',
    async exec(ctx) {
      const rc = await ensureCPython(ctx, name);
      if (rc) return rc;
      const pm = await import('../pkg-manager');
      return pm.runPackageBinary(`${pm.PKG_ROOT}/${PY_PACKAGE}/bin/python3.wasm`, name, ctx.args, ctx, `/usr/bin/${name}`);
    },
  };
}

function cpip(name: string): Command {
  return {
    name,
    description: 'Install Python packages for CPython (pure-Python wheels from PyPI)',
    async exec(ctx) {
      const rc = await ensureCPython(ctx, name);
      if (rc) return rc;
      const pip = await import('./pip');
      return pip.pipMain(ctx, ctx.args, await pip.pipTarget(ctx));
    },
  };
}

export const cpythonCmd = cpython('python');
export const cpython3Cmd = cpython('python3');
export const cpipCmd = cpip('pip');
export const cpip3Cmd = cpip('pip3');
