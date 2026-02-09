import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

/**
 * pkg-config - Return metainformation about installed libraries
 *
 * This is a stub implementation that provides common flags and
 * returns sensible defaults for browser-based environments.
 */
export const pkgConfig: FluffyCommand = {
  name: "pkg-config",
  description: "Return metainformation about installed libraries",
  async exec(args, io) {
    const { flags, positional } = parseArgs(args, [
      "cflags", "libs", "modversion", "version", "exists",
      "atleast-version", "exact-version", "max-version",
      "list-all", "print-errors", "short-errors", "silence-errors",
      "static", "print-provides", "print-requires"
    ]);

    // --version: show pkg-config version
    if (flags.version) {
      return {
        stdout: "0.29.2\n",
        stderr: "",
        exitCode: 0
      };
    }

    // --list-all: list all available packages
    if (flags["list-all"]) {
      // In a real system, this would list installed .pc files
      const packages = [
        "zlib                    zlib - zlib compression library",
        "openssl                 OpenSSL - Secure Sockets Layer toolkit",
        "libcurl                 libcurl - Library for transferring data",
      ];
      return {
        stdout: packages.join("\n") + "\n",
        stderr: "",
        exitCode: 0
      };
    }

    if (positional.length === 0) {
      return {
        stdout: "",
        stderr: "pkg-config: Must specify package names on the command line\n",
        exitCode: 1
      };
    }

    const packageName = positional[0];

    // --exists: check if package exists (always return success in stub)
    if (flags.exists) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // --modversion: show package version
    if (flags.modversion) {
      // Return reasonable versions for common packages
      const versions: Record<string, string> = {
        "zlib": "1.2.11",
        "openssl": "1.1.1",
        "libcurl": "7.68.0",
        "sqlite3": "3.31.1",
        "libpng": "1.6.37",
        "libjpeg": "9c",
        "libxml-2.0": "2.9.10",
        "glib-2.0": "2.64.0",
      };
      const version = versions[packageName] || "1.0.0";
      return {
        stdout: version + "\n",
        stderr: "",
        exitCode: 0
      };
    }

    // --cflags: show compiler flags
    if (flags.cflags) {
      // Return minimal flags for browser environment
      const cflags: Record<string, string> = {
        "zlib": "-I/usr/include",
        "openssl": "-I/usr/include/openssl",
        "libcurl": "-I/usr/include/curl",
        "sqlite3": "-I/usr/include",
        "glib-2.0": "-I/usr/include/glib-2.0 -I/usr/lib/glib-2.0/include",
      };
      const flags_str = cflags[packageName] || "";
      return {
        stdout: flags_str ? flags_str + "\n" : "\n",
        stderr: "",
        exitCode: 0
      };
    }

    // --libs: show linker flags
    if (flags.libs) {
      const libs: Record<string, string> = {
        "zlib": "-lz",
        "openssl": "-lssl -lcrypto",
        "libcurl": "-lcurl",
        "sqlite3": "-lsqlite3",
        "libpng": "-lpng",
        "libjpeg": "-ljpeg",
        "libxml-2.0": "-lxml2",
        "glib-2.0": "-lglib-2.0",
      };
      const libs_str = libs[packageName] || "";
      return {
        stdout: libs_str ? libs_str + "\n" : "\n",
        stderr: "",
        exitCode: 0
      };
    }

    // --print-provides: show what package provides
    if (flags["print-provides"]) {
      return {
        stdout: `${packageName} = 1.0.0\n`,
        stderr: "",
        exitCode: 0
      };
    }

    // --print-requires: show what package requires
    if (flags["print-requires"]) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // Default: no flags provided
    return {
      stdout: "",
      stderr: "pkg-config: Must specify at least one option (--cflags, --libs, --modversion, etc.)\n",
      exitCode: 1
    };
  },
};
