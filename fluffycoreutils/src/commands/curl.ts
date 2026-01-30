import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const curl: FluffyCommand = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(args, io) {
    const { flags, values, positional } = parseArgs(args, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);

    if (positional.length === 0) {
      return { stdout: "", stderr: "curl: no URL specified!\n", exitCode: 1 };
    }

    const url = positional[0];
    const method = values.X || values.request || (values.d || values.data ? "POST" : "GET");
    const outputFile = values.o || values.output;
    const silent = flags.s || flags.silent;
    const showHeaders = flags.i || flags.include;
    const headersOnly = flags.I || flags.head;
    const followRedirects = flags.L || flags.location;

    // Build headers
    const headers: Record<string, string> = {};
    const headerValue = values.H || values.header;
    if (headerValue) {
      const parts = headerValue.split(":");
      if (parts.length >= 2) {
        headers[parts[0].trim()] = parts.slice(1).join(":").trim();
      }
    }

    const userAgent = values["user-agent"] || "fluffycoreutils-curl/0.1.0";
    headers["User-Agent"] = userAgent;

    // Build body
    let body: string | undefined;
    if (values.d || values.data) {
      body = values.d || values.data;
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    try {
      const fetchOptions: RequestInit = {
        method: headersOnly ? "HEAD" : method,
        headers,
        redirect: followRedirects ? "follow" : "manual",
      };

      if (body && method !== "GET" && method !== "HEAD") {
        fetchOptions.body = body;
      }

      const response = await fetch(url, fetchOptions);

      let output = "";

      // Show response headers if requested
      if (showHeaders || headersOnly) {
        output += `HTTP/1.1 ${response.status} ${response.statusText}\n`;
        response.headers.forEach((value, key) => {
          output += `${key}: ${value}\n`;
        });
        output += "\n";
      }

      // Get response body (unless HEAD request)
      if (!headersOnly) {
        const text = await response.text();
        output += text;
      }

      // Write to file if -o specified
      if (outputFile) {
        const resolvedPath = io.fs.resolvePath(outputFile, io.cwd);
        await io.fs.writeFile(resolvedPath, headersOnly ? "" : await response.text());
        if (!silent) {
          return {
            stdout: "",
            stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${output.length}  100  ${output.length}    0     0   ${output.length}      0 --:--:-- --:--:-- --:--:--  ${output.length}\n`,
            exitCode: 0
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      // Normal output
      if (!silent && !response.ok) {
        return {
          stdout: output,
          stderr: `curl: (22) The requested URL returned error: ${response.status}\n`,
          exitCode: 22
        };
      }

      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${error}\n`,
        exitCode: 6
      };
    }
  },
};
