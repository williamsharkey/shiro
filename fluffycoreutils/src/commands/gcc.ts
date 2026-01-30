import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

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
export const gcc: FluffyCommand = {
  name: "gcc",
  description: "GNU C Compiler (stub)",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, [
      "c", "S", "E", "o", "I", "L", "l", "D",
      "Wall", "Werror", "O0", "O1", "O2", "O3", "Os",
      "g", "shared", "static", "fPIC", "fpic",
      "std", "pedantic", "ansi", "v", "version",
      "M", "MM", "MD", "MMD", "MF", "MT", "MQ"
    ]);

    // --version or -v: show version
    if (flags.version || flags.v) {
      return {
        stdout: `gcc (GCC) 9.3.0 (stub)\nCopyright (C) 2019 Free Software Foundation, Inc.
This is a stub implementation for browser-based environments.
To enable real C compilation, integrate WASM-based tcc or Emscripten.
\n`,
        stderr: "",
        exitCode: 0
      };
    }

    // No input files
    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "gcc: fatal error: no input files\ncompilation terminated.\n",
        exitCode: 1
      };
    }

    const inputFiles = positional;
    const outputFile = values.o || "a.out";

    // Check if input files exist
    for (const file of inputFiles) {
      const resolvedPath = io.fs.resolvePath(file, io.cwd);
      if (!(await io.fs.exists(resolvedPath))) {
        return {
          stdout: "",
          stderr: `gcc: error: ${file}: No such file or directory\ngcc: fatal error: no input files\ncompilation terminated.\n`,
          exitCode: 1
        };
      }
    }

    // Read source files to check for simple patterns
    let hasMain = false;
    let sourceContent = "";

    for (const file of inputFiles) {
      if (file.endsWith(".c") || file.endsWith(".cc") || file.endsWith(".cpp")) {
        try {
          const resolvedPath = io.fs.resolvePath(file, io.cwd);
          const content = await io.fs.readFile(resolvedPath);
          sourceContent += content + "\n";

          // Check for main function
          if (/int\s+main\s*\(/.test(content) || /void\s+main\s*\(/.test(content)) {
            hasMain = true;
          }
        } catch (err: any) {
          return {
            stdout: "",
            stderr: `gcc: error: ${file}: ${err.message}\n`,
            exitCode: 1
          };
        }
      }
    }

    // Preprocessing only (-E)
    if (flags.E) {
      // Just return the source with preprocessor directives removed
      const preprocessed = sourceContent
        .split("\n")
        .filter(line => !line.trim().startsWith("#"))
        .join("\n");

      return {
        stdout: preprocessed,
        stderr: "",
        exitCode: 0
      };
    }

    // Compile only, don't link (-c)
    if (flags.c) {
      // Create .o files
      for (const file of inputFiles) {
        if (file.endsWith(".c") || file.endsWith(".cc") || file.endsWith(".cpp")) {
          const objFile = file.replace(/\.(c|cc|cpp)$/, ".o");
          const resolvedObjPath = io.fs.resolvePath(objFile, io.cwd);

          // Write a stub object file
          await io.fs.writeFile(resolvedObjPath, `# Object file stub for ${file}\n`);
        }
      }

      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // Assembly only (-S)
    if (flags.S) {
      for (const file of inputFiles) {
        if (file.endsWith(".c") || file.endsWith(".cc") || file.endsWith(".cpp")) {
          const asmFile = file.replace(/\.(c|cc|cpp)$/, ".s");
          const resolvedAsmPath = io.fs.resolvePath(asmFile, io.cwd);

          // Write a stub assembly file
          await io.fs.writeFile(resolvedAsmPath, `# Assembly stub for ${file}\n.text\n.globl main\nmain:\n  ret\n`);
        }
      }

      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // Full compilation and linking (default)
    // Check if we have a main function for executable
    if (!hasMain && !flags.shared && !flags.c) {
      return {
        stdout: "",
        stderr: `gcc: error: undefined reference to 'main'\ncollect2: error: ld returned 1 exit status\n`,
        exitCode: 1
      };
    }

    // Create a simple executable stub
    const resolvedOutputPath = io.fs.resolvePath(outputFile, io.cwd);

    // Detect if it's a hello world program
    const isHelloWorld = /printf\s*\(\s*["'].*[Hh]ello.*["']/.test(sourceContent) ||
                         /puts\s*\(\s*["'].*[Hh]ello.*["']/.test(sourceContent);

    let executableContent = "#!/bin/sh\n";
    if (isHelloWorld) {
      executableContent += "echo 'Hello, World!'\n";
    } else {
      executableContent += "# Compiled binary stub\n";
    }

    await io.fs.writeFile(resolvedOutputPath, executableContent);

    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  },
};

// cc is typically a symlink to gcc
export const cc: FluffyCommand = {
  name: "cc",
  description: "C Compiler (alias for gcc)",
  async exec(args, io) {
    return gcc.exec(args, io);
  },
};
