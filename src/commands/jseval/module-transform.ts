// ES module ↔ CommonJS transform utilities (pure string transforms, no side effects)

export function stripShebang(src: string): string {
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    return nl >= 0 ? src.substring(nl + 1) : '';
  }
  return src;
}

export function transformBundledESM(src: string): string {
  // Fast path for large bundled files (>500KB).
  // Bundled ESM files have thousands of string/template literals.
  // The full regex-based transform introduces quote characters in
  // replacements (e.g. require("mod")) that break enclosing string
  // delimiters, causing SyntaxError: Invalid or unexpected token.
  //
  // This fast path only does safe transforms:
  // - Leading imports at file start (not inside strings)
  // - import.meta → __import_meta (no quotes introduced)
  // - import( → __dynamic_import( (no quotes introduced)
  // - Strip 'export' keyword (no quotes introduced)

  src = stripShebang(src);
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');


  // 1. Transform leading import statements at the file start.
  //    In bundled ESM, real imports are at position 0, NOT inside strings.
  let pos = 0;
  const parts: string[] = [];

  // Skip whitespace, semicolons, and comments before/between imports
  function skipNonCode() {
    while (pos < src.length) {
      if (/[\s;]/.test(src[pos])) { parts.push(src[pos]); pos++; continue; }
      // Single-line comment
      if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '/') {
        const nl = src.indexOf('\n', pos);
        const end = nl >= 0 ? nl + 1 : src.length;
        parts.push(src.substring(pos, end));
        pos = end;
        continue;
      }
      // Block comment
      if (src[pos] === '/' && pos + 1 < src.length && src[pos + 1] === '*') {
        const end = src.indexOf('*/', pos + 2);
        const commentEnd = end >= 0 ? end + 2 : src.length;
        parts.push(src.substring(pos, commentEnd));
        pos = commentEnd;
        continue;
      }
      break;
    }
  }
  skipNonCode();

  // Process consecutive import statements
  while (pos < src.length) {
    const rest = src.substring(pos);
    if (!rest.startsWith('import')) break;

    // Don't transform import.meta or import() here — handled globally below
    const afterImport = rest[6];
    if (afterImport === '.' || afterImport === '(') break;

    let matched = false;

    // import { x as y } from "module" (handles minified: import{x}from"m")
    const namedMatch = rest.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
    if (namedMatch) {
      const fixed = namedMatch[1].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      parts.push(`const {${fixed}} = require("${namedMatch[2]}");`);
      pos += namedMatch[0].length;
      matched = true;
    }

    if (!matched) {
      // import x, { y } from "module"
      const combinedMatch = rest.match(/^import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (combinedMatch) {
        const fixed = combinedMatch[2].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
        parts.push(`const ${combinedMatch[1]} = require("${combinedMatch[3]}"); const {${fixed}} = require("${combinedMatch[3]}");`);
        pos += combinedMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import x from "module"
      const defaultMatch = rest.match(/^import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (defaultMatch) {
        parts.push(`const ${defaultMatch[1]} = require("${defaultMatch[2]}");`);
        pos += defaultMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import * as x from "module"
      const starMatch = rest.match(/^import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*/);
      if (starMatch) {
        parts.push(`const ${starMatch[1]} = require("${starMatch[2]}");`);
        pos += starMatch[0].length;
        matched = true;
      }
    }

    if (!matched) {
      // import "module" (side-effect)
      const sideEffectMatch = rest.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*/);
      if (sideEffectMatch) {
        parts.push(`require("${sideEffectMatch[1]}");`);
        pos += sideEffectMatch[0].length;
        matched = true;
      }
    }

    if (!matched) break;
    skipNonCode(); // Skip whitespace/comments between imports
  }

  parts.push(src.substring(pos));
  src = parts.join('');

  // 2. import.meta → __import_meta (safe everywhere, no quotes introduced)
  src = src.replace(/import\.meta/g, '__import_meta');

  // 3. Dynamic import() → __dynamic_import()
  //    Safe: just replaces the keyword with a function name, no quotes.
  src = src.replace(/\bimport\s*\(/g, '__dynamic_import(');

  // 4. Transform remaining static imports globally.
  //    Minified bundles have imports scattered throughout (not just at the top)
  //    for externalized Node.js builtins (fs, path, os, crypto, etc.).
  //    Uses \s* instead of \s+ to handle minified import{x}from"y" patterns.

  // Note: JS identifiers can contain $ (common in minified code: Z$, M$6)
  // so we use [\w$]+ instead of \w+ for identifier matching.

  // import Default, { named } from "module"
  src = src.replace(/\bimport\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\3\s*;?/g,
    (_, defaultName, namedImports, q, mod) => {
      const fixed = namedImports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const ${defaultName} = require(${q}${mod}${q}); const {${fixed}} = require(${q}${mod}${q});`;
    });

  // import { x as y } from "module"  (handles minified: import{x}from"m")
  src = src.replace(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, imports, q, mod) => {
      const fixed = imports.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2');
      return `const {${fixed}} = require(${q}${mod}${q});`;
    });

  // import x from "module"
  src = src.replace(/\bimport\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

  // import * as x from "module"  (handles minified: import*as x from"m")
  src = src.replace(/\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `const ${name} = require(${q}${mod}${q});`);

  // import "module" (side-effect only)
  src = src.replace(/\bimport\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `require(${q}${mod}${q});`);

  // 5. Strip 'export' keyword from declarations (safe, no quotes introduced).
  src = src.replace(/\bexport\s+default\s+/g, 'module.exports = ');
  src = src.replace(/\bexport\s+async\s+function\s+/g, 'async function ');
  src = src.replace(/\bexport\s+function\s+/g, 'function ');
  src = src.replace(/\bexport\s+class\s+/g, 'class ');
  src = src.replace(/\bexport\s+(const|let|var)\s+/g, '$1 ');

  // 6. Handle export { x as y } and export { x } from "y" patterns
  //    These appear in minified bundles as export{x as y} or export{x}from"y"
  src = src.replace(/\bexport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, exports, q, mod) => {
      const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s);
      return items.map((item: string) => {
        const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asMatch) return `module.exports.${asMatch[2]} = require(${q}${mod}${q}).${asMatch[1]};`;
        return `module.exports.${item} = require(${q}${mod}${q}).${item};`;
      }).join(' ');
    });

  // export * as name from "module"
  src = src.replace(/\bexport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, q, mod) => `module.exports.${name} = require(${q}${mod}${q});`);

  // export * from "module"
  src = src.replace(/\bexport\s*\*\s*from\s*(['"])([^'"]+)\1\s*;?/g,
    (_, q, mod) => `Object.assign(module.exports, require(${q}${mod}${q}));`);

  // export { x as y } (local re-exports, no from)
  src = src.replace(/\bexport\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
    const items = exports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^[\w$]/.test(s));
    return items.map((item: string) => {
      const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
      return `module.exports.${item} = ${item};`;
    }).join(' ');
  });

  // 7. Remove TypeScript type-only imports/exports
  src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');
  src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');

  // 8. Patch lazy module factory to handle initialization failures gracefully.
  //    The bundled code uses X=(A,q)=>()=>(q||A((q={exports:{}}).exports,q),q.exports)
  //    as a lazy CJS module factory (where X is a minified name like R, y, etc.).
  //    If factory A throws (missing Node.js API), subsequent code accessing exports gets {}.
  //    We wrap in try-catch and auto-stub missing properties so that
  //    `class X extends FailedModule.SomeClass` doesn't crash.
  //    Uses regex to match any variable name, not just a hardcoded one.
  const rPattern = /([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\3\|\|\2\(\(\3=\{exports:\{\}\}\)\.exports,\3\),\3\.exports\)/;
  const rMatch = src.match(rPattern);
  if (rMatch) {
    const [rOld, rName, rArg1, rArg2] = rMatch;
    const rNew = `${rName}=(${rArg1},${rArg2})=>()=>{if(!${rArg2}){${rArg2}={exports:{}};try{${rArg1}(${rArg2}.exports,${rArg2})}catch(e){if(e&&e._isProcessExit)throw e;${rArg2}.exports=__stubProxy(${rArg2}.exports)}}return ${rArg2}.exports}`;
    src = src.replace(rOld, rNew);
    // Inject __stubProxy helper and Node.js-compatible setTimeout/setInterval at the very start
    src = [
      'function __stubProxy(o){return new Proxy(o,{get(t,p,r){if(typeof p==="symbol"||p in t)return Reflect.get(t,p,r);var _s=function(){};_s.prototype={};_s.default=_s;t[p]=_s;return _s}})}',
      // Hide browser globals from SDK browser detection (typeof window/navigator checks)
      // Must be void 0 so typeof navigator === "undefined" — SDK and CLI both guard with typeof before access
      'var navigator=void 0;',
      // Override setTimeout/setInterval to return Timer-like objects with .unref()/.ref()
      'var _origSetTimeout=setTimeout,_origSetInterval=setInterval,_origClearTimeout=clearTimeout,_origClearInterval=clearInterval;',
      'function _wrapTimer(id){return{_id:id,ref(){return this},unref(){return this},hasRef(){return true},refresh(){return this},[Symbol.toPrimitive](){return id}}}',
      'setTimeout=function(fn,ms,...args){return _wrapTimer(_origSetTimeout(fn,ms,...args))};',
      'setInterval=function(fn,ms,...args){return _wrapTimer(_origSetInterval(fn,ms,...args))};',
      'clearTimeout=function(t){_origClearTimeout(t&&t._id!==void 0?t._id:t)};',
      'clearInterval=function(t){_origClearInterval(t&&t._id!==void 0?t._id:t)};',
      // Suppress unhandled rejections from ProcessExitError and CLI's "unreachable" throws
      'if(typeof globalThis.addEventListener==="function"){var _rejHandler=function(e){if(e&&e.reason&&(e.reason._isProcessExit||e.reason==="unreachable"||e.reason.message==="unreachable"))e.preventDefault()};globalThis.addEventListener("unhandledrejection",_rejHandler)}',
    ].join('\n') + '\n' + src;
  }

  // Patch lazy side-effect runner: X=(A,q)=>()=>(A&&(q=A(A=0)),q)
  // where X is a minified name like v, E, etc.
  // If the side-effect factory throws, cache undefined rather than re-throwing on every access.
  const vPattern = /([\w$]+)=\((\w+),(\w+)\)=>\(\)=>\(\2&&\(\3=\2\(\2=0\)\),\3\)/;
  const vMatch = src.match(vPattern);
  if (vMatch) {
    const [vOld, vName, vArg1, vArg2] = vMatch;
    const vNew = `${vName}=(${vArg1},${vArg2})=>()=>{try{${vArg1}&&(${vArg2}=${vArg1}(${vArg1}=0))}catch(e){if(e&&e._isProcessExit)throw e;if(!${vArg2})${vArg2}=__stubProxy({})}return ${vArg2}}`;
    src = src.replace(vOld, vNew);
  }

  // 9. Detect trailing unawaited async function call (e.g., `cMz();`)
  // In real Node.js, the event loop keeps running. In our AsyncFunction, we need to await it.
  src = src.replace(/([\w$]+)\(\)\s*;?\s*$/, 'await $1();');

  return src;
}

export function transformESModules(src: string): string {
  // Fast path for large bundled files (>500KB)
  if (src.length > 500000) {
    return transformBundledESM(src);
  }

  src = stripShebang(src);
  // Normalize line endings to LF
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Preserve block comments to avoid transforming export/import keywords inside them
  // Note: We don't preserve line comments (//) as they can appear in strings (URLs)
  const comments: string[] = [];
  src = src.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    comments.push(match);
    return `___COMMENT_${comments.length - 1}___`;
  });

  // Dynamic import() → Promise.resolve(require()) - must be before other import transforms
  // Handles: await import("./path") or import("./path").then(...)
  src = src.replace(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g, 'Promise.resolve(require($1$2$1))');

  // import.meta → __import_meta (must be before import statement transforms)
  src = src.replace(/import\.meta/g, '__import_meta');

  // import Default, { named } from 'y' → combined default + named import
  src = src.replace(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, defaultName, namedImports, mod) => {
      const cleanImports = namedImports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
      return `const ${defaultName} = require("${mod}"); const {${fixed}} = require("${mod}");`;
    });

  // import x from 'y' → const x = require('y')
  src = src.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");');

  // import { a, b } from 'y' → const { a, b } = require('y')
  // Also handles: import { a as b } → const { a: b }
  src = src.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, imports, mod) => {
      // Strip comments and fix 'as' syntax
      const cleanImports = imports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const fixed = cleanImports.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
      return `const {${fixed}} = require("${mod}");`;
    });

  // import * as x from 'y' → const x = require('y')
  src = src.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'const $1 = require("$2");');

  // import 'y' → require('y')
  src = src.replace(/import\s+['"]([^'"]+)['"]\s*;?/g,
    'require("$1");');

  // export default x → module.exports = x
  src = src.replace(/export\s+default\s+/g, 'module.exports = ');

  // export { x, y } from 'z' or export { x as y } from 'z' (handles multiline and comments)
  // Note: \s* allows no space between export and { (e.g., export{x})
  src = src.replace(/export\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, exports, mod) => {
      // Strip comments from exports
      const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
      const assigns = items.map((item: string) => {
        const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          return `module.exports.${asMatch[2]} = require("${mod}").${asMatch[1]};`;
        }
        return `module.exports.${item} = require("${mod}").${item};`;
      }).join(' ');
      return assigns;
    });

  // export * as name from 'z' → module.exports.name = require('z')
  src = src.replace(/export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'module.exports.$1 = require("$2");');

  // export * from 'z' → Object.assign(module.exports, require('z'))
  src = src.replace(/export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    'Object.assign(module.exports, require("$1"));');

  // export { x, y } or export { x as y } → module.exports.x = x; module.exports.y = y;
  // Note: \s* allows no space between export and { (e.g., export{x as y})
  src = src.replace(/export\s*\{([^}]+)\}\s*;?/g, (_, exports) => {
    // Strip comments and parse exports like "x, y as z, foo"
    const cleanExports = exports.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const items = cleanExports.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
    return items.map((item: string) => {
      const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        // export { local as exported }
        return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
      }
      // export { x }
      return `module.exports.${item} = ${item};`;
    }).join(' ');
  });

  // Track named exports to add module.exports at the end
  const namedExports: string[] = [];

  // export const/let/var x = ... → const x = ...; (track x)
  src = src.replace(/export\s+(const|let|var)\s+(\w+)\s*=/g, (_, decl, name) => {
    namedExports.push(name);
    return `${decl} ${name} =`;
  });

  // export var/let x; (declaration without initialization) → var x; (track x)
  src = src.replace(/export\s+(var|let)\s+(\w+)\s*;/g, (_, decl, name) => {
    namedExports.push(name);
    return `${decl} ${name};`;
  });

  // export function name() → function name(); (track name)
  src = src.replace(/export\s+function\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `function ${name}`;
  });

  // export class Name → class Name; (track Name)
  src = src.replace(/export\s+class\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `class ${name}`;
  });

  // export async function name() → async function name(); (track name)
  src = src.replace(/export\s+async\s+function\s+(\w+)/g, (_, name) => {
    namedExports.push(name);
    return `async function ${name}`;
  });

  // Add module.exports for all tracked named exports at the end
  if (namedExports.length > 0) {
    src += '\n' + namedExports.map(n => `module.exports.${n} = ${n};`).join('\n');
  }

  // Remove __filename/__dirname/Buffer declarations (we provide these as parameters)
  // Handles: const __filename = fileURLToPath(import.meta.url);
  //          const __dirname = dirname(__filename);
  //          const Buffer = require('buffer').Buffer;
  src = src.replace(/(?:const|let|var)\s+__filename\s*=\s*[^;]+;?/g, '/* __filename provided */');
  src = src.replace(/(?:const|let|var)\s+__dirname\s*=\s*[^;]+;?/g, '/* __dirname provided */');
  // Handle: const Buffer = require('buffer').Buffer; or var Buffer = ...
  // Use [^;,]+ to stop at comma (multi-line declarations) or semicolon
  src = src.replace(/(?:const|let|var)\s+Buffer\s*=\s*[^;,]+;/g, '/* Buffer provided */');
  // Handle multi-line: var Buffer = ...,\n    OtherVar = ...; -> var OtherVar = ...;
  src = src.replace(/(const|let|var)\s+Buffer\s*=\s*[^,]+,\s*/g, '$1 ');
  // Handle: const { Buffer } = require('buffer'); (destructuring)
  src = src.replace(/(?:const|let|var)\s*\{\s*Buffer\s*\}\s*=\s*[^;]+;/g, '/* Buffer provided */');
  // Handle: const { Buffer, ... } = require('buffer'); (Buffer in destructuring with others)
  src = src.replace(/(\{\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');
  src = src.replace(/(,\s*)Buffer(\s*\})/g, '$1/* Buffer */$2');
  src = src.replace(/(,\s*)Buffer(\s*,)/g, '$1/* Buffer */$2');

  // Catch-all: remove any remaining export keywords that weren't handled
  // This handles edge cases like TypeScript 'export type' that might slip through
  src = src.replace(/\bexport\s+type\s+/g, '/* export type */ ');
  src = src.replace(/\bimport\s+type\s+[^;]+;?/g, '/* import type */');

  // Final safety: if any export/import statements remain, handle them aggressively
  // This prevents "Unexpected token 'export'" errors

  // Catch any remaining export { name } patterns (including no-space like export{x})
  while (/\bexport\s*\{/.test(src)) {
    src = src.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_, names) => {
      const cleanNames = names.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const items = cleanNames.split(',').map((s: string) => s.trim()).filter((s: string) => s && /^\w/.test(s));
      return items.map((item: string) => {
        const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) return `module.exports.${asMatch[2]} = ${asMatch[1]};`;
        return `module.exports.${item} = ${item};`;
      }).join(' ');
    });
  }

  // Note: We removed aggressive catch-all transforms for import/export
  // as they were corrupting URLs in strings (//example.com) and other code.
  // If ES module syntax slips through, we'll get a clear "Unexpected token" error.

  // Restore preserved comments
  src = src.replace(/___COMMENT_(\d+)___/g, (_, idx) => comments[parseInt(idx)]);

  // Note: trailing await transform is in transformBundledESM, not here

  return src;
}
