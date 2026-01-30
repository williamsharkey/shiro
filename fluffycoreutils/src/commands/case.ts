import type { FluffyCommand } from "../types.js";

/**
 * case - Pattern matching (shell language construct)
 *
 * This is a placeholder for shell parsers. In a real shell, the 'case' statement
 * is parsed as part of the shell language, not executed as a command.
 *
 * Syntax:
 *   case WORD in
 *     PATTERN) COMMANDS ;;
 *     PATTERN) COMMANDS ;;
 *     *) COMMANDS ;;
 *   esac
 *
 * The shell should:
 * 1. Parse the entire case/esac block
 * 2. Evaluate WORD
 * 3. Match against PATTERN (supports wildcards)
 * 4. Execute COMMANDS for first matching pattern
 * 5. Handle ;; (break), ;& (fallthrough), ;;& (test next)
 */
export const caseCmd: FluffyCommand = {
  name: "case",
  description: "Pattern matching (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "case: this is a shell language construct that must be interpreted by the shell\nUsage: case WORD in PATTERN) COMMANDS ;; esac\n",
      exitCode: 2
    };
  },
};

export const esac: FluffyCommand = {
  name: "esac",
  description: "End case statement (shell language construct)",
  async exec(args, io) {
    return {
      stdout: "",
      stderr: "esac: can only be used to close a case statement\n",
      exitCode: 2
    };
  },
};
