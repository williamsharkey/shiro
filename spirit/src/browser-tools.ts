/**
 * Optional browser-specific tools for Spirit.
 * Both Shiro and Foam can opt into these since they run in-browser.
 *
 * Usage:
 *   import { SpiritAgent, browserTools } from 'spirit';
 *   const agent = new SpiritAgent(provider, config);
 *   browserTools.forEach(t => agent.registerTool(t.definition, t.execute));
 */

import type { OSProvider } from "./providers/types.js";
import type { ToolDefinition } from "./types.js";

interface BrowserTool {
  definition: ToolDefinition;
  execute: (
    input: Record<string, unknown>,
    provider: OSProvider
  ) => Promise<string>;
}

const jsEval: BrowserTool = {
  definition: {
    name: "JSEval",
    description:
      "Execute JavaScript code in the browser page context and return the result. Has access to the DOM, window, document, and all browser APIs.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to evaluate",
        },
      },
      required: ["code"],
    },
  },
  async execute(input) {
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(input.code as string);
      return String(result ?? "(undefined)");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};

const domQuery: BrowserTool = {
  definition: {
    name: "DOMQuery",
    description:
      "Query the DOM using a CSS selector. Returns the outer HTML of matching elements (truncated if large).",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector (e.g., '#app', '.container', 'h1')",
        },
        limit: {
          type: "number",
          description: "Max number of elements to return (default 5)",
        },
      },
      required: ["selector"],
    },
  },
  async execute(input) {
    const selector = input.selector as string;
    const limit = (input.limit as number) ?? 5;
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) return `No elements match "${selector}"`;
    const results: string[] = [];
    const count = Math.min(elements.length, limit);
    for (let i = 0; i < count; i++) {
      const html = elements[i].outerHTML;
      results.push(html.length > 500 ? html.slice(0, 500) + "..." : html);
    }
    const suffix =
      elements.length > limit
        ? `\n(${elements.length - limit} more elements not shown)`
        : "";
    return results.join("\n\n") + suffix;
  },
};

const domMutate: BrowserTool = {
  definition: {
    name: "DOMMutate",
    description:
      "Modify a DOM element. Can set innerHTML, textContent, style properties, attributes, or remove elements.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the target element",
        },
        action: {
          type: "string",
          enum: [
            "setInnerHTML",
            "setTextContent",
            "setAttribute",
            "setStyle",
            "remove",
            "insertAdjacentHTML",
          ],
          description: "The mutation to perform",
        },
        value: {
          type: "string",
          description:
            "Value for the mutation. For setAttribute: 'name=value'. For setStyle: 'property=value'. For insertAdjacentHTML: 'position|html'.",
        },
      },
      required: ["selector", "action"],
    },
  },
  async execute(input) {
    const selector = input.selector as string;
    const action = input.action as string;
    const value = (input.value as string) ?? "";
    const el = document.querySelector(selector);
    if (!el) return `Error: no element matches "${selector}"`;

    switch (action) {
      case "setInnerHTML":
        el.innerHTML = value;
        break;
      case "setTextContent":
        el.textContent = value;
        break;
      case "setAttribute": {
        const eq = value.indexOf("=");
        if (eq < 0) return "Error: setAttribute value must be 'name=value'";
        el.setAttribute(value.slice(0, eq), value.slice(eq + 1));
        break;
      }
      case "setStyle": {
        const eq = value.indexOf("=");
        if (eq < 0) return "Error: setStyle value must be 'property=value'";
        (el as HTMLElement).style.setProperty(
          value.slice(0, eq),
          value.slice(eq + 1)
        );
        break;
      }
      case "remove":
        el.remove();
        break;
      case "insertAdjacentHTML": {
        const sep = value.indexOf("|");
        if (sep < 0)
          return "Error: insertAdjacentHTML value must be 'position|html'";
        el.insertAdjacentHTML(
          value.slice(0, sep) as InsertPosition,
          value.slice(sep + 1)
        );
        break;
      }
      default:
        return `Error: unknown action "${action}"`;
    }
    return `OK: ${action} on "${selector}"`;
  },
};

export const browserTools: BrowserTool[] = [jsEval, domQuery, domMutate];
