import type { FluffyCommand } from "../types.js";

/**
 * array - Helper for array variable operations
 *
 * Arrays are a shell feature for storing multiple values in a single variable:
 *   arr=(value1 value2 value3)
 *   echo ${arr[0]}
 *   echo ${arr[@]}
 *   echo ${#arr[@]}
 *
 * This helper command assists shells in managing array variables.
 * The shell should:
 * 1. Parse array assignment syntax: var=(values)
 * 2. Store array elements with numeric indices
 * 3. Support array expansion: ${arr[index]}, ${arr[@]}, ${arr[*]}
 * 4. Support array operations: ${#arr[@]} (length), ${arr[@]:start:length} (slice)
 * 5. Support append operations: arr+=(new values)
 *
 * This command is a stub that provides guidance for shell implementers.
 */
export const arrayHelper: FluffyCommand = {
  name: "array",
  description: "Helper for array variable operations (shell feature)",
  async exec(args, io) {
    if (args.length > 0 && args[0] === "--help") {
      return {
        stdout: `array: This is a shell language feature, not a command.

Array syntax must be implemented at the shell variable level:

Declaration:
  arr=(value1 value2 value3)
  arr=()  # empty array
  arr[0]=value1
  arr[5]=value5  # sparse array

Access:
  \${arr[0]}      # First element (0-indexed)
  \${arr[1]}      # Second element
  \${arr[-1]}     # Last element (bash 4.3+)
  \${arr[@]}      # All elements as separate words
  \${arr[*]}      # All elements as single word
  \${#arr[@]}     # Array length
  \${!arr[@]}     # Array indices

Operations:
  arr+=(value4 value5)           # Append elements
  unset arr[2]                   # Remove element
  \${arr[@]:start}               # Slice from start
  \${arr[@]:start:length}        # Slice with length
  \${arr[@]/pattern/replacement} # Replace in all elements

Iteration:
  for item in "\${arr[@]}"; do
    echo "\$item"
  done

  for i in "\${!arr[@]}"; do
    echo "arr[\$i] = \${arr[\$i]}"
  done

Implementation guidance for shells:
1. Store arrays as objects/maps with numeric keys
2. Implement expansion patterns for \${arr[...]} syntax
3. Handle @ vs * difference (word splitting)
4. Support sparse arrays (missing indices)
5. Implement array-specific operations (length, slice, etc.)

Example shell pseudo-code:
  arrays = {}  // Map of variable name to array

  // Assignment: arr=(a b c)
  arrays['arr'] = ['a', 'b', 'c']

  // Access: \${arr[1]}
  value = arrays['arr'][1]  // 'b'

  // All elements: \${arr[@]}
  values = arrays['arr'].join(' ')  // 'a b c'

  // Length: \${#arr[@]}
  length = arrays['arr'].length  // 3

Shell implementers: Parse array syntax at the variable expansion level.
\n`,
        stderr: "",
        exitCode: 0
      };
    }

    return {
      stdout: "",
      stderr: "array: This is a shell feature. Use --help for implementation guidance.\n",
      exitCode: 1
    };
  },
};
