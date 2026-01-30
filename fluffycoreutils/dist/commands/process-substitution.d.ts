import type { FluffyCommand } from "../types.js";
/**
 * process-substitution - Helper for process substitution
 *
 * Process substitution is a shell feature that treats command output as a file:
 *   diff <(sort file1) <(sort file2)
 *   command > >(tee log.txt)
 *
 * This helper command assists shells in implementing process substitution.
 * The shell should:
 * 1. Recognize <(command) and >(command) syntax
 * 2. Execute the command in a subshell
 * 3. Create a temporary file or named pipe with the output
 * 4. Replace the substitution with the file path
 * 5. Clean up temporary resources after command completes
 *
 * This command is a stub that provides guidance for shell implementers.
 */
export declare const processSubstitution: FluffyCommand;
