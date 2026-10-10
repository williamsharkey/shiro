/**
 * Edits to a few packages' files as node-compat loads them, where a package
 * does something a page can't and an equivalent exists.
 *
 * esbuild-wasm's bin/esbuild (the child node its API runs, and vite 7's and
 * Astro's esbuild) compiles its 12 MB esbuild.wasm with the synchronous
 * `new WebAssembly.Module`, which Chromium refuses on a page's main thread
 * over 8 MB. Its helper already returns a promise, so it can compile
 * asynchronously instead.
 */
const PATCHES: { file: RegExp; edits: [string, string][] }[] = [{
  // (installed as esbuild too: npm-tree.ts puts esbuild-wasm where esbuild goes)
  file: /\/esbuild(-wasm)?\/bin\/esbuild$/,
  edits: [[
    'const module = new WebAssembly.Module(bytes);\n  const instance = new WebAssembly.Instance(module, importObject);\n  return Promise.resolve({ instance, module });',
    'return WebAssembly.instantiate(bytes, importObject);',
  ], [
    // Go's runtime ends with go.exit(code) from inside its own event loop, where
    // process.exit's throw (how a script stops here) has nothing above it to land
    // in, and surfaced as a page error: the process has ended all the same.
    // (wasm_exec_node.js is read and run by this file, not required)
    "const code = fs.readFileSync(wasm_exec_node, 'utf8');",
    // and its bare `fs` is the process's own globalThis.fs (process-global.ts keeps that per process)
    String.raw`const code = fs.readFileSync(wasm_exec_node, 'utf8').replace('go.exit = process.exit;', 'go.exit = (c) => { try { process.exit(c); } catch (e) { if (!/^process\\.exit\\(/.test(String(e && e.message))) throw e; } };').replace('WebAssembly.instantiate(fs.readFileSync(', 'WebAssembly.instantiate(globalThis.fs.readFileSync(');`,
  ]],
}, {
  // Go's wasm_exec.js writes the runtime's own output (a panic's trace) with a bare `fs`
  file: /\/wasm_exec\.(?:c|m)?js$/,
  edits: [['fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));', 'globalThis.fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));']],
}];

export function patchPackageSource(path: string | undefined, code: string): string {
  if (!path) return code;
  for (const p of PATCHES) if (p.file.test(path)) for (const [from, to] of p.edits) code = code.replace(from, to);
  return code;
}
