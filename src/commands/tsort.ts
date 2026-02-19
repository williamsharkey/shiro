
import type { Command } from './index';
import { readFileText } from './flags';
export const tsort: Command = {
  name: "tsort",
  description: "Perform topological sort",
  async exec(ctx) {
    const args = ctx.args;
    const files = args.length > 0 ? args : ["-"];

    let content: string;
    try {
      if (files[0] === "-" || files.length === 0) {
        content = ctx.stdin;
      } else {
        const path = ctx.fs.resolvePath(files[0], ctx.cwd);
        content = await readFileText(ctx.fs, path);
      }
    } catch (err) {
      ctx.stderr += `tsort: ${files[0]}: ${err instanceof Error ? err.message : String(err)}\n`;
      return 1;
    }

    // Parse pairs from input
    const tokens = content.trim().split(/\s+/).filter(Boolean);

    if (tokens.length % 2 !== 0) {
      ctx.stderr += "tsort: odd number of tokens\n";
      return 1;
    }

    // Build adjacency list and track all nodes
    const graph = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();
    const allNodes = new Set<string>();

    for (let i = 0; i < tokens.length; i += 2) {
      const from = tokens[i];
      const to = tokens[i + 1];

      allNodes.add(from);
      allNodes.add(to);

      if (!graph.has(from)) {
        graph.set(from, new Set());
      }
      graph.get(from)!.add(to);
    }

    // Initialize in-degrees
    for (const node of allNodes) {
      if (!inDegree.has(node)) {
        inDegree.set(node, 0);
      }
    }

    // Calculate in-degrees
    for (const [_, neighbors] of graph) {
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
      }
    }

    // Kahn's algorithm for topological sorting
    const queue: string[] = [];
    const result: string[] = [];

    // Start with nodes that have no incoming edges
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }

    // Sort the initial queue for deterministic output
    queue.sort();

    while (queue.length > 0) {
      // Sort queue to ensure deterministic output
      queue.sort();
      const node = queue.shift()!;
      result.push(node);

      const neighbors = graph.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          const newDegree = inDegree.get(neighbor)! - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) {
            queue.push(neighbor);
          }
        }
      }
    }

    // Check for cycles
    if (result.length !== allNodes.size) {
      ctx.stderr += "tsort: cycle detected\n";
      return 1;
    }

    ctx.stdout += result.join("\n") + "\n";
    return 0;
  },
};
