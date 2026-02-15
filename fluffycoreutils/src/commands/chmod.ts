import type { FluffyCommand } from "../types.js";

/**
 * Parse a symbolic mode string like "+x", "u+rw", "go-w", "a=rx" or comma-separated "u+x,g+r".
 * Returns the new mode given the current mode, or null if invalid.
 */
function applySymbolicMode(modeStr: string, currentMode: number): number | null {
  const clauses = modeStr.split(',');
  let mode = currentMode;

  for (const clause of clauses) {
    const m = clause.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
    if (!m) return null;
    const [, who, op, perms] = m;

    // Default: no who specified = 'a' (all)
    const targets = who || 'ugo';

    // Build permission bits
    let bits = 0;
    if (perms.includes('r')) bits |= 4;
    if (perms.includes('w')) bits |= 2;
    if (perms.includes('x')) bits |= 1;
    if (perms.includes('X')) {
      // X = execute only if directory or already has execute
      if ((currentMode & 0o111) !== 0) bits |= 1;
    }

    // Apply to each target
    for (const t of targets) {
      let shift = 0;
      if (t === 'u') shift = 6;
      else if (t === 'g') shift = 3;
      else if (t === 'o') shift = 0;

      const shifted = bits << shift;
      switch (op) {
        case '+': mode |= shifted; break;
        case '-': mode &= ~shifted; break;
        case '=': mode = (mode & ~(7 << shift)) | shifted; break;
      }
    }
  }

  return mode;
}

export const chmod: FluffyCommand = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(args, io) {
    // Custom arg parsing: chmod [-R] MODE FILE...
    // MODE can start with +, -, or be octal/symbolic. Can't use generic parseArgs
    // because -x, +x etc. look like flags but are actually mode strings.
    let recursive = false;
    let modeStr = '';
    const targets: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!modeStr) {
        // First non-flag argument is the mode
        modeStr = arg;
      } else {
        targets.push(arg);
      }
    }

    if (!modeStr || targets.length === 0) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }

    async function chmodPath(path: string, mode: number): Promise<void> {
      const resolved = io.fs.resolvePath(path, io.cwd);
      if (io.fs.chmod) {
        await io.fs.chmod(resolved, mode);
      }
      if (recursive) {
        try {
          const stat = await io.fs.stat(resolved);
          if (stat.type === "dir") {
            const entries = await io.fs.readdir(resolved);
            for (const entry of entries) {
              await chmodPath(resolved + "/" + entry.name, mode);
            }
          }
        } catch { /* ignore */ }
      }
    }

    try {
      // Try octal mode first
      if (/^[0-7]+$/.test(modeStr)) {
        const octalMode = parseInt(modeStr, 8);
        for (const t of targets) {
          await chmodPath(t, octalMode);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      // Try symbolic mode
      for (const t of targets) {
        const resolved = io.fs.resolvePath(t, io.cwd);
        let currentMode = 0o644;
        try {
          const stat = await io.fs.stat(resolved);
          currentMode = stat.mode;
        } catch { /* use default */ }
        const newMode = applySymbolicMode(modeStr, currentMode);
        if (newMode === null) {
          return { stdout: "", stderr: `chmod: invalid mode: '${modeStr}'\n`, exitCode: 1 };
        }
        await chmodPath(t, newMode);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      return { stdout: "", stderr: `chmod: ${e instanceof Error ? e.message : e}\n`, exitCode: 1 };
    }
  },
};
