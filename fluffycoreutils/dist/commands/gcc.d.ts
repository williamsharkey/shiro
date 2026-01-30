import type { FluffyCommand } from "../types.js";
/**
 * gcc/cc - GNU C Compiler stub
 *
 * This is a stub implementation that simulates basic gcc behavior.
 * In a real browser environment, you could integrate with:
 * - WASM-based tcc (Tiny C Compiler)
 * - Emscripten for C to WASM compilation
 * - A remote compilation service
 *
 * For now, this stub:
 * - Recognizes common flags
 * - Can "compile" simple hello world programs
 * - Returns success for basic compilation commands
 */
export declare const gcc: FluffyCommand;
export declare const cc: FluffyCommand;
