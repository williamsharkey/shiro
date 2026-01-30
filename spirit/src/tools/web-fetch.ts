import type { OSProvider } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description:
    "Fetch content from a URL. Returns the response body as text. " +
    "Useful for reading web pages, APIs, documentation, and other HTTP resources. " +
    "The URL must be a fully-formed valid URL (e.g., https://example.com).",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
      method: {
        type: "string",
        description: 'HTTP method (default: "GET")',
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
      },
      headers: {
        type: "object",
        description: "Optional HTTP headers as key-value pairs",
      },
      body: {
        type: "string",
        description: "Optional request body (for POST/PUT/PATCH)",
      },
    },
    required: ["url"],
  },
};

export async function executeWebFetch(
  input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  _provider: OSProvider
): Promise<string> {
  const url = input.url.trim();

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol} (only http/https allowed)`);
  }

  const method = input.method || "GET";
  const fetchOptions: RequestInit = {
    method,
    headers: input.headers,
  };

  if (input.body && ["POST", "PUT", "PATCH"].includes(method)) {
    fetchOptions.body = input.body;
  }

  const response = await fetch(url, fetchOptions);
  const status = response.status;
  const statusText = response.statusText;
  const contentType = response.headers.get("content-type") || "";

  const text = await response.text();

  // Strip HTML tags for readability if it's an HTML response
  let content = text;
  if (contentType.includes("text/html")) {
    content = htmlToText(text);
  }

  // Truncate very large responses
  const MAX_LENGTH = 100_000;
  if (content.length > MAX_LENGTH) {
    content = content.slice(0, MAX_LENGTH) + "\n\n[... truncated, response was " + text.length + " characters]";
  }

  return `HTTP ${status} ${statusText}\nContent-Type: ${contentType}\nURL: ${url}\n\n${content}`;
}

/**
 * Simple HTML to text conversion — strips tags, decodes entities,
 * and collapses whitespace for readable output.
 */
function htmlToText(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Convert common block elements to newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n");
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|pre)[\s>]/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}
