import type { FluffyCommand } from "../types.js";
/**
 * let - Evaluate arithmetic expressions
 *
 * The let command evaluates arithmetic expressions and returns 0 if the
 * result is non-zero, 1 if the result is zero.
 *
 * Syntax:
 *   let arg [arg ...]
 *   let "expression"
 *   let var=expression
 *
 * Operators (in order of precedence):
 *   - Unary: -, +, !, ~
 *   - Arithmetic: *, /, %
 *   - Addition: +, -
 *   - Shift: <<, >>
 *   - Comparison: <, >, <=, >=
 *   - Equality: ==, !=
 *   - Bitwise: &, ^, |
 *   - Logical: &&, ||
 *   - Assignment: =, +=, -=, *=, /=, %=
 *
 * Examples:
 *   let "x = 5 + 3"
 *   let "y = x * 2"
 *   let "z = x > 5"
 */
export declare const letCmd: FluffyCommand;
declare function evaluateArithmetic(expr: string, env: Record<string, string>): number;
/**
 * Arithmetic expansion helper - used by shells for $(( )) syntax
 */
export declare const arithmeticExpansion: {
    evaluate: typeof evaluateArithmetic;
};
export {};
