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
export declare const caseCmd: FluffyCommand;
export declare const esac: FluffyCommand;
