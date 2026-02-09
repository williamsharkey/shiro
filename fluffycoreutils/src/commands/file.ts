import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const file: FluffyCommand = {
  name: "file",
  description: "Determine file type",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0) {
      return { stdout: "", stderr: "file: missing operand\n", exitCode: 1 };
    }

    const brief = flags.b;
    const mime = flags.i || flags.mime;
    const mimeType = flags["mime-type"];
    const mimeEncoding = flags["mime-encoding"];

    const output: string[] = [];

    try {
      for (const path of positional) {
        const resolved = io.fs.resolvePath(path, io.cwd);

        try {
          const stat = await io.fs.stat(resolved);

          if (stat.type === "dir") {
            const result = brief ? "directory" : `${path}: directory`;
            output.push(result);
            continue;
          }

          // Read file content to detect type
          const content = await io.fs.readFile(resolved);
          const fileType = detectFileType(content, path);

          let result: string;
          if (mimeType) {
            result = brief ? fileType.mimeType : `${path}: ${fileType.mimeType}`;
          } else if (mimeEncoding) {
            result = brief ? fileType.encoding : `${path}: ${fileType.encoding}`;
          } else if (mime) {
            result = brief
              ? `${fileType.mimeType}; charset=${fileType.encoding}`
              : `${path}: ${fileType.mimeType}; charset=${fileType.encoding}`;
          } else {
            result = brief ? fileType.description : `${path}: ${fileType.description}`;
          }

          output.push(result);
        } catch (e: unknown) {
          output.push(`${path}: cannot open (${e instanceof Error ? e.message : e})`);
        }
      }

      return {
        stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (e: unknown) {
      return {
        stdout: "",
        stderr: `file: ${e instanceof Error ? e.message : e}\n`,
        exitCode: 1
      };
    }
  },
};

interface FileTypeInfo {
  mimeType: string;
  encoding: string;
  description: string;
}

function detectFileType(content: string, filename: string): FileTypeInfo {
  // Default
  let mimeType = "text/plain";
  let encoding = "us-ascii";
  let description = "ASCII text";

  // Check for non-ASCII characters
  if (/[^\x00-\x7F]/.test(content)) {
    encoding = "utf-8";
    description = "UTF-8 Unicode text";
  }

  // Empty file
  if (content.length === 0) {
    mimeType = "application/x-empty";
    description = "empty";
    return { mimeType, encoding, description };
  }

  // Check by extension
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext) {
    switch (ext) {
      case "js":
      case "mjs":
        mimeType = "text/javascript";
        description = "JavaScript source";
        break;
      case "ts":
        mimeType = "text/x-typescript";
        description = "TypeScript source";
        break;
      case "json":
        mimeType = "application/json";
        description = "JSON data";
        break;
      case "html":
      case "htm":
        mimeType = "text/html";
        description = "HTML document";
        break;
      case "css":
        mimeType = "text/css";
        description = "CSS stylesheet";
        break;
      case "xml":
        mimeType = "text/xml";
        description = "XML document";
        break;
      case "md":
        mimeType = "text/markdown";
        description = "Markdown text";
        break;
      case "sh":
        mimeType = "text/x-shellscript";
        description = "shell script";
        break;
      case "py":
        mimeType = "text/x-python";
        description = "Python script";
        break;
      case "txt":
        mimeType = "text/plain";
        description = "ASCII text";
        break;
    }
  }

  // Check content signatures
  if (content.startsWith("#!/bin/sh") || content.startsWith("#!/bin/bash")) {
    mimeType = "text/x-shellscript";
    description = "Bourne-Again shell script";
  } else if (content.startsWith("#!/usr/bin/env node")) {
    mimeType = "text/javascript";
    description = "Node.js script";
  } else if (content.startsWith("#!/usr/bin/env python")) {
    mimeType = "text/x-python";
    description = "Python script";
  } else if (content.startsWith("{") && content.trim().endsWith("}")) {
    try {
      JSON.parse(content);
      mimeType = "application/json";
      description = "JSON data";
    } catch {
      // Not valid JSON
    }
  } else if (content.startsWith("<?xml")) {
    mimeType = "text/xml";
    description = "XML document";
  } else if (content.startsWith("<!DOCTYPE html") || content.startsWith("<html")) {
    mimeType = "text/html";
    description = "HTML document";
  }

  return { mimeType, encoding, description };
}
