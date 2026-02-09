import type { FluffyCommand } from "../types.js";

export const tsort: FluffyCommand = {
  name: "tsort",
  description: "Perform topological sort",
  async exec(args, io) {
    const files = args.length > 0 ? args : ["-"];

    let content: string;
    try {
      if (files[0] === "-" || files.length === 0) {
        content = io.stdin;
      } else {
        const path = io.fs.resolvePath(files[0], io.cwd);
        content = await io.fs.readFile(path);
      }
    } catch (err) {
      return {
        stdout: "",
        stderr: `tsort: ${files[0]}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    // Parse pairs from input
    const tokens = content.trim().split(/\s+/).filter(Boolean);

    if (tokens.length % 2 !== 0) {
      return {
        stdout: "",
        stderr: "tsort: odd number of tokens\n",
        exitCode: 1,
      };
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
      return {
        stdout: "",
        stderr: "tsort: cycle detected\n",
        exitCode: 1,
      };
    }

    return {
      stdout: result.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  },
};
