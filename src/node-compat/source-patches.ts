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
  ]],
}];

export function patchPackageSource(path: string | undefined, code: string): string {
  if (!path) return code;
  for (const p of PATCHES) if (p.file.test(path)) for (const [from, to] of p.edits) code = code.replace(from, to);
  return code;
}
