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
export const heredoc: FluffyCommand = {
  name: "heredoc",
  description: "Helper for here-document processing (shell feature)",
  async exec(args, io) {
    return {
      stdout: `heredoc: This is a shell language feature, not a command.

Here-document syntax must be implemented at the shell parser level:

Syntax:
  command << DELIMITER
  content line 1
  content line 2
  DELIMITER

Variants:
  <<  DELIMITER  - Normal mode (variable expansion enabled)
  << 'DELIMITER' - Literal mode (no expansion)
  <<- DELIMITER  - Strip leading tabs from content lines

Implementation guidance for shell parsers:
1. When encountering <<, capture the delimiter (next token)
2. Read subsequent lines until line exactly matches delimiter
3. Apply expansions ($var, $(cmd), \`cmd\`) unless in literal mode
4. If <<-, strip leading tabs from each line
5. Pass the collected content as stdin to the command

Examples:
  cat << EOF
  Hello, \${USER}!
  The date is \$(date)
  EOF

  cat << 'EOF'
  Literal \${USER} - no expansion
  EOF

  cat <<- EOF
  \\tThis line had a leading tab that was stripped
  EOF

Shell implementers: Parse heredoc at the token/syntax level before command execution.
\n`,
      stderr: "",
      exitCode: 0
    };
  },
};
