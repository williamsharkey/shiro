import type { FluffyCommand } from "../types.js";
/**
 * heredoc - Helper for here-document processing
 *
 * Here-documents are a shell feature for multi-line input redirection:
 *   command << EOF
 *   line 1
 *   line 2
 *   EOF
 *
 * This helper command assists shells in processing here-documents.
 * The shell parser should:
 * 1. Recognize << DELIMITER syntax
 * 2. Collect lines until DELIMITER is found
 * 3. Pass the collected content as stdin to the command
 * 4. Support <<- for tab-stripping
 * 5. Support << 'EOF' for literal (no expansion) mode
 *
 * This command is a stub that provides guidance for shell implementers.
 */
export declare const heredoc: FluffyCommand;
