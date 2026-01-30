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
export declare const arrayHelper: FluffyCommand;
