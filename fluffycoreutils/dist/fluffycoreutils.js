function parseArgs(n, e = []) {
  const t = {}, s = {}, o = [], r = new Set(e);
  for (let i = 0; i < n.length; i++) {
    const a = n[i];
    if (a === "--") {
      o.push(...n.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const c = a.slice(2);
      r.has(c) && i + 1 < n.length ? s[c] = n[++i] : t[c] = !0;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const c = a.slice(1);
      if (r.has(c) && i + 1 < n.length)
        s[c] = n[++i];
      else
        for (let l = 0; l < c.length; l++) {
          const d = c[l];
          if (r.has(d)) {
            const u = c.slice(l + 1);
            u ? s[d] = u : i + 1 < n.length && (s[d] = n[++i]);
            break;
          }
          t[d] = !0;
        }
    } else
      o.push(a);
  }
  return { flags: t, values: s, positional: o };
}
async function readInput(n, e, t, s, o) {
  if (n.length === 0)
    return { content: e, files: [] };
  const r = [], i = [];
  for (const a of n) {
    const c = o(a, s);
    r.push(c), i.push(await t.readFile(c));
  }
  return { content: i.join(""), files: r };
}
const alias = {
  name: "alias",
  description: "Define or display aliases",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    if (t.length === 0)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    const o = [];
    for (const r of t)
      s.p && o.push(`alias ${r}`);
    return {
      stdout: o.join(`
`) + (o.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, arrayHelper = {
  name: "array",
  description: "Helper for array variable operations (shell feature)",
  async exec(n, e) {
    return n.length > 0 && n[0] === "--help" ? {
      stdout: `array: This is a shell language feature, not a command.

Array syntax must be implemented at the shell variable level:

Declaration:
  arr=(value1 value2 value3)
  arr=()  # empty array
  arr[0]=value1
  arr[5]=value5  # sparse array

Access:
  \${arr[0]}      # First element (0-indexed)
  \${arr[1]}      # Second element
  \${arr[-1]}     # Last element (bash 4.3+)
  \${arr[@]}      # All elements as separate words
  \${arr[*]}      # All elements as single word
  \${#arr[@]}     # Array length
  \${!arr[@]}     # Array indices

Operations:
  arr+=(value4 value5)           # Append elements
  unset arr[2]                   # Remove element
  \${arr[@]:start}               # Slice from start
  \${arr[@]:start:length}        # Slice with length
  \${arr[@]/pattern/replacement} # Replace in all elements

Iteration:
  for item in "\${arr[@]}"; do
    echo "$item"
  done

  for i in "\${!arr[@]}"; do
    echo "arr[$i] = \${arr[$i]}"
  done

Implementation guidance for shells:
1. Store arrays as objects/maps with numeric keys
2. Implement expansion patterns for \${arr[...]} syntax
3. Handle @ vs * difference (word splitting)
4. Support sparse arrays (missing indices)
5. Implement array-specific operations (length, slice, etc.)

Example shell pseudo-code:
  arrays = {}  // Map of variable name to array

  // Assignment: arr=(a b c)
  arrays['arr'] = ['a', 'b', 'c']

  // Access: \${arr[1]}
  value = arrays['arr'][1]  // 'b'

  // All elements: \${arr[@]}
  values = arrays['arr'].join(' ')  // 'a b c'

  // Length: \${#arr[@]}
  length = arrays['arr'].length  // 3

Shell implementers: Parse array syntax at the variable expansion level.

`,
      stderr: "",
      exitCode: 0
    } : {
      stdout: "",
      stderr: `array: This is a shell feature. Use --help for implementation guidance.
`,
      exitCode: 1
    };
  }
}, awk = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, e) {
    const { values: t, positional: s } = parseArgs(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const o = s[0], r = s.slice(1), i = {
      FS: t.F || " ",
      // Field separator
      OFS: " ",
      // Output field separator
      RS: `
`,
      // Record separator
      ORS: `
`,
      // Output record separator
      NR: 0,
      // Number of records
      NF: 0,
      // Number of fields
      FILENAME: r[0] || "-",
      variables: {}
    };
    if (t.v) {
      const a = t.v.split("=");
      a.length === 2 && (i.variables[a[0]] = a[1]);
    }
    try {
      const { content: a } = await readInput(
        r,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = a.split(`
`).filter((p) => p !== "" || a.endsWith(`
`)), l = [], d = o.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), u = o.match(/END\s*\{\s*([^}]*)\s*\}/), f = o.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      if (d) {
        const p = executeAction(d[1], [], i);
        p && l.push(p);
      }
      for (const p of c) {
        i.NR++;
        const h = typeof i.FS == "string" && i.FS !== " " ? new RegExp(i.FS) : /\s+/, m = p.split(h).filter((x) => x !== "");
        i.NF = m.length;
        let g = !0;
        if (f) {
          const x = f[1], y = f[2];
          if (x)
            try {
              g = new RegExp(x).test(p);
            } catch {
              g = !1;
            }
          if (g) {
            const C = executeAction(y, m, i);
            C !== null && l.push(C);
          }
        } else if (!d && !u) {
          const x = executeAction(o, m, i);
          x !== null && l.push(x);
        }
      }
      if (u) {
        const p = executeAction(u[1], [], i);
        p && l.push(p);
      }
      return {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `awk: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
function executeAction(n, e, t) {
  let s = n.trim();
  if (s = processStringFunctions(s, e, t), s.startsWith("printf")) {
    const o = s.match(/printf\s+(.+)/);
    if (o)
      return formatPrintf(o[1], e, t);
  }
  if (s.startsWith("print")) {
    const o = s.substring(5).trim();
    if (!o || o === "")
      return e.join(t.OFS);
    if (o.includes(","))
      return o.split(/\s*,\s*/).map((c) => {
        let l = substituteVariables(c.trim(), e, t);
        return l = evaluateArithmetic$1(l), l.replace(/^["'](.*)["']$/, "$1");
      }).join(t.OFS);
    let r = o;
    return r = substituteVariables(r, e, t), r = evaluateArithmetic$1(r), r = r.replace(/^["'](.*)["']$/, "$1"), r = r.replace(/\s+/g, " ").trim(), r;
  }
  return null;
}
function substituteVariables(n, e, t) {
  let s = n;
  s = s.replace(/\$0/g, e.join(t.OFS)), s = s.replace(/\$NF/g, e[e.length - 1] || "");
  for (let o = 1; o <= e.length; o++)
    s = s.replace(new RegExp(`\\$${o}\\b`, "g"), e[o - 1] || "");
  s = s.replace(/\bNR\b/g, String(t.NR)), s = s.replace(/\bNF\b/g, String(t.NF)), s = s.replace(/\bFS\b/g, t.FS), s = s.replace(/\bOFS\b/g, t.OFS), s = s.replace(/\bRS\b/g, t.RS), s = s.replace(/\bORS\b/g, t.ORS), s = s.replace(/\bFILENAME\b/g, t.FILENAME);
  for (const [o, r] of Object.entries(t.variables))
    s = s.replace(new RegExp(`\\b${o}\\b`, "g"), r);
  return s;
}
function evaluateArithmetic$1(n) {
  const e = /^([\d.]+)\s*([\+\-\*\/])\s*([\d.]+)$/, t = n.match(e);
  if (t) {
    const s = parseFloat(t[1]), o = t[2], r = parseFloat(t[3]);
    let i;
    switch (o) {
      case "+":
        i = s + r;
        break;
      case "-":
        i = s - r;
        break;
      case "*":
        i = s * r;
        break;
      case "/":
        i = s / r;
        break;
      default:
        return n;
    }
    return String(i);
  }
  return n;
}
function formatPrintf(n, e, t) {
  const s = n.split(/,\s*/);
  if (s.length === 0) return "";
  let o = s[0].trim().replace(/^["'](.*)["']$/, "$1");
  const r = [];
  for (let c = 1; c < s.length; c++) {
    const l = substituteVariables(s[c].trim(), e, t);
    r.push(l);
  }
  let i = o, a = 0;
  return i = i.replace(/%(-)?(\d+)?(?:\.(\d+))?([sdifgex%])/g, (c, l, d, u, f) => {
    if (f === "%") return "%";
    if (a >= r.length) return c;
    const p = r[a++];
    let h;
    switch (f) {
      case "s":
        h = p;
        break;
      case "d":
      // decimal integer
      case "i":
        h = String(parseInt(p) || 0);
        break;
      case "f":
        const m = parseFloat(p) || 0;
        h = u ? m.toFixed(parseInt(u)) : String(m);
        break;
      case "g":
      // general format
      case "e":
      // exponential
      case "x":
        h = p;
        break;
      default:
        h = p;
    }
    if (d) {
      const m = parseInt(d);
      l ? h = h.padEnd(m, " ") : h = h.padStart(m, " ");
    }
    return h;
  }), i = i.replace(/\\n/g, `
`), i = i.replace(/\\t/g, "	"), i = i.replace(/\\r/g, "\r"), i = i.replace(/\\\\/g, "\\"), i.endsWith(`
`) && (i = i.slice(0, -1)), i;
}
function processStringFunctions(n, e, t) {
  let s = n;
  return s = s.replace(/length\s*\(\s*([^)]*)\s*\)/g, (o, r) => {
    const i = r ? substituteVariables(r, e, t) : e.join(t.OFS);
    return String(i.length);
  }), s = s.replace(/substr\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (o, r, i, a) => {
    const c = substituteVariables(r.trim(), e, t), l = parseInt(substituteVariables(i.trim(), e, t)) - 1, d = a ? parseInt(substituteVariables(a.trim(), e, t)) : void 0;
    return d ? c.slice(l, l + d) : c.slice(l);
  }), s = s.replace(/index\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (o, r, i) => {
    const a = substituteVariables(r.trim(), e, t), c = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = a.indexOf(c);
    return String(l === -1 ? 0 : l + 1);
  }), s = s.replace(/tolower\s*\(\s*([^)]*)\s*\)/g, (o, r) => substituteVariables(r, e, t).toLowerCase()), s = s.replace(/toupper\s*\(\s*([^)]*)\s*\)/g, (o, r) => substituteVariables(r, e, t).toUpperCase()), s = s.replace(/split\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (o, r, i, a) => {
    const c = substituteVariables(r.trim(), e, t), l = a ? substituteVariables(a.trim(), e, t).replace(/^["'](.*)["']$/, "$1") : t.FS, d = c.split(new RegExp(l));
    return String(d.length);
  }), s = s.replace(/gsub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (o, r, i, a) => {
    const c = substituteVariables(r.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), d = a ? substituteVariables(a.trim(), e, t) : e[0] || "";
    try {
      const u = new RegExp(c, "g");
      return d.replace(u, l);
    } catch {
      return d;
    }
  }), s = s.replace(/sub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (o, r, i, a) => {
    const c = substituteVariables(r.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), d = a ? substituteVariables(a.trim(), e, t) : e[0] || "";
    try {
      const u = new RegExp(c);
      return d.replace(u, l);
    } catch {
      return d;
    }
  }), s = s.replace(/match\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (o, r, i) => {
    const a = substituteVariables(r.trim(), e, t), c = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1");
    try {
      const l = new RegExp(c), d = a.match(l);
      return d ? String(d.index + 1) : "0";
    } catch {
      return "0";
    }
  }), s;
}
const base64 = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.d || t.decode, r = t.w ? parseInt(t.w) : 76, i = t.i || t["ignore-garbage"];
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let c;
      if (o) {
        const l = i ? a.replace(/[^A-Za-z0-9+/=]/g, "") : a.replace(/\s/g, "");
        try {
          c = globalThis.atob(l);
        } catch {
          return {
            stdout: "",
            stderr: `base64: invalid input
`,
            exitCode: 1
          };
        }
      } else {
        const l = globalThis.btoa(a);
        if (r > 0) {
          const d = [];
          for (let u = 0; u < l.length; u += r)
            d.push(l.substring(u, u + r));
          c = d.join(`
`);
        } else
          c = l;
      }
      return {
        stdout: c + (c ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `base64: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, basename = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let e = n[0].replace(/\/+$/, "").split("/").pop() || "/";
    return n.length > 1 && e.endsWith(n[1]) && (e = e.slice(0, -n[1].length)), { stdout: e + `
`, stderr: "", exitCode: 0 };
  }
}, bc = {
  name: "bc",
  description: "Arbitrary precision calculator language",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, ["l", "q", "s", "w"]), r = t.l;
    t.q;
    const i = o.s ? parseInt(o.s) : 0;
    t.w;
    let a;
    if (s.length > 0)
      try {
        const f = e.fs.resolvePath(s[0], e.cwd);
        a = await e.fs.readFile(f);
      } catch (f) {
        return {
          stdout: "",
          stderr: `bc: ${s[0]}: ${f instanceof Error ? f.message : String(f)}
`,
          exitCode: 1
        };
      }
    else
      a = e.stdin;
    if (!a.trim())
      return { stdout: "", stderr: "", exitCode: 0 };
    const c = a.split(`
`).map((f) => f.trim()).filter(Boolean), l = [], d = /* @__PURE__ */ new Map();
    let u = i;
    r && (u = 20);
    for (const f of c) {
      if (f.startsWith("#") || f.startsWith("/*")) continue;
      if (f === "quit" || f === "q") break;
      if (f.startsWith("scale=")) {
        u = parseInt(f.substring(6)) || 0;
        continue;
      }
      if (f === "scale") {
        l.push(String(u));
        continue;
      }
      const p = f.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/i);
      if (p) {
        const h = p[1], m = p[2];
        try {
          const g = evaluateExpression$1(m, d, u, r);
          d.set(h, g);
          continue;
        } catch (g) {
          return {
            stdout: "",
            stderr: `bc: ${g instanceof Error ? g.message : String(g)}
`,
            exitCode: 1
          };
        }
      }
      try {
        const h = evaluateExpression$1(f, d, u, r), m = formatNumber$1(h, u);
        l.push(m);
      } catch (h) {
        return {
          stdout: "",
          stderr: `bc: ${h instanceof Error ? h.message : String(h)}
`,
          exitCode: 1
        };
      }
    }
    return {
      stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function evaluateExpression$1(expr, variables, scale, mathLib) {
  let normalized = expr.trim();
  for (const [n, e] of variables)
    normalized = normalized.replace(new RegExp(`\\b${n}\\b`, "g"), String(e));
  mathLib && (normalized = handleMathFunctions(normalized)), normalized = normalized.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, (n, e, t) => String(Math.pow(parseFloat(e), parseFloat(t)))), normalized = normalized.replace(/sqrt\s*\(\s*([^)]+)\s*\)/g, (n, e) => {
    const t = parseFloat(e);
    return String(Math.sqrt(t));
  });
  try {
    const result = eval(normalized);
    if (typeof result != "number" || !isFinite(result))
      throw new Error("invalid expression");
    return result;
  } catch (n) {
    throw new Error(`parse error: ${expr}`);
  }
}
function handleMathFunctions(n) {
  let e = n;
  return e = e.replace(/s\s*\(\s*([^)]+)\s*\)/g, (t, s) => String(Math.sin(parseFloat(s)))), e = e.replace(/c\s*\(\s*([^)]+)\s*\)/g, (t, s) => String(Math.cos(parseFloat(s)))), e = e.replace(/a\s*\(\s*([^)]+)\s*\)/g, (t, s) => String(Math.atan(parseFloat(s)))), e = e.replace(/l\s*\(\s*([^)]+)\s*\)/g, (t, s) => String(Math.log(parseFloat(s)))), e = e.replace(/e\s*\(\s*([^)]+)\s*\)/g, (t, s) => String(Math.exp(parseFloat(s)))), e;
}
function formatNumber$1(n, e) {
  return e === 0 ? String(Math.floor(n)) : n.toFixed(e).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
const breakCmd = {
  name: "break",
  description: "Exit from a for, while, or until loop",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? parseInt(t[0]) : 1;
    return isNaN(s) || s < 1 ? {
      stdout: "",
      stderr: `break: numeric argument required
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, caseCmd = {
  name: "case",
  description: "Pattern matching (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `case: this is a shell language construct that must be interpreted by the shell
Usage: case WORD in PATTERN) COMMANDS ;; esac
`,
      exitCode: 2
    };
  }
}, esac = {
  name: "esac",
  description: "End case statement (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `esac: can only be used to close a case statement
`,
      exitCode: 2
    };
  }
}, cat = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    try {
      const { content: o } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return t.n ? { stdout: o.split(`
`).map((a, c) => `${String(c + 1).padStart(6)}	${a}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: o, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `cat: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, gcc = {
  name: "gcc",
  description: "GNU C Compiler (stub)",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, [
      "c",
      "S",
      "E",
      "o",
      "I",
      "L",
      "l",
      "D",
      "Wall",
      "Werror",
      "O0",
      "O1",
      "O2",
      "O3",
      "Os",
      "g",
      "shared",
      "static",
      "fPIC",
      "fpic",
      "std",
      "pedantic",
      "ansi",
      "v",
      "version",
      "M",
      "MM",
      "MD",
      "MMD",
      "MF",
      "MT",
      "MQ"
    ]);
    if (t.version || t.v)
      return {
        stdout: `gcc (GCC) 9.3.0 (stub)
Copyright (C) 2019 Free Software Foundation, Inc.
This is a stub implementation for browser-based environments.
To enable real C compilation, integrate WASM-based tcc or Emscripten.

`,
        stderr: "",
        exitCode: 0
      };
    if (o.length === 0)
      return {
        stdout: "",
        stderr: `gcc: fatal error: no input files
compilation terminated.
`,
        exitCode: 1
      };
    const r = o, i = s.o || "a.out";
    for (const f of r) {
      const p = e.fs.resolvePath(f, e.cwd);
      if (!await e.fs.exists(p))
        return {
          stdout: "",
          stderr: `gcc: error: ${f}: No such file or directory
gcc: fatal error: no input files
compilation terminated.
`,
          exitCode: 1
        };
    }
    let a = !1, c = "";
    for (const f of r)
      if (f.endsWith(".c") || f.endsWith(".cc") || f.endsWith(".cpp"))
        try {
          const p = e.fs.resolvePath(f, e.cwd), h = await e.fs.readFile(p);
          c += h + `
`, (/int\s+main\s*\(/.test(h) || /void\s+main\s*\(/.test(h)) && (a = !0);
        } catch (p) {
          return {
            stdout: "",
            stderr: `gcc: error: ${f}: ${p.message}
`,
            exitCode: 1
          };
        }
    if (t.E)
      return {
        stdout: c.split(`
`).filter((p) => !p.trim().startsWith("#")).join(`
`),
        stderr: "",
        exitCode: 0
      };
    if (t.c) {
      for (const f of r)
        if (f.endsWith(".c") || f.endsWith(".cc") || f.endsWith(".cpp")) {
          const p = f.replace(/\.(c|cc|cpp)$/, ".o"), h = e.fs.resolvePath(p, e.cwd);
          await e.fs.writeFile(h, `# Object file stub for ${f}
`);
        }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    if (t.S) {
      for (const f of r)
        if (f.endsWith(".c") || f.endsWith(".cc") || f.endsWith(".cpp")) {
          const p = f.replace(/\.(c|cc|cpp)$/, ".s"), h = e.fs.resolvePath(p, e.cwd);
          await e.fs.writeFile(h, `# Assembly stub for ${f}
.text
.globl main
main:
  ret
`);
        }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    if (!a && !t.shared && !t.c)
      return {
        stdout: "",
        stderr: `gcc: error: undefined reference to 'main'
collect2: error: ld returned 1 exit status
`,
        exitCode: 1
      };
    const l = e.fs.resolvePath(i, e.cwd), d = /printf\s*\(\s*["'].*[Hh]ello.*["']/.test(c) || /puts\s*\(\s*["'].*[Hh]ello.*["']/.test(c);
    let u = `#!/bin/sh
`;
    return d ? u += `echo 'Hello, World!'
` : u += `# Compiled binary stub
`, await e.fs.writeFile(l, u), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, cc = {
  name: "cc",
  description: "C Compiler (alias for gcc)",
  async exec(n, e) {
    return gcc.exec(n, e);
  }
}, chmod = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const r = s[0], i = s.slice(1), a = parseInt(r, 8);
    if (isNaN(a))
      return { stdout: "", stderr: `chmod: invalid mode: '${r}'
`, exitCode: 1 };
    async function c(l) {
      const d = e.fs.resolvePath(l, e.cwd);
      if (o)
        try {
          if ((await e.fs.stat(d)).type === "dir") {
            const f = await e.fs.readdir(d);
            for (const p of f)
              await c(d + "/" + p.name);
          }
        } catch {
        }
    }
    try {
      for (const l of i)
        await c(l);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `chmod: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
}, chown = {
  name: "chown",
  description: "Change file owner and group",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    if (s.length < 2)
      return { stdout: "", stderr: `chown: missing operand
`, exitCode: 1 };
    const o = s[0], r = s.slice(1);
    t.R;
    const i = t.v, a = o.split(":");
    a[0], a[1];
    const c = [];
    try {
      for (const l of r)
        i && c.push(`ownership of '${l}' retained as ${o}`);
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (l) {
      return {
        stdout: "",
        stderr: `chown: ${l instanceof Error ? l.message : l}
`,
        exitCode: 1
      };
    }
  }
}, clear = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, column = {
  name: "column",
  description: "Format input into columns",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["t", "s", "c", "x", "n"]);
    try {
      const { content: r } = await readInput(
        o,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), i = r.split(`
`);
      if (i.length > 0 && i[i.length - 1] === "" && i.pop(), t.t) {
        const f = s.s || "	", p = new RegExp(f), h = i.map((y) => y.split(p)), m = Math.max(...h.map((y) => y.length)), g = new Array(m).fill(0);
        for (const y of h)
          for (let C = 0; C < y.length; C++)
            g[C] = Math.max(g[C] || 0, y[C].length);
        const x = h.map((y) => y.map((C, S) => {
          const w = g[S];
          return C.padEnd(w);
        }).join("  ")).join(`
`);
        return {
          stdout: x ? x + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      const a = s.c ? parseInt(s.c) : 80, c = i.flatMap((f) => f.split(/\s+/).filter((p) => p));
      if (c.length === 0)
        return { stdout: "", stderr: "", exitCode: 0 };
      const d = Math.max(...c.map((f) => f.length)) + 2, u = Math.max(1, Math.floor(a / d));
      if (t.x) {
        const f = Math.ceil(c.length / u), p = Array(f).fill(null).map(() => []);
        for (let m = 0; m < c.length; m++) {
          const g = m % f;
          p[g].push(c[m]);
        }
        const h = p.map((m) => m.map((g) => g.padEnd(d)).join("").trimEnd()).join(`
`);
        return {
          stdout: h ? h + `
` : "",
          stderr: "",
          exitCode: 0
        };
      } else {
        const f = [];
        for (let p = 0; p < c.length; p += u) {
          const h = c.slice(p, p + u);
          f.push(h.map((m) => m.padEnd(d)).join("").trimEnd());
        }
        return {
          stdout: f.join(`
`) + `
`,
          stderr: "",
          exitCode: 0
        };
      }
    } catch (r) {
      return {
        stdout: "",
        stderr: `column: ${r.message}
`,
        exitCode: 1
      };
    }
  }
}, comm = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `comm: missing operand
`,
        exitCode: 1
      };
    const o = t[1], r = t[2], i = t[3];
    try {
      const a = e.fs.resolvePath(s[0], e.cwd), c = e.fs.resolvePath(s[1], e.cwd), l = await e.fs.readFile(a), d = await e.fs.readFile(c), u = l.split(`
`).filter((g) => g !== "" || l.endsWith(`
`)), f = d.split(`
`).filter((g) => g !== "" || d.endsWith(`
`));
      u.length > 0 && u[u.length - 1] === "" && u.pop(), f.length > 0 && f[f.length - 1] === "" && f.pop();
      const p = [];
      let h = 0, m = 0;
      for (; h < u.length || m < f.length; ) {
        const g = h < u.length ? u[h] : null, x = m < f.length ? f[m] : null;
        if (g === null) {
          if (!r) {
            const y = o ? "" : "	";
            p.push(y + x);
          }
          m++;
        } else if (x === null)
          o || p.push(g), h++;
        else if (g < x)
          o || p.push(g), h++;
        else if (g > x) {
          if (!r) {
            const y = o ? "" : "	";
            p.push(y + x);
          }
          m++;
        } else {
          if (!i) {
            let y = "";
            o || (y += "	"), r || (y += "	"), p.push(y + g);
          }
          h++, m++;
        }
      }
      return {
        stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `comm: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, continueCmd = {
  name: "continue",
  description: "Continue to next iteration of a for, while, or until loop",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? parseInt(t[0]) : 1;
    return isNaN(s) || s < 1 ? {
      stdout: "",
      stderr: `continue: numeric argument required
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, cp = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.r || t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const r = e.fs.resolvePath(s[s.length - 1], e.cwd), i = s.slice(0, -1);
    let a = !1;
    try {
      a = (await e.fs.stat(r)).type === "dir";
    } catch {
    }
    if (i.length > 1 && !a)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(d, u) {
      const f = await e.fs.readFile(d);
      await e.fs.writeFile(u, f);
    }
    async function l(d, u) {
      await e.fs.mkdir(u, { recursive: !0 });
      const f = await e.fs.readdir(d);
      for (const p of f) {
        const h = d + "/" + p.name, m = u + "/" + p.name;
        p.type === "dir" ? await l(h, m) : await c(h, m);
      }
    }
    try {
      for (const d of i) {
        const u = e.fs.resolvePath(d, e.cwd), f = await e.fs.stat(u), p = d.split("/").pop(), h = a ? r + "/" + p : r;
        if (f.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${d}'
`, exitCode: 1 };
          await l(u, h);
        } else
          await c(u, h);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (d) {
      return { stdout: "", stderr: `cp: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
}, curl = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (o.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const r = o[0], i = s.X || s.request || (s.d || s.data ? "POST" : "GET"), a = s.o || s.output, c = t.s || t.silent, l = t.i || t.include, d = t.I || t.head, u = t.L || t.location, f = {}, p = s.H || s.header;
    if (p) {
      const g = p.split(":");
      g.length >= 2 && (f[g[0].trim()] = g.slice(1).join(":").trim());
    }
    const h = s["user-agent"] || "fluffycoreutils-curl/0.1.0";
    f["User-Agent"] = h;
    let m;
    (s.d || s.data) && (m = s.d || s.data, f["Content-Type"] || (f["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const g = {
        method: d ? "HEAD" : i,
        headers: f,
        redirect: u ? "follow" : "manual"
      };
      m && i !== "GET" && i !== "HEAD" && (g.body = m);
      const x = await fetch(r, g);
      let y = "";
      if ((l || d) && (y += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((C, S) => {
        y += `${S}: ${C}
`;
      }), y += `
`), !d) {
        const C = await x.text();
        y += C;
      }
      if (a) {
        const C = e.fs.resolvePath(a, e.cwd);
        return await e.fs.writeFile(C, d ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${y.length}  100  ${y.length}    0     0   ${y.length}      0 --:--:-- --:--:-- --:--:--  ${y.length}
`,
          exitCode: 0
        };
      }
      return !c && !x.ok ? {
        stdout: y,
        stderr: `curl: (22) The requested URL returned error: ${x.status}
`,
        exitCode: 22
      } : { stdout: y, stderr: "", exitCode: 0 };
    } catch (g) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${g instanceof Error ? g.message : String(g)}
`,
        exitCode: 6
      };
    }
  }
}, cut = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, e) {
    const { values: t, positional: s } = parseArgs(n, ["d", "f", "c"]), o = t.d ?? "	", r = t.f, i = t.c;
    if (!r && !i)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = parseRanges(r ?? i), l = a.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const d = [];
      for (const u of l)
        if (r) {
          const f = u.split(o), p = c.flatMap((h) => f.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          d.push(p.join(o));
        } else {
          const f = u.split(""), p = c.flatMap((h) => f.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          d.push(p.join(""));
        }
      return { stdout: d.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `cut: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
};
function parseRanges(n) {
  return n.split(",").map((e) => {
    if (e.includes("-")) {
      const [s, o] = e.split("-");
      return {
        start: s ? parseInt(s, 10) : 1,
        end: o ? parseInt(o, 10) : 1 / 0
      };
    }
    const t = parseInt(e, 10);
    return { start: t, end: t };
  });
}
const date = {
  name: "date",
  description: "Display date and time",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, ["d", "date", "r", "reference", "u"]);
    let r;
    if (o.d || o.date) {
      const c = o.d || o.date;
      if (r = new Date(c), isNaN(r.getTime()))
        return {
          stdout: "",
          stderr: `date: invalid date '${c}'
`,
          exitCode: 1
        };
    } else {
      if (o.r || o.reference)
        return {
          stdout: "",
          stderr: `date: -r/--reference not supported in browser environment
`,
          exitCode: 1
        };
      r = /* @__PURE__ */ new Date();
    }
    const i = t.u || t.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const c = s[0].slice(1);
      return { stdout: formatDate$1(r, c, i) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (i ? r.toUTCString() : r.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function formatDate$1(n, e, t = !1) {
  const s = (y) => String(y).padStart(2, "0"), o = (y) => String(y).padStart(3, "0"), r = (y) => t ? n[`getUTC${y}`]() : n[`get${y}`](), i = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], a = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], c = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], d = r("FullYear"), u = r("Month"), f = r("Date"), p = r("Hours"), h = r("Minutes"), m = r("Seconds"), g = r("Milliseconds"), x = r("Day");
  return e.replace(/%Y/g, String(d)).replace(/%y/g, String(d).slice(-2)).replace(/%m/g, s(u + 1)).replace(/%d/g, s(f)).replace(/%e/g, String(f).padStart(2, " ")).replace(/%H/g, s(p)).replace(/%I/g, s(p % 12 || 12)).replace(/%M/g, s(h)).replace(/%S/g, s(m)).replace(/%N/g, o(g) + "000000").replace(/%p/g, p >= 12 ? "PM" : "AM").replace(/%P/g, p >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, i[x]).replace(/%a/g, a[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, c[u]).replace(/%b/g, l[u]).replace(/%h/g, l[u]).replace(/%F/g, `${d}-${s(u + 1)}-${s(f)}`).replace(/%T/g, `${s(p)}:${s(h)}:${s(m)}`).replace(/%R/g, `${s(p)}:${s(h)}`).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const local = {
  name: "local",
  description: "Declare local variables in shell functions",
  async exec(n, e) {
    const { positional: t } = parseArgs(n, ["r", "a", "i", "x"]);
    return t.length === 0 ? {
      stdout: "",
      stderr: `local: usage: local [-r] [-a] [-i] [-x] [name[=value] ...]
`,
      exitCode: 1
    } : (t.map((s) => {
      const [o, r] = s.split("=", 2);
      return r !== void 0 ? `${o}=${r}` : o;
    }), {
      stdout: "",
      stderr: "",
      exitCode: 0
    });
  }
}, declare = {
  name: "declare",
  description: "Declare variables and give them attributes",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["r", "a", "A", "i", "x", "p", "f", "g"]);
    if (t.p)
      return s.length === 0 ? {
        stdout: `# Shell variables would be listed here
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: s.map((r) => {
          const i = e.env[r];
          return i !== void 0 ? `declare -- ${r}="${i}"
` : "";
        }).join(""),
        stderr: "",
        exitCode: 0
      };
    for (const o of s) {
      const [r, i] = o.split("=", 2);
      i !== void 0 && e.env && (e.env[r] = i);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, readonly = {
  name: "readonly",
  description: "Mark variables as readonly",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["p", "f"]);
    if (t.p)
      return {
        stdout: `# Readonly variables would be listed here
`,
        stderr: "",
        exitCode: 0
      };
    if (s.length === 0)
      return {
        stdout: "",
        stderr: `readonly: usage: readonly [-p] [name[=value] ...]
`,
        exitCode: 1
      };
    for (const o of s) {
      const [r, i] = o.split("=", 2);
      i !== void 0 && e.env && (e.env[r] = i);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, unset = {
  name: "unset",
  description: "Unset variables or functions",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["v", "f"]);
    if (s.length === 0)
      return {
        stdout: "",
        stderr: `unset: usage: unset [-v] [-f] [name ...]
`,
        exitCode: 1
      };
    if (!t.f && e.env)
      for (const o of s)
        delete e.env[o];
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, df = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.h, o = t.i, r = [];
    return o ? (r.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on"), r.push("virtual             0      0       0    0% /")) : s ? (r.push("Filesystem      Size  Used Avail Use% Mounted on"), r.push("virtual         100G   10G   90G  10% /")) : (r.push("Filesystem     1K-blocks    Used Available Use% Mounted on"), r.push("virtual        104857600 10485760  94371840  10% /")), {
      stdout: r.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, diff = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, e) {
    var f, p;
    const { flags: t, positional: s, values: o } = parseArgs(n, ["U", "context", "C"]), r = t.u || o.U !== void 0, i = o.U || o.context || o.C || (t.u ? 3 : 0), a = typeof i == "string" ? parseInt(i) : 3, c = t.q || t.brief, l = t.i, d = t.w || t["ignore-all-space"], u = t.y || t["side-by-side"];
    if (s.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const h = e.fs.resolvePath(s[0], e.cwd), m = e.fs.resolvePath(s[1], e.cwd), g = await e.fs.readFile(h), x = await e.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${s[0]} and ${s[1]} differ
`, stderr: "", exitCode: 1 };
      const y = g.split(`
`), C = x.split(`
`), S = computeDiff(y, C, { ignoreCase: l, ignoreWhitespace: d }), w = [];
      if (r) {
        w.push(`--- ${s[0]}`), w.push(`+++ ${s[1]}`);
        let v = 0;
        for (; v < S.length; ) {
          if (S[v].type === "equal") {
            v++;
            continue;
          }
          const b = Math.max(0, v - 1);
          let A = v;
          for (; A < S.length; ) {
            const P = S[A];
            if (P.type !== "equal")
              A++;
            else if (P.lines.length <= a * 2)
              A++;
            else
              break;
          }
          const I = (((f = S[b]) == null ? void 0 : f.line1) ?? 0) + 1, E = (((p = S[b]) == null ? void 0 : p.line2) ?? 0) + 1;
          let k = 0, M = 0;
          for (let P = b; P < A; P++)
            (S[P].type === "equal" || S[P].type === "delete") && (k += S[P].lines.length), (S[P].type === "equal" || S[P].type === "add") && (M += S[P].lines.length);
          w.push(`@@ -${I},${k} +${E},${M} @@`);
          for (let P = b; P < A; P++) {
            const F = S[P];
            F.type === "equal" ? F.lines.forEach((N) => w.push(` ${N}`)) : F.type === "delete" ? F.lines.forEach((N) => w.push(`-${N}`)) : F.type === "add" && F.lines.forEach((N) => w.push(`+${N}`));
          }
          v = A;
        }
      } else if (u)
        for (const $ of S)
          $.type === "equal" ? $.lines.forEach((b) => {
            const A = b.substring(0, 40).padEnd(40);
            w.push(`${A} | ${b}`);
          }) : $.type === "delete" ? $.lines.forEach((b) => {
            const A = b.substring(0, 40).padEnd(40);
            w.push(`${A} <`);
          }) : $.type === "add" && $.lines.forEach((b) => {
            w.push(`${" ".repeat(40)} > ${b}`);
          });
      else
        for (const v of S) {
          if (v.type === "equal") continue;
          const $ = (v.line1 ?? 0) + 1, b = (v.line2 ?? 0) + 1;
          v.type === "delete" ? (w.push(`${$},${$ + v.lines.length - 1}d${b - 1}`), v.lines.forEach((A) => w.push(`< ${A}`))) : v.type === "add" && (w.push(`${$ - 1}a${b},${b + v.lines.length - 1}`), v.lines.forEach((A) => w.push(`> ${A}`)));
        }
      return { stdout: w.join(`
`) + (w.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (h) {
      return { stdout: "", stderr: `diff: ${h instanceof Error ? h.message : h}
`, exitCode: 2 };
    }
  }
};
function computeDiff(n, e, t = {}) {
  const s = n.length, o = e.length, r = (d) => {
    let u = d;
    return t.ignoreWhitespace && (u = u.replace(/\s+/g, "")), t.ignoreCase && (u = u.toLowerCase()), u;
  }, i = Array(s + 1).fill(0).map(() => Array(o + 1).fill(0));
  for (let d = 1; d <= s; d++)
    for (let u = 1; u <= o; u++)
      r(n[d - 1]) === r(e[u - 1]) ? i[d][u] = i[d - 1][u - 1] + 1 : i[d][u] = Math.max(i[d - 1][u], i[d][u - 1]);
  const a = [];
  let c = s, l = o;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && r(n[c - 1]) === r(e[l - 1]) ? (a.length > 0 && a[a.length - 1].type === "equal" ? a[a.length - 1].lines.unshift(n[c - 1]) : a.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || i[c][l - 1] >= i[c - 1][l]) ? (a.length > 0 && a[a.length - 1].type === "add" ? a[a.length - 1].lines.unshift(e[l - 1]) : a.push({ type: "add", lines: [e[l - 1]], line1: c, line2: l - 1 }), l--) : (a.length > 0 && a[a.length - 1].type === "delete" ? a[a.length - 1].lines.unshift(n[c - 1]) : a.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: l }), c--);
  return a.reverse();
}
const dirname = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const e = n[0].replace(/\/+$/, ""), t = e.lastIndexOf("/");
    return { stdout: (t === -1 ? "." : t === 0 ? "/" : e.slice(0, t)) + `
`, stderr: "", exitCode: 0 };
  }
}, whileCmd = {
  name: "while",
  description: "Loop while condition is true (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `while: this is a shell language construct that must be interpreted by the shell
Usage: while CONDITION; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, until = {
  name: "until",
  description: "Loop until condition is true (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `until: this is a shell language construct that must be interpreted by the shell
Usage: until CONDITION; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, doCmd = {
  name: "do",
  description: "Start loop body (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `do: can only be used as part of a for/while/until loop
`,
      exitCode: 2
    };
  }
}, done = {
  name: "done",
  description: "End loop (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `done: can only be used to close a for/while/until loop
`,
      exitCode: 2
    };
  }
}, du = {
  name: "du",
  description: "Estimate file space usage",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, ["max-depth", "d"]), r = s.length > 0 ? s : ["."], i = t.s, a = t.a, c = t.h, l = o["max-depth"] || o.d, d = l ? parseInt(l) : 1 / 0, u = [];
    try {
      for (const f of r) {
        const p = e.fs.resolvePath(f, e.cwd), h = await calculateSize(p, e.fs, 0, d, a, !i, u, c), m = c ? formatHuman(h) : String(Math.ceil(h / 1024));
        u.push(`${m}	${f}`);
      }
      return {
        stdout: u.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (f) {
      return {
        stdout: "",
        stderr: `du: ${f instanceof Error ? f.message : f}
`,
        exitCode: 1
      };
    }
  }
};
async function calculateSize(n, e, t, s, o, r, i, a) {
  try {
    const c = await e.stat(n);
    if (c.type === "file")
      return c.size;
    if (c.type === "dir" && t < s) {
      const l = await e.readdir(n);
      let d = 0;
      for (const u of l) {
        const f = n + "/" + u.name, p = await calculateSize(f, e, t + 1, s, o, r, i, a);
        if (d += p, o && u.type === "file") {
          const h = a ? formatHuman(p) : String(Math.ceil(p / 1024));
          i.push(`${h}	${f}`);
        }
        if (r && u.type === "dir" && t + 1 < s) {
          const h = a ? formatHuman(p) : String(Math.ceil(p / 1024));
          i.push(`${h}	${f}`);
        }
      }
      return d;
    }
    return 0;
  } catch {
    return 0;
  }
}
function formatHuman(n) {
  const e = ["", "K", "M", "G", "T"];
  let t = n, s = 0;
  for (; t >= 1024 && s < e.length - 1; )
    t /= 1024, s++;
  return Math.ceil(t) + e[s];
}
const echo = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: e } = parseArgs(n), t = e.n, s = n.filter((r) => r !== "-n" && r !== "-e").join(" ");
    let o = e.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return t || (o += `
`), { stdout: o, stderr: "", exitCode: 0 };
  }
}, ifCmd = {
  name: "if",
  description: "Conditional execution (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `if: this is a shell language construct that must be interpreted by the shell
Usage: if CONDITION; then COMMANDS; [elif CONDITION; then COMMANDS;] [else COMMANDS;] fi
`,
      exitCode: 2
    };
  }
}, then = {
  name: "then",
  description: "Part of if/elif statement (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `then: can only be used as part of an if/elif statement
`,
      exitCode: 2
    };
  }
}, elif = {
  name: "elif",
  description: "Else-if branch (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `elif: can only be used as part of an if statement
`,
      exitCode: 2
    };
  }
}, elseCmd = {
  name: "else",
  description: "Else branch (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `else: can only be used as part of an if statement
`,
      exitCode: 2
    };
  }
}, fi = {
  name: "fi",
  description: "End if statement (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `fi: can only be used to close an if statement
`,
      exitCode: 2
    };
  }
}, env = {
  name: "env",
  description: "Print environment variables",
  async exec(n, e) {
    return { stdout: Object.entries(e.env).map(([s, o]) => `${s}=${o}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, evalCmd = {
  name: "eval",
  description: "Evaluate and execute arguments as a shell command",
  async exec(n, e) {
    const { positional: t } = parseArgs(n);
    return t.join(" "), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, exit = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? parseInt(t[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, expand = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["t", "tabs"]), r = t.t || t.tabs || "8", i = parseInt(r, 10);
    if (isNaN(i) || i <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${r}'
`,
        exitCode: 1
      };
    const a = o.i || o.initial;
    try {
      const { content: c } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), l = c.split(`
`), d = [];
      for (const u of l) {
        let f = "", p = 0;
        for (let h = 0; h < u.length; h++) {
          const m = u[h];
          if (m === "	")
            if (!a || a && f.trim() === "") {
              const g = i - p % i;
              f += " ".repeat(g), p += g;
            } else
              f += m, p++;
          else
            f += m, p++;
        }
        d.push(f);
      }
      return {
        stdout: d.join(`
`) + (c.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `expand: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
}, expr = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(n, e) {
    const { positional: t } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `expr: missing operand
`, exitCode: 1 };
    try {
      const s = evaluateExpression(t);
      return {
        stdout: String(s) + `
`,
        stderr: "",
        exitCode: s === 0 || s === "" ? 1 : 0
      };
    } catch (s) {
      return {
        stdout: "",
        stderr: `expr: ${s instanceof Error ? s.message : s}
`,
        exitCode: 2
      };
    }
  }
};
function evaluateExpression(n) {
  if (n.length === 0)
    throw new Error("syntax error");
  if (n.length === 1)
    return n[0];
  for (let e = 0; e < n.length; e++)
    if (n[e] === "|") {
      const t = evaluateExpression(n.slice(0, e)), s = evaluateExpression(n.slice(e + 1));
      return t && t !== "0" && t !== "" ? t : s;
    }
  for (let e = 0; e < n.length; e++)
    if (n[e] === "&") {
      const t = evaluateExpression(n.slice(0, e)), s = evaluateExpression(n.slice(e + 1));
      return t && t !== "0" && t !== "" && s && s !== "0" && s !== "" ? t : 0;
    }
  for (let e = 0; e < n.length; e++) {
    const t = n[e];
    if (["=", "!=", "<", ">", "<=", ">="].includes(t)) {
      const s = String(evaluateExpression(n.slice(0, e))), o = String(evaluateExpression(n.slice(e + 1))), r = parseFloat(s), i = parseFloat(o), a = !isNaN(r) && !isNaN(i);
      let c = !1;
      if (a)
        switch (t) {
          case "=":
            c = r === i;
            break;
          case "!=":
            c = r !== i;
            break;
          case "<":
            c = r < i;
            break;
          case ">":
            c = r > i;
            break;
          case "<=":
            c = r <= i;
            break;
          case ">=":
            c = r >= i;
            break;
        }
      else
        switch (t) {
          case "=":
            c = s === o;
            break;
          case "!=":
            c = s !== o;
            break;
          case "<":
            c = s < o;
            break;
          case ">":
            c = s > o;
            break;
          case "<=":
            c = s <= o;
            break;
          case ">=":
            c = s >= o;
            break;
        }
      return c ? 1 : 0;
    }
  }
  for (let e = n.length - 1; e >= 0; e--)
    if (n[e] === "+" || n[e] === "-") {
      const t = Number(evaluateExpression(n.slice(0, e))), s = Number(evaluateExpression(n.slice(e + 1)));
      return n[e] === "+" ? t + s : t - s;
    }
  for (let e = n.length - 1; e >= 0; e--)
    if (["*", "/", "%"].includes(n[e])) {
      const t = Number(evaluateExpression(n.slice(0, e))), s = Number(evaluateExpression(n.slice(e + 1)));
      if (n[e] === "*") return t * s;
      if (n[e] === "/") {
        if (s === 0) throw new Error("division by zero");
        return Math.floor(t / s);
      }
      if (n[e] === "%") {
        if (s === 0) throw new Error("division by zero");
        return t % s;
      }
    }
  if (n.length === 3) {
    if (n[1] === ":") {
      const e = n[0], t = n[2];
      try {
        const s = new RegExp("^" + t), o = e.match(s);
        return o ? o[0].length : 0;
      } catch {
        throw new Error("invalid regular expression");
      }
    }
    if (n[0] === "length")
      return String(n[1]).length;
    if (n[0] === "index") {
      const e = n[1], t = n[2];
      for (let s = 0; s < e.length; s++)
        if (t.includes(e[s]))
          return s + 1;
      return 0;
    }
  }
  if (n.length === 4 && n[0] === "substr") {
    const e = n[1], t = Number(n[2]) - 1, s = Number(n[3]);
    return e.substring(t, t + s);
  }
  if (n.length === 1) {
    const e = parseFloat(n[0]);
    return isNaN(e) ? n[0] : e;
  }
  throw new Error("syntax error");
}
const exportCmd = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(n, e) {
    if (n.length === 0)
      return { stdout: Object.entries(e.env).map(([r, i]) => `export ${r}="${i}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const t = [], s = [];
    for (const o of n) {
      const r = o.indexOf("=");
      if (r === -1) {
        const i = o;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i)) {
          s.push(`export: \`${i}': not a valid identifier`);
          continue;
        }
        i in e.env ? t.push(`export ${i}="${e.env[i]}"`) : t.push(`export ${i}=""`);
      } else {
        const i = o.slice(0, r);
        let a = o.slice(r + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i)) {
          s.push(`export: \`${i}': not a valid identifier`);
          continue;
        }
        (a.startsWith('"') && a.endsWith('"') || a.startsWith("'") && a.endsWith("'")) && (a = a.slice(1, -1)), e.env[i] = a, t.push(`export ${i}="${a}"`);
      }
    }
    return s.length > 0 ? {
      stdout: "",
      stderr: s.join(`
`) + `
`,
      exitCode: 1
    } : { stdout: "", stderr: "", exitCode: 0 };
  }
}, falseCmd = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, forCmd = {
  name: "for",
  description: "Iterate over list (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `for: this is a shell language construct that must be interpreted by the shell
Usage: for VAR in LIST; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, inCmd = {
  name: "in",
  description: "Part of for loop (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `in: can only be used as part of a for loop or case statement
`,
      exitCode: 2
    };
  }
}, functionCmd = {
  name: "function",
  description: "Define shell function (shell language construct)",
  async exec(n, e) {
    return {
      stdout: "",
      stderr: `function: this is a shell language construct that must be interpreted by the shell
Usage: function NAME { COMMANDS; } or NAME() { COMMANDS; }
`,
      exitCode: 2
    };
  }
}, file = {
  name: "file",
  description: "Determine file type",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `file: missing operand
`, exitCode: 1 };
    const o = s.b, r = s.i || s.mime, i = s["mime-type"], a = s["mime-encoding"], c = [];
    try {
      for (const l of t) {
        const d = e.fs.resolvePath(l, e.cwd);
        try {
          if ((await e.fs.stat(d)).type === "dir") {
            const m = o ? "directory" : `${l}: directory`;
            c.push(m);
            continue;
          }
          const f = await e.fs.readFile(d), p = detectFileType(f, l);
          let h;
          i ? h = o ? p.mimeType : `${l}: ${p.mimeType}` : a ? h = o ? p.encoding : `${l}: ${p.encoding}` : r ? h = o ? `${p.mimeType}; charset=${p.encoding}` : `${l}: ${p.mimeType}; charset=${p.encoding}` : h = o ? p.description : `${l}: ${p.description}`, c.push(h);
        } catch (u) {
          c.push(`${l}: cannot open (${u instanceof Error ? u.message : u})`);
        }
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (l) {
      return {
        stdout: "",
        stderr: `file: ${l instanceof Error ? l.message : l}
`,
        exitCode: 1
      };
    }
  }
};
function detectFileType(n, e) {
  var i;
  let t = "text/plain", s = "us-ascii", o = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", o = "UTF-8 Unicode text"), n.length === 0)
    return t = "application/x-empty", o = "empty", { mimeType: t, encoding: s, description: o };
  const r = (i = e.split(".").pop()) == null ? void 0 : i.toLowerCase();
  if (r)
    switch (r) {
      case "js":
      case "mjs":
        t = "text/javascript", o = "JavaScript source";
        break;
      case "ts":
        t = "text/x-typescript", o = "TypeScript source";
        break;
      case "json":
        t = "application/json", o = "JSON data";
        break;
      case "html":
      case "htm":
        t = "text/html", o = "HTML document";
        break;
      case "css":
        t = "text/css", o = "CSS stylesheet";
        break;
      case "xml":
        t = "text/xml", o = "XML document";
        break;
      case "md":
        t = "text/markdown", o = "Markdown text";
        break;
      case "sh":
        t = "text/x-shellscript", o = "shell script";
        break;
      case "py":
        t = "text/x-python", o = "Python script";
        break;
      case "txt":
        t = "text/plain", o = "ASCII text";
        break;
    }
  if (n.startsWith("#!/bin/sh") || n.startsWith("#!/bin/bash"))
    t = "text/x-shellscript", o = "Bourne-Again shell script";
  else if (n.startsWith("#!/usr/bin/env node"))
    t = "text/javascript", o = "Node.js script";
  else if (n.startsWith("#!/usr/bin/env python"))
    t = "text/x-python", o = "Python script";
  else if (n.startsWith("{") && n.trim().endsWith("}"))
    try {
      JSON.parse(n), t = "application/json", o = "JSON data";
    } catch {
    }
  else n.startsWith("<?xml") ? (t = "text/xml", o = "XML document") : (n.startsWith("<!DOCTYPE html") || n.startsWith("<html")) && (t = "text/html", o = "HTML document");
  return { mimeType: t, encoding: s, description: o };
}
const find = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), r = s[0] ?? ".", i = t.name, a = t.iname, c = t.path, l = t.type, d = t.maxdepth ? parseInt(t.maxdepth) : 1 / 0, u = t.mindepth ? parseInt(t.mindepth) : 0, f = t.exec, p = o.print !== !1, h = e.fs.resolvePath(r, e.cwd), m = [], g = [];
    let x;
    if (i) {
      const v = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${v}$`);
    }
    let y;
    if (a) {
      const v = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      y = new RegExp(`^${v}$`, "i");
    }
    let C;
    if (c) {
      const v = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      C = new RegExp(v);
    }
    async function S(v, $, b) {
      let A;
      try {
        A = await e.fs.readdir(v);
      } catch {
        return;
      }
      for (const I of A) {
        const E = v + "/" + I.name, k = $ ? $ + "/" + I.name : I.name, M = r === "." ? "./" + k : r + "/" + k, P = b + 1;
        let F = !0;
        if (!(P > d)) {
          if (P < u && (F = !1), x && !x.test(I.name) && (F = !1), y && !y.test(I.name) && (F = !1), C && !C.test(M) && (F = !1), l === "f" && I.type !== "file" && (F = !1), l === "d" && I.type !== "dir" && (F = !1), F && (p && m.push(M), f)) {
            const N = f.replace(/\{\}/g, M);
            g.push(`Executing: ${N}`);
          }
          I.type === "dir" && P < d && await S(E, k, P);
        }
      }
    }
    0 >= u && (!l || l === "d") && !x && !y && !C && p && m.push(r === "." ? "." : r), await S(h, "", 0);
    let w = "";
    return m.length > 0 && (w = m.join(`
`) + `
`), g.length > 0 && (w += g.join(`
`) + `
`), { stdout: w, stderr: "", exitCode: 0 };
  }
}, fmt = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["w", "width"]), r = parseInt(t.w || t.width || "75", 10);
    o.u;
    const i = o.s;
    if (isNaN(r) || r <= 0)
      return {
        stdout: "",
        stderr: `fmt: invalid width: '${t.w || t.width}'
`,
        exitCode: 1
      };
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = a.split(`
`), l = [];
      let d = [];
      const u = () => {
        if (d.length !== 0) {
          if (i)
            for (const f of d)
              l.push(...wrapLine(f, r));
          else {
            const f = d.join(" ").trim();
            f && l.push(...wrapLine(f, r));
          }
          d = [];
        }
      };
      for (const f of c) {
        const p = f.trim();
        p === "" ? (u(), l.push("")) : d.push(p);
      }
      return u(), {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `fmt: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
function wrapLine(n, e) {
  const t = [], s = n.split(/\s+/);
  let o = "";
  for (const r of s)
    o.length === 0 ? o = r : o.length + 1 + r.length <= e ? o += " " + r : (t.push(o), o = r);
  return o.length > 0 && t.push(o), t;
}
const fold = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["w", "width"]), r = parseInt(t.w || t.width || "80", 10);
    o.b;
    const i = o.s;
    if (isNaN(r) || r <= 0)
      return {
        stdout: "",
        stderr: `fold: invalid width: '${t.w || t.width}'
`,
        exitCode: 1
      };
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = a.split(`
`), l = [];
      for (const d of c) {
        if (d.length <= r) {
          l.push(d);
          continue;
        }
        let u = d;
        for (; u.length > r; ) {
          let f = r;
          if (i) {
            const p = u.substring(0, r).lastIndexOf(" ");
            p > 0 && (f = p + 1);
          }
          l.push(u.substring(0, f)), u = u.substring(f);
        }
        u.length > 0 && l.push(u);
      }
      return {
        stdout: l.join(`
`) + (a.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `fold: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, free = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.h, o = t.b, r = t.m, i = t.g, a = [], c = 8388608, l = 4194304, d = 4194304, u = 524288, f = 1048576, p = 5242880;
    return s ? (a.push("               total        used        free      shared  buff/cache   available"), a.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), a.push("Swap:           2.0G          0B        2.0G")) : o ? (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:    ${c * 1024} ${l * 1024} ${d * 1024} ${u * 1024} ${f * 1024} ${p * 1024}`), a.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : r ? (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:           ${Math.floor(c / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(d / 1024)}         ${Math.floor(u / 1024)}        ${Math.floor(f / 1024)}        ${Math.floor(p / 1024)}`), a.push("Swap:          2048           0        2048")) : i ? (a.push("               total        used        free      shared  buff/cache   available"), a.push("Mem:               8           4           4           0           1           5"), a.push("Swap:              2           0           2")) : (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:        ${c}     ${l}     ${d}      ${u}     ${f}     ${p}`), a.push("Swap:       2097152           0     2097152")), {
      stdout: a.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, getopts = {
  name: "getopts",
  description: "Parse option arguments (shell built-in)",
  async exec(n, e) {
    var p, h;
    if (n.length < 2)
      return {
        stdout: "",
        stderr: `getopts: usage: getopts OPTSTRING NAME [args...]
`,
        exitCode: 1
      };
    const t = n[0], s = n[1], o = n.slice(2);
    let r = parseInt(((p = e.env) == null ? void 0 : p.OPTIND) || "1");
    const i = t.startsWith(":"), a = i ? t.slice(1) : t, c = /* @__PURE__ */ new Map();
    for (let m = 0; m < a.length; m++) {
      const g = a[m];
      if (g === ":") continue;
      const x = a[m + 1] === ":";
      c.set(g, x);
    }
    const l = o.length > 0 ? o : (h = e.env) != null && h.$1 ? [e.env.$1, e.env.$2, e.env.$3].filter(Boolean) : [];
    if (l.length === 0 || r > l.length)
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const d = l[r - 1];
    if (!d || !d.startsWith("-") || d === "-" || d === "--")
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const u = d[1];
    if (!c.has(u))
      return e.env && (e.env[s] = "?", e.env.OPTARG = u, e.env.OPTIND = String(r + 1)), i ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `getopts: illegal option -- ${u}
`,
        exitCode: 0
      };
    if (c.get(u)) {
      let m;
      if (d.length > 2)
        m = d.slice(2);
      else if (r < l.length)
        m = l[r], e.env && (e.env.OPTIND = String(r + 2));
      else
        return e.env && (e.env[s] = "?", e.env.OPTARG = u, e.env.OPTIND = String(r + 1)), i ? {
          stdout: "",
          stderr: "",
          exitCode: 0
        } : {
          stdout: "",
          stderr: `getopts: option requires an argument -- ${u}
`,
          exitCode: 0
        };
      e.env && (e.env[s] = u, e.env.OPTARG = m, e.env.OPTIND || (e.env.OPTIND = String(r + 1)));
    } else
      e.env && (e.env[s] = u, e.env.OPTIND = String(r + 1), delete e.env.OPTARG);
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, grep = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["e"]), r = !!t.i, i = !!t.v, a = !!t.c, c = !!t.l, l = !!t.n, d = !!(t.r || t.R), u = s.e ?? o.shift();
    if (!u)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const f = r ? "i" : "";
    let p;
    try {
      p = new RegExp(u, f);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${u}
`, exitCode: 2 };
    }
    const h = o.length > 0 ? o : ["-"], m = h.length > 1 || d, g = [];
    let x = !1;
    async function y(w, v) {
      let $;
      try {
        if (w === "-")
          $ = e.stdin;
        else {
          const I = e.fs.resolvePath(w, e.cwd);
          $ = await e.fs.readFile(I);
        }
      } catch {
        g.push(`grep: ${w}: No such file or directory`);
        return;
      }
      const b = $.split(`
`);
      b.length > 0 && b[b.length - 1] === "" && b.pop();
      let A = 0;
      for (let I = 0; I < b.length; I++)
        if (p.test(b[I]) !== i && (x = !0, A++, !a && !c)) {
          const k = m ? `${v}:` : "", M = l ? `${I + 1}:` : "";
          g.push(`${k}${M}${b[I]}`);
        }
      a && g.push(m ? `${v}:${A}` : String(A)), c && A > 0 && g.push(v);
    }
    async function C(w) {
      const v = e.fs.resolvePath(w, e.cwd);
      let $;
      try {
        $ = await e.fs.readdir(v);
      } catch {
        return;
      }
      for (const b of $) {
        const A = v + "/" + b.name;
        b.type === "dir" ? await C(A) : await y(A, A);
      }
    }
    for (const w of h)
      if (w === "-")
        await y("-", "(standard input)");
      else if (d) {
        const v = e.fs.resolvePath(w, e.cwd);
        let $;
        try {
          $ = await e.fs.stat(v);
        } catch {
          continue;
        }
        $.type === "dir" ? await C(v) : await y(w, w);
      } else
        await y(w, w);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, hash = {
  name: "hash",
  description: "Remember or report command locations",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["r", "d", "l", "p", "t"]);
    return t.r ? {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : t.d ? s.length === 0 ? {
      stdout: "",
      stderr: `hash: -d: option requires an argument
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : t.l ? {
      stdout: s.length === 0 ? "" : s.map((r) => `builtin hash ${r}=/usr/bin/${r}`).join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    } : t.p ? {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : t.t ? s.length === 0 ? {
      stdout: "",
      stderr: `hash: -t: option requires an argument
`,
      exitCode: 1
    } : {
      stdout: s.map((r) => `/usr/bin/${r}`).join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    } : s.length === 0 ? {
      stdout: `hits	command
   0	/usr/bin/ls
   0	/usr/bin/cat
   0	/usr/bin/grep
`,
      stderr: "",
      exitCode: 0
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, head = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, e) {
    const { values: t, positional: s } = parseArgs(n, ["n"]), o = parseInt(t.n ?? "10", 10);
    try {
      const { content: r } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: r.split(`
`).slice(0, o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `head: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, heredoc = {
  name: "heredoc",
  description: "Helper for here-document processing (shell feature)",
  async exec(n, e) {
    return {
      stdout: `heredoc: This is a shell language feature, not a command.

Here-document syntax must be implemented at the shell parser level:

Syntax:
  command << DELIMITER
  content line 1
  content line 2
  DELIMITER

Variants:
  <<  DELIMITER  - Normal mode (variable expansion enabled)
  << 'DELIMITER' - Literal mode (no expansion)
  <<- DELIMITER  - Strip leading tabs from content lines

Implementation guidance for shell parsers:
1. When encountering <<, capture the delimiter (next token)
2. Read subsequent lines until line exactly matches delimiter
3. Apply expansions ($var, $(cmd), \`cmd\`) unless in literal mode
4. If <<-, strip leading tabs from each line
5. Pass the collected content as stdin to the command

Examples:
  cat << EOF
  Hello, \${USER}!
  The date is $(date)
  EOF

  cat << 'EOF'
  Literal \${USER} - no expansion
  EOF

  cat <<- EOF
  \\tThis line had a leading tab that was stripped
  EOF

Shell implementers: Parse heredoc at the token/syntax level before command execution.

`,
      stderr: "",
      exitCode: 0
    };
  }
}, hexdump = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["n", "s", "C"]), r = o.C, i = t.n ? parseInt(t.n) : void 0, a = t.s ? parseInt(t.s) : 0;
    try {
      const { content: c } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let l = c.substring(a, i ? a + i : void 0);
      const d = [];
      if (r) {
        for (let f = 0; f < l.length; f += 16) {
          const p = l.substring(f, f + 16), h = (a + f).toString(16).padStart(8, "0"), m = formatHexGroup(p.substring(0, 8)), g = formatHexGroup(p.substring(8, 16)), x = formatAscii(p);
          d.push(`${h}  ${m}  ${g}  |${x}|`);
        }
        const u = (a + l.length).toString(16).padStart(8, "0");
        d.push(u);
      } else {
        for (let f = 0; f < l.length; f += 16) {
          const p = l.substring(f, f + 16), h = (a + f).toString(16).padStart(7, "0"), m = [];
          for (let g = 0; g < p.length; g += 2) {
            const x = p.charCodeAt(g), y = g + 1 < p.length ? p.charCodeAt(g + 1) : 0, C = (x << 8 | y).toString(16).padStart(4, "0");
            m.push(C);
          }
          d.push(`${h} ${m.join(" ")}`);
        }
        const u = (a + l.length).toString(16).padStart(7, "0");
        d.push(u);
      }
      return {
        stdout: d.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `hexdump: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
};
function formatHexGroup(n) {
  const e = [];
  for (let t = 0; t < 8; t++)
    t < n.length ? e.push(n.charCodeAt(t).toString(16).padStart(2, "0")) : e.push("  ");
  return e.join(" ");
}
function formatAscii(n) {
  let e = "";
  for (let t = 0; t < 16; t++)
    if (t < n.length) {
      const s = n.charCodeAt(t);
      e += s >= 32 && s < 127 ? n[t] : ".";
    } else
      e += " ";
  return e;
}
const hostname = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, e) {
    return { stdout: (e.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, id = {
  name: "id",
  description: "Print user identity",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n), o = t[0] || e.env.USER || "user", r = s.u || s.user, i = s.g || s.group, a = s.G || s.groups, c = s.n || s.name;
    s.r || s.real;
    const l = 1e3, d = 1e3, u = [1e3], f = o, p = "users", h = [];
    if (r)
      c ? h.push(f) : h.push(String(l));
    else if (i)
      c ? h.push(p) : h.push(String(d));
    else if (a)
      c ? h.push(p) : h.push(u.join(" "));
    else {
      const m = u.map((g) => `${g}(${p})`).join(",");
      h.push(`uid=${l}(${f}) gid=${d}(${p}) groups=${m}`);
    }
    return {
      stdout: h.join(`
`) + (h.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, install = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    t.m || t.mode;
    const r = t.t || t["target-directory"], i = o.d || o.directory, a = o.v || o.verbose;
    if (s.length === 0)
      return { stdout: "", stderr: `install: missing operand
`, exitCode: 1 };
    const c = [];
    try {
      if (i)
        for (const l of s) {
          const d = e.fs.resolvePath(l, e.cwd);
          await e.fs.mkdir(d, { recursive: !0 }), a && c.push(`install: creating directory '${l}'`);
        }
      else if (r) {
        const l = e.fs.resolvePath(r, e.cwd);
        for (const d of s) {
          const u = e.fs.resolvePath(d, e.cwd), f = d.split("/").pop() || d, p = l + "/" + f, h = await e.fs.readFile(u);
          await e.fs.writeFile(p, h), a && c.push(`'${d}' -> '${r}/${f}'`);
        }
      } else {
        if (s.length < 2)
          return { stdout: "", stderr: `install: missing destination
`, exitCode: 1 };
        const l = s[s.length - 1], d = s.slice(0, -1), u = e.fs.resolvePath(l, e.cwd);
        let f = !1;
        try {
          f = (await e.fs.stat(u)).type === "dir";
        } catch {
          f = d.length > 1;
        }
        if (f && d.length > 1)
          for (const p of d) {
            const h = e.fs.resolvePath(p, e.cwd), m = p.split("/").pop() || p, g = u + "/" + m, x = await e.fs.readFile(h);
            await e.fs.writeFile(g, x), a && c.push(`'${p}' -> '${l}/${m}'`);
          }
        else {
          const p = e.fs.resolvePath(d[0], e.cwd), h = await e.fs.readFile(p);
          await e.fs.writeFile(u, h), a && c.push(`'${d[0]}' -> '${l}'`);
        }
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (l) {
      return {
        stdout: "",
        stderr: `install: ${l instanceof Error ? l.message : l}
`,
        exitCode: 1
      };
    }
  }
}, join = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const r = t[1] ? parseInt(t[1]) - 1 : 0, i = t[2] ? parseInt(t[2]) - 1 : 0, a = t.t || /\s+/, c = t.o, l = o.i;
    try {
      const d = e.fs.resolvePath(s[0], e.cwd), u = e.fs.resolvePath(s[1], e.cwd), f = await e.fs.readFile(d), p = await e.fs.readFile(u), h = f.split(`
`).filter((w) => w.trim() !== ""), m = p.split(`
`).filter((w) => w.trim() !== ""), g = (w) => w.map((v) => v.split(a)), x = g(h), y = g(m), C = /* @__PURE__ */ new Map();
      for (const w of y) {
        const v = (w[i] || "").trim(), $ = l ? v.toLowerCase() : v;
        C.has($) || C.set($, []), C.get($).push(w);
      }
      const S = [];
      for (const w of x) {
        const v = (w[r] || "").trim(), $ = l ? v.toLowerCase() : v, b = C.get($) || [];
        for (const A of b) {
          let I;
          if (c)
            I = c.split(",").map((k) => {
              const [M, P] = k.split(".").map((N) => parseInt(N));
              return (M === 1 ? w : A)[P - 1] || "";
            }).join(" ");
          else {
            const E = w[r] || "", k = w.filter((P, F) => F !== r), M = A.filter((P, F) => F !== i);
            I = [E, ...k, ...M].join(" ");
          }
          S.push(I);
        }
      }
      return {
        stdout: S.join(`
`) + (S.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `join: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
}, less = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    try {
      const { content: o } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), r = o.split(`
`), i = t.N || t.n;
      let a = "";
      return i ? a = r.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : a = o, a && !a.endsWith(`
`) && (a += `
`), { stdout: a, stderr: "", exitCode: 0 };
    } catch (o) {
      return {
        stdout: "",
        stderr: `less: ${o instanceof Error ? o.message : o}
`,
        exitCode: 1
      };
    }
  }
}, letCmd = {
  name: "let",
  description: "Evaluate arithmetic expressions",
  async exec(n, e) {
    if (n.length === 0)
      return {
        stdout: "",
        stderr: `let: usage: let arg [arg ...]
`,
        exitCode: 1
      };
    try {
      const t = n.join(" "), s = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (s) {
        const r = s[1], i = s[2], a = evaluateArithmetic(i, e.env || {});
        return e.env && (e.env[r] = String(a)), {
          stdout: "",
          stderr: "",
          exitCode: a === 0 ? 1 : 0
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: evaluateArithmetic(t, e.env || {}) === 0 ? 1 : 0
      };
    } catch (t) {
      return {
        stdout: "",
        stderr: `let: ${t.message}
`,
        exitCode: 1
      };
    }
  }
};
function evaluateArithmetic(n, e) {
  let t = n.trim();
  t = t.replace(/\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g, (s, o) => e[o] || "0");
  try {
    if (t = t.replace(/\s+/g, ""), /^[\d+\-*/%()]+$/.test(t)) {
      const o = new Function(`return (${t})`)();
      return Math.floor(o);
    }
    if (t.includes("==") || t.includes("!=") || t.includes("<=") || t.includes(">=") || t.includes("<") || t.includes(">"))
      return new Function(`return (${t}) ? 1 : 0`)();
    if (t.includes("&&") || t.includes("||"))
      return new Function(`return (${t}) ? 1 : 0`)();
    const s = parseFloat(t);
    if (!isNaN(s))
      return Math.floor(s);
    throw new Error(`invalid arithmetic expression: ${n}`);
  } catch {
    throw new Error(`invalid arithmetic expression: ${n}`);
  }
}
const arithmeticExpansion = {
  evaluate: evaluateArithmetic
}, ln = {
  name: "ln",
  description: "Make links between files",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.s, r = t.f, i = t.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const a = e.fs.resolvePath(s[0], e.cwd), c = e.fs.resolvePath(s[1], e.cwd), l = [];
    try {
      if (await e.fs.exists(c))
        if (r)
          try {
            await e.fs.unlink(c);
          } catch {
          }
        else
          return {
            stdout: "",
            stderr: `ln: ${c}: File exists
`,
            exitCode: 1
          };
      if (o && e.fs.symlink)
        await e.fs.symlink(a, c), i && l.push(`'${c}' -> '${a}'`);
      else {
        const d = await e.fs.readFile(a);
        await e.fs.writeFile(c, d), i && l.push(`'${c}' => '${a}'`);
      }
      return {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return { stdout: "", stderr: `ln: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
}, ls = {
  name: "ls",
  description: "List directory contents",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = s.length > 0 ? s : ["."], r = t.a, i = t.l, a = t.h, c = [];
    for (const l of o) {
      const d = e.fs.resolvePath(l, e.cwd), u = await e.fs.stat(d);
      if (u.type === "file") {
        c.push(i ? formatLong(d.split("/").pop(), u, a) : d.split("/").pop());
        continue;
      }
      o.length > 1 && c.push(`${l}:`);
      const f = await e.fs.readdir(d), p = r ? f : f.filter((h) => !h.name.startsWith("."));
      if (p.sort((h, m) => h.name.localeCompare(m.name)), i) {
        c.push(`total ${p.length}`);
        for (const h of p)
          c.push(formatLong(h.name, h, a));
      } else
        c.push(p.map((h) => h.type === "dir" ? h.name + "/" : h.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function formatLong(n, e, t) {
  const s = e.type === "dir" ? "d" : "-", o = e.mode ?? (e.type === "dir" ? 493 : 420), r = formatPerms(o), i = t ? humanSize(e.size) : String(e.size).padStart(8), a = new Date(e.mtime), c = formatDate(a);
  return `${s}${r}  1 user user ${i} ${c} ${n}`;
}
function formatPerms(n) {
  let t = "";
  for (let s = 2; s >= 0; s--) {
    const o = n >> s * 3 & 7;
    for (let r = 2; r >= 0; r--)
      t += o & 1 << r ? "rwx"[2 - r] : "-";
  }
  return t;
}
function formatDate(n) {
  const t = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), o = String(n.getHours()).padStart(2, "0"), r = String(n.getMinutes()).padStart(2, "0");
  return `${t} ${s} ${o}:${r}`;
}
function humanSize(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const make = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["f", "file", "C", "j"]), r = t.f || t.file || "Makefile", i = t.C;
    t.j;
    const a = o.n || o["dry-run"], c = o.p || o.print, l = s.length > 0 ? s : ["all"];
    try {
      const d = i ? e.fs.resolvePath(i, e.cwd) : e.cwd, u = e.fs.resolvePath(r, d);
      let f;
      try {
        f = await e.fs.readFile(u);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${r}: No such file or directory
`,
          exitCode: 2
        };
      }
      const p = parseMakefile(f), h = [];
      for (const m of l) {
        const g = p.get(m);
        if (!g)
          return {
            stdout: "",
            stderr: `make: *** No rule to make target '${m}'. Stop.
`,
            exitCode: 2
          };
        for (const x of g.prerequisites) {
          const y = p.get(x);
          if (y)
            for (const C of y.commands)
              c || a ? h.push(C) : h.push(`# ${C}`);
        }
        for (const x of g.commands)
          c || a ? h.push(x) : h.push(`# ${x}`);
      }
      return {
        stdout: h.join(`
`) + (h.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `make: ${d instanceof Error ? d.message : d}
`,
        exitCode: 2
      };
    }
  }
};
function parseMakefile(n) {
  const e = /* @__PURE__ */ new Map(), t = n.split(`
`);
  let s = null;
  for (let o = 0; o < t.length; o++) {
    const r = t[o];
    if (!(r.trim().startsWith("#") || r.trim() === ""))
      if (r.includes(":") && !r.startsWith("	")) {
        const i = r.indexOf(":"), a = r.substring(0, i).trim(), c = r.substring(i + 1).trim(), l = c ? c.split(/\s+/) : [];
        s = { target: a, prerequisites: l, commands: [] }, e.set(a, s);
      } else r.startsWith("	") && s && s.commands.push(r.substring(1));
  }
  return e;
}
const md5sum = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.c || t.check, r = t.b || t.binary;
    if (o)
      return {
        stdout: "",
        stderr: `md5sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const i = s.length > 0 ? s : ["-"], a = [];
    try {
      for (const c of i) {
        let l;
        if (c === "-")
          l = e.stdin;
        else {
          const f = e.fs.resolvePath(c, e.cwd);
          l = await e.fs.readFile(f);
        }
        const d = await md5(l), u = r ? "*" : " ";
        a.push(`${d}${u}${c === "-" ? "-" : c}`);
      }
      return {
        stdout: a.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `md5sum: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
};
async function md5(n) {
  let e = 0;
  for (let s = 0; s < n.length; s++) {
    const o = n.charCodeAt(s);
    e = (e << 5) - e + o, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(32, "0");
}
const mkdir = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const r of s) {
        const i = e.fs.resolvePath(r, e.cwd);
        await e.fs.mkdir(i, { recursive: o });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `mkdir: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, mv = {
  name: "mv",
  description: "Move or rename files",
  async exec(n, e) {
    const { positional: t } = parseArgs(n);
    if (t.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const s = e.fs.resolvePath(t[t.length - 1], e.cwd), o = t.slice(0, -1);
    let r = !1;
    try {
      r = (await e.fs.stat(s)).type === "dir";
    } catch {
    }
    if (o.length > 1 && !r)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const i of o) {
        const a = e.fs.resolvePath(i, e.cwd), c = i.split("/").pop(), l = r ? s + "/" + c : s;
        await e.fs.rename(a, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `mv: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, nl = {
  name: "nl",
  description: "Number lines of files",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["b", "s", "w", "n", "v"]), r = t.b || "t", i = t.s || "	", a = parseInt(t.w || "6", 10), c = t.n || "rn", l = parseInt(t.v || "1", 10);
    o.p;
    const d = o.ba;
    try {
      const { content: u } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), f = u.split(`
`), p = [];
      let h = l;
      for (const m of f) {
        let g = !1;
        const x = d ? "a" : r;
        switch (x) {
          case "a":
            g = !0;
            break;
          case "t":
            g = m.trim() !== "";
            break;
          case "n":
            g = !1;
            break;
          default:
            if (x.startsWith("p")) {
              const y = x.substring(1);
              try {
                g = new RegExp(y).test(m);
              } catch {
                g = !1;
              }
            }
        }
        if (g) {
          const y = formatNumber(h, a, c);
          p.push(y + i + m), h++;
        } else
          p.push(" ".repeat(a) + i + m);
      }
      return {
        stdout: p.join(`
`) + (u.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `nl: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
};
function formatNumber(n, e, t) {
  const s = String(n);
  switch (t) {
    case "ln":
      return s.padEnd(e, " ");
    case "rn":
      return s.padStart(e, " ");
    case "rz":
      return s.padStart(e, "0");
    default:
      return s.padStart(e, " ");
  }
}
const nohup = {
  name: "nohup",
  description: "Run a command immune to hangups",
  async exec(n, e) {
    if (n.length === 0)
      return {
        stdout: "",
        stderr: `nohup: missing operand
Try 'nohup --help' for more information.
`,
        exitCode: 125
      };
    const t = n[0], s = n.slice(1), o = `nohup: ignoring input and appending output to 'nohup.out'
`;
    try {
      const r = e.fs.resolvePath("nohup.out", e.cwd), a = `[${(/* @__PURE__ */ new Date()).toISOString()}] Command: ${t} ${s.join(" ")}
`;
      let c = "";
      try {
        c = await e.fs.readFile(r);
      } catch {
      }
      await e.fs.writeFile(r, c + a);
    } catch (r) {
      return {
        stdout: "",
        stderr: `nohup: cannot create nohup.out: ${r.message}
`,
        exitCode: 125
      };
    }
    return {
      stdout: "",
      stderr: o,
      exitCode: 0
    };
  }
}, od = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["t", "N", "j", "w", "A"]), r = t.t || "o2", i = t.N ? parseInt(t.N) : void 0, a = t.j ? parseInt(t.j) : 0, c = t.w ? parseInt(t.w) : 16, l = t.A || "o", d = o.b || o.c || o.d || o.o || o.s || o.x;
    try {
      const { content: u } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let f = u.substring(a, i ? a + i : void 0);
      const p = [];
      let h = "o", m = 2;
      d ? o.b ? (h = "o", m = 1) : o.c ? (h = "c", m = 1) : o.d || o.s ? (h = "d", m = 2) : o.o ? (h = "o", m = 2) : o.x && (h = "x", m = 2) : r && (h = r[0] || "o", m = parseInt(r.substring(1)) || 2);
      let g = a;
      for (let x = 0; x < f.length; x += c) {
        const y = f.substring(x, x + c), C = formatAddress(g, l), S = formatChunk(y, h, m);
        p.push(`${C} ${S}`), g += y.length;
      }
      return l !== "n" && p.push(formatAddress(g, l)), {
        stdout: p.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `od: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
};
function formatAddress(n, e) {
  switch (e) {
    case "o":
      return n.toString(8).padStart(7, "0");
    case "d":
      return n.toString(10).padStart(7, " ");
    case "x":
      return n.toString(16).padStart(7, "0");
    case "n":
      return "";
    default:
      return n.toString(8).padStart(7, "0");
  }
}
function formatChunk(n, e, t) {
  const s = [];
  for (let o = 0; o < n.length; o += t) {
    const r = n.substring(o, o + t);
    let i = 0;
    for (let a = 0; a < r.length; a++)
      i = i << 8 | r.charCodeAt(a);
    switch (e) {
      case "o":
        s.push(i.toString(8).padStart(t * 3, "0"));
        break;
      case "x":
        s.push(i.toString(16).padStart(t * 2, "0"));
        break;
      case "d":
        s.push(i.toString(10).padStart(t * 3, " "));
        break;
      case "c":
        s.push(formatChar(r.charCodeAt(0)));
        break;
      case "a":
        s.push(namedChar(r.charCodeAt(0)));
        break;
      default:
        s.push(i.toString(8).padStart(t * 3, "0"));
    }
  }
  return s.join(" ");
}
function formatChar(n) {
  return n >= 32 && n < 127 ? `  ${String.fromCharCode(n)}` : n === 0 ? " \\0" : n === 7 ? " \\a" : n === 8 ? " \\b" : n === 9 ? " \\t" : n === 10 ? " \\n" : n === 11 ? " \\v" : n === 12 ? " \\f" : n === 13 ? " \\r" : n.toString(8).padStart(3, "0");
}
function namedChar(n) {
  return {
    0: "nul",
    7: "bel",
    8: "bs",
    9: "ht",
    10: "nl",
    11: "vt",
    12: "ff",
    13: "cr",
    32: "sp",
    127: "del"
  }[n] || String.fromCharCode(n);
}
const paste = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["d", "delimiters"]), r = t.d || t.delimiters || "	", i = o.s;
    s.length === 0 && s.push("-");
    try {
      const a = [];
      for (const l of s) {
        let d;
        if (l === "-")
          d = e.stdin;
        else {
          const u = e.fs.resolvePath(l, e.cwd);
          d = await e.fs.readFile(u);
        }
        a.push(d.split(`
`).filter((u, f, p) => f < p.length - 1 || u !== ""));
      }
      const c = [];
      if (i)
        for (const l of a) {
          const d = r.split(""), u = [];
          for (let f = 0; f < l.length; f++)
            u.push(l[f]), f < l.length - 1 && u.push(d[f % d.length]);
          c.push(u.join(""));
        }
      else {
        const l = Math.max(...a.map((u) => u.length)), d = r.split("");
        for (let u = 0; u < l; u++) {
          const f = [];
          for (let p = 0; p < a.length; p++) {
            const h = a[p][u] || "";
            f.push(h), p < a.length - 1 && f.push(d[p % d.length]);
          }
          c.push(f.join(""));
        }
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `paste: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, patch = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["p", "i", "input", "o", "output"]), r = t.p ? parseInt(t.p) : 0, i = t.i || t.input, a = t.o || t.output, c = o.R || o.reverse, l = o["dry-run"];
    try {
      let d;
      if (i) {
        const p = e.fs.resolvePath(i, e.cwd);
        d = await e.fs.readFile(p);
      } else if (s.length > 0) {
        const p = e.fs.resolvePath(s[0], e.cwd);
        d = await e.fs.readFile(p);
      } else
        d = e.stdin;
      const u = parseUnifiedDiff(d), f = [];
      for (const p of u) {
        const h = stripPath(p.newFile, r), m = stripPath(p.oldFile, r);
        if (f.push(`patching file ${h}`), !l) {
          let g;
          try {
            const y = e.fs.resolvePath(h, e.cwd);
            g = await e.fs.readFile(y);
          } catch {
            g = "";
          }
          const x = applyPatch(g, p.hunks, c);
          if (a) {
            const y = e.fs.resolvePath(a, e.cwd);
            await e.fs.writeFile(y, x);
          } else {
            const y = e.fs.resolvePath(h, e.cwd);
            await e.fs.writeFile(y, x);
          }
        }
      }
      return {
        stdout: f.join(`
`) + (f.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `patch: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
};
function parseUnifiedDiff(n) {
  const e = [], t = n.split(`
`);
  let s = null, o = null;
  for (const r of t)
    if (r.startsWith("--- "))
      s = { oldFile: r.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (r.startsWith("+++ ") && s)
      s.newFile = r.substring(4).split("	")[0], e.push(s);
    else if (r.startsWith("@@ ") && s) {
      const i = r.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      i && (o = {
        oldStart: parseInt(i[1]),
        oldLines: parseInt(i[2]),
        newStart: parseInt(i[3]),
        newLines: parseInt(i[4]),
        lines: []
      }, s.hunks.push(o));
    } else o && (r.startsWith(" ") || r.startsWith("+") || r.startsWith("-")) && o.lines.push(r);
  return e;
}
function stripPath(n, e) {
  return n.split("/").slice(e).join("/");
}
function applyPatch(n, e, t) {
  const s = n.split(`
`);
  for (const o of e) {
    const r = o.oldStart - 1, i = o.oldLines, a = [];
    for (const c of o.lines) {
      const l = c[0], d = c.substring(1);
      if (t) {
        if (l === "+")
          continue;
        a.push(d);
      } else
        (l === "+" || l === " ") && a.push(d);
    }
    s.splice(r, i, ...a);
  }
  return s.join(`
`);
}
const pkgConfig = {
  name: "pkg-config",
  description: "Return metainformation about installed libraries",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, [
      "cflags",
      "libs",
      "modversion",
      "version",
      "exists",
      "atleast-version",
      "exact-version",
      "max-version",
      "list-all",
      "print-errors",
      "short-errors",
      "silence-errors",
      "static",
      "print-provides",
      "print-requires"
    ]);
    if (t.version)
      return {
        stdout: `0.29.2
`,
        stderr: "",
        exitCode: 0
      };
    if (t["list-all"])
      return {
        stdout: [
          "zlib                    zlib - zlib compression library",
          "openssl                 OpenSSL - Secure Sockets Layer toolkit",
          "libcurl                 libcurl - Library for transferring data"
        ].join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    if (s.length === 0)
      return {
        stdout: "",
        stderr: `pkg-config: Must specify package names on the command line
`,
        exitCode: 1
      };
    const o = s[0];
    if (t.exists)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    if (t.modversion)
      return {
        stdout: ({
          zlib: "1.2.11",
          openssl: "1.1.1",
          libcurl: "7.68.0",
          sqlite3: "3.31.1",
          libpng: "1.6.37",
          libjpeg: "9c",
          "libxml-2.0": "2.9.10",
          "glib-2.0": "2.64.0"
        }[o] || "1.0.0") + `
`,
        stderr: "",
        exitCode: 0
      };
    if (t.cflags) {
      const i = {
        zlib: "-I/usr/include",
        openssl: "-I/usr/include/openssl",
        libcurl: "-I/usr/include/curl",
        sqlite3: "-I/usr/include",
        "glib-2.0": "-I/usr/include/glib-2.0 -I/usr/lib/glib-2.0/include"
      }[o] || "";
      return {
        stdout: i ? i + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    if (t.libs) {
      const i = {
        zlib: "-lz",
        openssl: "-lssl -lcrypto",
        libcurl: "-lcurl",
        sqlite3: "-lsqlite3",
        libpng: "-lpng",
        libjpeg: "-ljpeg",
        "libxml-2.0": "-lxml2",
        "glib-2.0": "-lglib-2.0"
      }[o] || "";
      return {
        stdout: i ? i + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    return t["print-provides"] ? {
      stdout: `${o} = 1.0.0
`,
      stderr: "",
      exitCode: 0
    } : t["print-requires"] ? {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : {
      stdout: "",
      stderr: `pkg-config: Must specify at least one option (--cflags, --libs, --modversion, etc.)
`,
      exitCode: 1
    };
  }
}, pr = {
  name: "pr",
  description: "Convert text files for printing with headers and page breaks",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, [
      "h",
      "header",
      "l",
      "length",
      "w",
      "width",
      "t",
      "omit-header",
      "d",
      "double-space",
      "n",
      "number-lines",
      "m",
      "merge",
      "s",
      "separator",
      "a",
      "across",
      "columns"
    ]), r = o.h || o.header || "", i = parseInt(o.l || o.length || "66"), a = parseInt(o.w || o.width || "72"), c = t.t || t["omit-header"], l = t.d || t["double-space"], d = t.n || t["number-lines"], u = t.m || t.merge, f = o.s || o.separator || "	", p = t.a || t.across, h = parseInt(o.columns || "1"), m = s.length > 0 ? s : ["-"];
    let g = "";
    for (const x of m) {
      let y;
      try {
        if (x === "-")
          y = e.stdin;
        else {
          const E = e.fs.resolvePath(x, e.cwd);
          y = await e.fs.readFile(E);
        }
      } catch (E) {
        return {
          stdout: "",
          stderr: `pr: ${x}: ${E instanceof Error ? E.message : String(E)}
`,
          exitCode: 1
        };
      }
      const C = y.split(`
`), S = x === "-" ? "" : x, w = (/* @__PURE__ */ new Date()).toISOString().split("T")[0], v = r || S, $ = c ? [] : [
        "",
        "",
        `${w}  ${v}  Page 1`,
        "",
        ""
      ];
      let b = [...C];
      l && (b = b.flatMap((E) => [E, ""])), d && (b = b.map((E, k) => `${(k + 1).toString().padStart(6, " ")}  ${E}`)), h > 1 ? b = formatColumns(b, h, a, f, p) : u && m.length > 1;
      const A = i - $.length - 5, I = [];
      for (let E = 0; E < b.length; E += A)
        I.push(b.slice(E, E + A));
      for (let E = 0; E < I.length; E++) {
        if (!c) {
          const k = `${w}  ${v}  Page ${E + 1}`;
          g += `

` + k + `


`;
        }
        g += I[E].join(`
`) + `
`;
      }
    }
    return {
      stdout: g,
      stderr: "",
      exitCode: 0
    };
  }
};
function formatColumns(n, e, t, s, o) {
  const r = Math.floor((t - (e - 1) * s.length) / e), i = [];
  if (o)
    for (let a = 0; a < n.length; a += e) {
      const l = n.slice(a, a + e).map((d) => d.padEnd(r).slice(0, r));
      i.push(l.join(s));
    }
  else {
    const a = Math.ceil(n.length / e);
    for (let c = 0; c < a; c++) {
      const l = [];
      for (let d = 0; d < e; d++) {
        const u = d * a + c, f = u < n.length ? n[u] : "";
        l.push(f.padEnd(r).slice(0, r));
      }
      i.push(l.join(s));
    }
  }
  return i;
}
const printenv = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n), o = s[0] || s.null;
    if (t.length === 0) {
      const r = [];
      for (const [a, c] of Object.entries(e.env))
        r.push(`${a}=${c}`);
      const i = o ? "\0" : `
`;
      return {
        stdout: r.join(i) + (r.length > 0 ? i : ""),
        stderr: "",
        exitCode: 0
      };
    } else {
      const r = [];
      for (const a of t)
        if (a in e.env)
          r.push(e.env[a]);
        else
          return {
            stdout: "",
            stderr: "",
            exitCode: 1
          };
      const i = o ? "\0" : `
`;
      return {
        stdout: r.join(i) + (r.length > 0 ? i : ""),
        stderr: "",
        exitCode: 0
      };
    }
  }
}, printf = {
  name: "printf",
  description: "Format and print data",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const e = n[0], t = n.slice(1);
    let s = 0, o = "", r = 0;
    for (; r < e.length; )
      if (e[r] === "\\") {
        switch (r++, e[r]) {
          case "n":
            o += `
`;
            break;
          case "t":
            o += "	";
            break;
          case "\\":
            o += "\\";
            break;
          case '"':
            o += '"';
            break;
          default:
            o += "\\" + (e[r] ?? "");
            break;
        }
        r++;
      } else if (e[r] === "%")
        if (r++, e[r] === "%")
          o += "%", r++;
        else {
          let i = "";
          for (; r < e.length && !/[sdf]/.test(e[r]); )
            i += e[r], r++;
          const a = e[r] ?? "s";
          r++;
          const c = t[s++] ?? "";
          switch (a) {
            case "s":
              o += c;
              break;
            case "d":
              o += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = i.includes(".") ? parseInt(i.split(".")[1], 10) : 6;
              o += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        o += e[r], r++;
    return { stdout: o, stderr: "", exitCode: 0 };
  }
}, processSubstitution = {
  name: "process-substitution",
  description: "Helper for process substitution (shell feature)",
  async exec(n, e) {
    return {
      stdout: `process-substitution: This is a shell language feature, not a command.

Process substitution must be implemented at the shell parser level:

Syntax:
  <(command)  # Input substitution - command output as input file
  >(command)  # Output substitution - command input as output file

Input Substitution <(command):
  diff <(sort file1.txt) <(sort file2.txt)

  Shell implementation:
  1. Execute "sort file1.txt" in subshell
  2. Capture output to temporary file or named pipe
  3. Replace <(sort file1.txt) with the temp file path
  4. Run: diff /tmp/subst123 /tmp/subst124
  5. Clean up temp files after diff completes

Output Substitution >(command):
  echo "data" | tee >(process1) >(process2) > output.txt

  Shell implementation:
  1. Create named pipes or temporary files
  2. Start "process1" and "process2" in background reading from pipes
  3. Replace >(process1) with pipe paths
  4. Connect tee output to the pipes
  5. Wait for processes and clean up

Common Use Cases:
  # Compare outputs of two commands
  diff <(ls dir1) <(ls dir2)

  # Multiple outputs
  command | tee >(grep error > errors.log) >(grep warning > warnings.log)

  # Input from multiple sources
  paste <(cut -f1 file1) <(cut -f2 file2)

  # Avoid temporary files
  while read line; do
    echo "$line"
  done < <(find . -type f)

Implementation Steps for Shells:
1. Lexer: Recognize <( and >( as special tokens
2. Parser: Extract command from parentheses
3. Executor:
   a. For <(cmd):
      - Execute cmd, capture stdout
      - Write to temp file (or create named pipe)
      - Return path to temp file
   b. For >(cmd):
      - Create named pipe or temp file
      - Start cmd with stdin from the pipe
      - Return path to the pipe
4. Substitution: Replace in command line with file path
5. Cleanup: Remove temp files/pipes after main command exits

Browser Implementation Notes:
- Named pipes (FIFOs) aren't available in browser
- Use temporary files in virtual filesystem
- For >(cmd), write to temp file then pass to command
- Ensure proper ordering of operations

Example Pseudo-code:
  if (token matches /<\\((.+)\\)/) {
    const cmd = extractCommand(token);
    const output = await executeCommand(cmd);
    const tempPath = createTempFile(output);
    replaceToken(token, tempPath);
    scheduleCleanup(tempPath);
  }

Shell implementers: Parse at lexer/parser level, execute before main command.

`,
      stderr: "",
      exitCode: 0
    };
  }
}, pwd = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, e) {
    return { stdout: e.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, read = {
  name: "read",
  description: "Read a line from stdin into variables",
  async exec(n, e) {
    var l;
    const { positional: t, flags: s, values: o } = parseArgs(n, ["r", "p", "n", "t", "d", "a", "s"]);
    let r = e.stdin || "";
    o.p;
    const i = o.d || `
`, a = o.n ? parseInt(o.n) : void 0;
    let c;
    if (a !== void 0)
      c = r.slice(0, a);
    else {
      const d = r.indexOf(i);
      d >= 0 ? c = r.slice(0, d) : c = r;
    }
    if (s.r || (c = c.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\")), t.length === 0)
      e.env && (e.env.REPLY = c);
    else if (t.length === 1)
      e.env && (e.env[t[0]] = c);
    else {
      const d = ((l = e.env) == null ? void 0 : l.IFS) || ` 	
`, u = new RegExp(`[${d.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&")}]+`), f = c.split(u).filter((p) => p);
      for (let p = 0; p < t.length; p++) {
        const h = t[p];
        p < t.length - 1 ? e.env && (e.env[h] = f[p] || "") : e.env && (e.env[h] = f.slice(p).join(" "));
      }
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, readlink = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const r = e.fs.resolvePath(s[0], e.cwd);
    return o ? { stdout: r + `
`, stderr: "", exitCode: 0 } : { stdout: r + `
`, stderr: "", exitCode: 0 };
  }
}, realpath = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const o = t.q || t.quiet, r = !t.s;
    t.s;
    const i = [], a = [];
    for (const d of s)
      try {
        let u = e.fs.resolvePath(d, e.cwd);
        if (r) {
          const f = u.split("/").filter((h) => h !== "" && h !== "."), p = [];
          for (const h of f)
            h === ".." ? p.length > 0 && p.pop() : p.push(h);
          u = "/" + p.join("/");
        }
        await e.fs.exists(u) ? i.push(u) : o || a.push(`realpath: ${d}: No such file or directory`);
      } catch (u) {
        o || a.push(`realpath: ${d}: ${u instanceof Error ? u.message : u}`);
      }
    const c = a.length > 0 ? a.join(`
`) + `
` : "", l = a.length > 0 ? 1 : 0;
    return {
      stdout: i.join(`
`) + (i.length > 0 ? `
` : ""),
      stderr: c,
      exitCode: l
    };
  }
}, returnCmd = {
  name: "return",
  description: "Return from a shell function",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? parseInt(t[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, rm = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.r || t.R, r = t.f;
    if (s.length === 0 && !r)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function i(a) {
      const c = await e.fs.readdir(a);
      for (const l of c) {
        const d = a + "/" + l.name;
        l.type === "dir" ? await i(d) : await e.fs.unlink(d);
      }
      await e.fs.rmdir(a);
    }
    try {
      for (const a of s) {
        const c = e.fs.resolvePath(a, e.cwd);
        let l;
        try {
          l = await e.fs.stat(c);
        } catch {
          if (r) continue;
          return { stdout: "", stderr: `rm: cannot remove '${a}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `rm: cannot remove '${a}': Is a directory
`, exitCode: 1 };
          await i(c);
        } else
          await e.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return r ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, sed = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.i, r = s.shift();
    if (!r)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const i = r.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!i)
      return { stdout: "", stderr: `sed: unsupported expression: ${r}
`, exitCode: 1 };
    const [, , a, c, l] = i, d = l.includes("g"), u = l.includes("i");
    let f;
    try {
      const p = (d ? "g" : "") + (u ? "i" : "");
      f = new RegExp(a, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${a}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: h } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), m = p.split(`
`).map((g) => g.replace(f, c)).join(`
`);
      if (o && h.length > 0) {
        for (const g of h) {
          const x = e.fs.resolvePath(g, e.cwd), C = (await e.fs.readFile(x)).split(`
`).map((S) => S.replace(f, c)).join(`
`);
          await e.fs.writeFile(x, C);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, seq = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["separator", "s", "format", "f"]);
    if (o.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let r = 1, i = 1, a;
    if (o.length === 1 ? a = parseFloat(o[0]) : o.length === 2 ? (r = parseFloat(o[0]), a = parseFloat(o[1])) : o.length >= 3 ? (r = parseFloat(o[0]), i = parseFloat(o[1]), a = parseFloat(o[2])) : a = 1, isNaN(r) || isNaN(i) || isNaN(a))
      return {
        stdout: "",
        stderr: `seq: invalid number
`,
        exitCode: 1
      };
    if (i === 0)
      return {
        stdout: "",
        stderr: `seq: increment must not be 0
`,
        exitCode: 1
      };
    const c = s.s || s.separator || `
`, l = s.f || s.format, d = t.w, u = [];
    if (i > 0)
      for (let h = r; h <= a; h += i)
        u.push(String(h));
    else
      for (let h = r; h >= a; h += i)
        u.push(String(h));
    if (d) {
      const h = Math.max(...u.map((m) => m.length));
      for (let m = 0; m < u.length; m++)
        u[m] = u[m].padStart(h, "0");
    }
    if (l && typeof l == "string")
      for (let h = 0; h < u.length; h++) {
        const m = parseFloat(u[h]);
        l.includes("%g") || l.includes("%d") || l.includes("%i") ? u[h] = l.replace(/%[gdi]/, String(m)) : l.includes("%f") ? u[h] = l.replace(/%f/, m.toFixed(6)) : l.includes("%e") && (u[h] = l.replace(/%e/, m.toExponential()));
      }
    return {
      stdout: u.join(c) + ((typeof c == "string" ? c : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, set = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["e", "u", "x", "v", "n", "o"]);
    if (n.length === 0) {
      const r = Object.entries(e.env || {}).map(([i, a]) => `${i}=${a}`).join(`
`);
      return {
        stdout: r ? r + `
` : "",
        stderr: "",
        exitCode: 0
      };
    }
    if (t.o || s.o) {
      const r = s.o || o[0], i = [
        "pipefail",
        "errexit",
        "nounset",
        "xtrace",
        "verbose",
        "noclobber",
        "noglob",
        "ignoreeof",
        "monitor",
        "posix"
      ];
      return r ? i.includes(r) ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `set: ${r}: invalid option name
`,
        exitCode: 1
      } : {
        stdout: i.map((a) => `${a}		off`).join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    }
    return t.e, t.u, t.x, t.v, t.n, {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, sha256sum = {
  name: "sha256sum",
  description: "Compute SHA256 message digest",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.c || t.check, r = t.b || t.binary;
    if (o)
      return {
        stdout: "",
        stderr: `sha256sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const i = s.length > 0 ? s : ["-"], a = [];
    try {
      for (const c of i) {
        let l;
        if (c === "-")
          l = e.stdin;
        else {
          const f = e.fs.resolvePath(c, e.cwd);
          l = await e.fs.readFile(f);
        }
        const d = await sha256(l), u = r ? "*" : " ";
        a.push(`${d}${u}${c === "-" ? "-" : c}`);
      }
      return {
        stdout: a.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `sha256sum: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
};
async function sha256(n) {
  const e = globalThis;
  if (typeof e.crypto < "u" && e.crypto.subtle) {
    const o = new e.TextEncoder().encode(n), r = await e.crypto.subtle.digest("SHA-256", o);
    return Array.from(new e.Uint8Array(r)).map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  let t = 0;
  for (let s = 0; s < n.length; s++) {
    const o = n.charCodeAt(s);
    t = (t << 5) - t + o, t = t & t;
  }
  return Math.abs(t).toString(16).padStart(64, "0");
}
const shift = {
  name: "shift",
  description: "Shift positional parameters",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? parseInt(t[0]) : 1;
    return isNaN(s) || s < 0 ? {
      stdout: "",
      stderr: `shift: numeric argument required
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, sleep = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(n, e) {
    const { positional: t } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `sleep: missing operand
`, exitCode: 1 };
    const s = t[0];
    let o = 0;
    const r = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
    if (!r)
      return {
        stdout: "",
        stderr: `sleep: invalid time interval '${s}'
`,
        exitCode: 1
      };
    const i = parseFloat(r[1]);
    switch (r[2] || "s") {
      case "s":
        o = i;
        break;
      case "m":
        o = i * 60;
        break;
      case "h":
        o = i * 3600;
        break;
      case "d":
        o = i * 86400;
        break;
    }
    return await new Promise((c) => globalThis.setTimeout(c, o * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, sort = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    try {
      const { content: o } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let r = o.split(`
`).filter(Boolean);
      return t.n ? r.sort((i, a) => parseFloat(i) - parseFloat(a)) : r.sort(), t.u && (r = [...new Set(r)]), t.r && r.reverse(), { stdout: r.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `sort: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, source = {
  name: "source",
  description: "Execute commands from a file in the current shell",
  async exec(n, e) {
    const { positional: t } = parseArgs(n);
    if (t.length === 0)
      return {
        stdout: "",
        stderr: `source: filename argument required
`,
        exitCode: 1
      };
    const s = t[0];
    try {
      const o = e.fs.resolvePath(s, e.cwd), r = await e.fs.readFile(o);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    } catch (o) {
      return {
        stdout: "",
        stderr: `source: ${s}: ${o instanceof Error ? o.message : o}
`,
        exitCode: 1
      };
    }
  }
}, dot = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(n, e) {
    return source.exec(n, e);
  }
}, stat = {
  name: "stat",
  description: "Display file status",
  async exec(n, e) {
    const { positional: t, flags: s, values: o } = parseArgs(n, ["c", "format"]);
    if (t.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const r = o.c || o.format, i = s.t;
    s.f;
    const a = [];
    try {
      for (const c of t) {
        const l = e.fs.resolvePath(c, e.cwd);
        try {
          const d = await e.fs.stat(l);
          if (r) {
            const u = formatStat(c, d, r);
            a.push(u);
          } else if (i)
            a.push(`${c} ${d.size} 0 ${d.mode} 0 0 0 0 0 0 ${d.mtime}`);
          else {
            const u = d.type === "dir" ? "directory" : "regular file", f = formatMode(d.mode), p = new Date(d.mtime).toISOString();
            a.push(`  File: ${c}`), a.push(`  Size: ${d.size}	Blocks: 0	IO Block: 4096	${u}`), a.push("Device: 0	Inode: 0	Links: 1"), a.push(`Access: (${f})	Uid: (0/root)	Gid: (0/root)`), a.push(`Access: ${p}`), a.push(`Modify: ${p}`), a.push(`Change: ${p}`);
          }
        } catch (d) {
          a.push(`stat: cannot stat '${c}': ${d instanceof Error ? d.message : d}`);
        }
      }
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `stat: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
};
function formatMode(n) {
  const e = [
    n & 256 ? "r" : "-",
    n & 128 ? "w" : "-",
    n & 64 ? "x" : "-",
    n & 32 ? "r" : "-",
    n & 16 ? "w" : "-",
    n & 8 ? "x" : "-",
    n & 4 ? "r" : "-",
    n & 2 ? "w" : "-",
    n & 1 ? "x" : "-"
  ].join("");
  return `0${n.toString(8)}/${e}`;
}
function formatStat(n, e, t) {
  return t.replace(/%n/g, n).replace(/%N/g, `'${n}'`).replace(/%s/g, String(e.size)).replace(/%b/g, "0").replace(/%f/g, e.mode.toString(16)).replace(/%a/g, e.mode.toString(8)).replace(/%A/g, formatMode(e.mode).split("/")[1]).replace(/%F/g, e.type === "dir" ? "directory" : "regular file").replace(/%u/g, "0").replace(/%g/g, "0").replace(/%U/g, "root").replace(/%G/g, "root").replace(/%i/g, "0").replace(/%h/g, "1").replace(/%W/g, String(Math.floor(e.mtime / 1e3))).replace(/%X/g, String(Math.floor(e.mtime / 1e3))).replace(/%Y/g, String(Math.floor(e.mtime / 1e3))).replace(/%y/g, new Date(e.mtime).toISOString()).replace(/%%/g, "%");
}
const strings = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["n", "bytes"]), r = parseInt(t.n || t.bytes || "4", 10), i = o.f;
    o.a;
    try {
      const a = s.length > 0 ? s : ["-"], c = [];
      for (const l of a) {
        let d, u = l;
        if (l === "-")
          d = e.stdin, u = "(standard input)";
        else {
          const p = e.fs.resolvePath(l, e.cwd);
          d = await e.fs.readFile(p);
        }
        const f = extractStrings(d, r);
        for (const p of f)
          i ? c.push(`${u}: ${p}`) : c.push(p);
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `strings: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
function extractStrings(n, e) {
  const t = [], s = /[ -~]/;
  let o = "";
  for (let r = 0; r < n.length; r++) {
    const i = n[r];
    s.test(i) ? o += i : (o.length >= e && t.push(o), o = "");
  }
  return o.length >= e && t.push(o), t;
}
const tail = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, e) {
    const { values: t, positional: s } = parseArgs(n, ["n"]), o = parseInt(t.n ?? "10", 10);
    try {
      const { content: r } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: r.split(`
`).slice(-o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `tail: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, tar = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["f", "C"]), r = t.c || t.create, i = t.x || t.extract, a = t.t || t.list, c = t.v || t.verbose, l = s.f, d = s.C;
    let u = e.cwd;
    d && (u = e.fs.resolvePath(d, e.cwd));
    const f = [r, i, a].filter(Boolean).length;
    if (f === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (f > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (r) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = o;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const h = [];
        async function m(C, S) {
          const w = e.fs.resolvePath(C, u);
          if ((await e.fs.stat(w)).type === "dir") {
            h.push({ path: S + "/", content: "", isDir: !0 });
            const $ = await e.fs.readdir(w);
            for (const b of $)
              await m(w + "/" + b.name, S + "/" + b.name);
          } else {
            const $ = await e.fs.readFile(w);
            h.push({ path: S, content: $, isDir: !1 });
          }
        }
        for (const C of p)
          await m(C, C);
        const g = ["FLUFFY-TAR-V1"];
        for (const C of h)
          c && console.error(C.path), g.push(`FILE:${C.path}`), g.push(`SIZE:${C.content.length}`), g.push(`TYPE:${C.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(C.content), g.push("DATA-END");
        const x = g.join(`
`), y = e.fs.resolvePath(l, e.cwd);
        return await e.fs.writeFile(y, x), {
          stdout: c ? h.map((C) => C.path).join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (i) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = e.fs.resolvePath(l, e.cwd), m = (await e.fs.readFile(p)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let g = 1;
        const x = [];
        for (; g < m.length && m[g].startsWith("FILE:"); ) {
          const y = m[g].slice(5), C = parseInt(m[g + 1].slice(5), 10), S = m[g + 2].slice(5);
          g += 4;
          const w = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            w.push(m[g]), g++;
          const v = w.join(`
`);
          g++;
          const $ = e.fs.resolvePath(y, u);
          if (S === "dir")
            await e.fs.mkdir($, { recursive: !0 });
          else {
            const b = $.lastIndexOf("/");
            if (b > 0) {
              const A = $.slice(0, b);
              try {
                await e.fs.mkdir(A, { recursive: !0 });
              } catch {
              }
            }
            await e.fs.writeFile($, v);
          }
          x.push(y), c && console.error(y);
        }
        return {
          stdout: c ? x.join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (a) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = e.fs.resolvePath(l, e.cwd), m = (await e.fs.readFile(p)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        const g = [];
        for (let x = 1; x < m.length; x++)
          m[x].startsWith("FILE:") && g.push(m[x].slice(5));
        return { stdout: g.join(`
`) + `
`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `tar: Unknown error
`, exitCode: 1 };
    } catch (p) {
      return {
        stdout: "",
        stderr: `tar: ${p instanceof Error ? p.message : p}
`,
        exitCode: 1
      };
    }
  }
}, tee = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.a, r = e.stdin;
    try {
      for (const i of s) {
        const a = e.fs.resolvePath(i, e.cwd);
        if (o) {
          let c = "";
          try {
            c = await e.fs.readFile(a);
          } catch {
          }
          await e.fs.writeFile(a, c + r);
        } else
          await e.fs.writeFile(a, r);
      }
      return { stdout: r, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: r, stderr: `tee: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, test = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(n, e) {
    const t = n[n.length - 1] === "]" ? n.slice(0, -1) : [...n];
    try {
      return { stdout: "", stderr: "", exitCode: await evaluate(t, e) ? 0 : 1 };
    } catch (s) {
      return { stdout: "", stderr: `test: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
};
async function evaluate(n, e) {
  var o, r;
  if (n.length === 0) return !1;
  if (n.length === 1) return n[0] !== "";
  if (n.length === 2) {
    const [i, a] = n;
    switch (i) {
      // String tests
      case "-z":
        return a === "";
      case "-n":
        return a !== "";
      case "!":
        return a === "";
      // File existence and type tests
      case "-e":
      case "-f":
      case "-d":
      case "-L":
      case "-h":
      case "-S":
      case "-p":
      case "-b":
      case "-c":
        try {
          const c = e.fs.resolvePath(a, e.cwd), l = await e.fs.stat(c);
          return i === "-f" ? l.type === "file" : i === "-d" ? l.type === "dir" : i === "-L" || i === "-h" ? l.type === "symlink" : i === "-S" ? l.type === "socket" : i === "-p" ? l.type === "fifo" : i === "-b" ? l.type === "block" : i === "-c" ? l.type === "char" : !0;
        } catch {
          return !1;
        }
      // File permissions (simplified - always return false in browser)
      case "-r":
      case "-w":
      case "-x":
      case "-s":
      case "-u":
      case "-g":
      case "-k":
        try {
          const c = e.fs.resolvePath(a, e.cwd);
          if (await e.fs.stat(c), i === "-s")
            try {
              const l = await ((r = (o = e.fs).readFile) == null ? void 0 : r.call(o, c));
              return l && l.length > 0;
            } catch {
              return !1;
            }
          return i === "-r" || i === "-w";
        } catch {
          return !1;
        }
      // Terminal tests (always false in browser)
      case "-t":
        return !1;
    }
  }
  if (n[0] === "!" && n.length > 1)
    return !await evaluate(n.slice(1), e);
  if (n.length === 3) {
    const [i, a, c] = n;
    switch (a) {
      case "=":
      case "==":
        return i === c;
      case "!=":
        return i !== c;
      case "-eq":
        return parseInt(i) === parseInt(c);
      case "-ne":
        return parseInt(i) !== parseInt(c);
      case "-lt":
        return parseInt(i) < parseInt(c);
      case "-le":
        return parseInt(i) <= parseInt(c);
      case "-gt":
        return parseInt(i) > parseInt(c);
      case "-ge":
        return parseInt(i) >= parseInt(c);
    }
  }
  const t = n.indexOf("-a");
  if (t > 0)
    return await evaluate(n.slice(0, t), e) && await evaluate(n.slice(t + 1), e);
  const s = n.indexOf("-o");
  return s > 0 ? await evaluate(n.slice(0, s), e) || await evaluate(n.slice(s + 1), e) : !1;
}
const time = {
  name: "time",
  description: "Time a command execution",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const o = s.v || s.verbose, r = s.p, i = t.join(" "), a = globalThis.performance, c = a ? a.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const u = ((a ? a.now() : Date.now()) - c) / 1e3, f = Math.floor(u / 60), p = u % 60;
    let h;
    return r ? h = `real ${u.toFixed(2)}
user 0.00
sys 0.00
` : o ? h = `        ${u.toFixed(3)} real         0.000 user         0.000 sys
` : h = `
real    ${f}m${p.toFixed(3)}s
user    0m0.000s
sys     0m0.000s
`, {
      stdout: "",
      stderr: `Command: ${i}
${h}`,
      exitCode: 0
    };
  }
}, timeout = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(n, e) {
    const { positional: t, flags: s, values: o } = parseArgs(n, ["k", "kill-after", "s", "signal"]);
    if (t.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const r = t[0], i = t.slice(1);
    if (i.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let a = parseDuration(r);
    if (a === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${r}'
`,
        exitCode: 1
      };
    o.k || o["kill-after"];
    const c = o.s || o.signal || "TERM", l = s["preserve-status"];
    s.foreground;
    const d = s.v || s.verbose;
    try {
      const u = i.join(" ");
      if (d)
        return {
          stdout: "",
          stderr: `timeout: would run command '${u}' with ${a}s timeout using signal ${c}
`,
          exitCode: 0
        };
      const f = a * 1e3;
      let p = !1;
      if (await new Promise((h) => {
        const m = globalThis.setTimeout(() => {
          p = !0, h(null);
        }, f);
        globalThis.clearTimeout(m), h(null);
      }), p) {
        const h = l ? 143 : 124;
        return {
          stdout: "",
          stderr: `timeout: command '${u}' timed out after ${a}s
`,
          exitCode: h
        };
      }
      return {
        stdout: `Command: ${u}
`,
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `timeout: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
};
function parseDuration(n) {
  const e = n.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!e) return null;
  const t = parseFloat(e[1]);
  switch (e[2] || "s") {
    case "s":
      return t;
    case "m":
      return t * 60;
    case "h":
      return t * 3600;
    case "d":
      return t * 86400;
    default:
      return null;
  }
}
const touch = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    const o = s.c;
    try {
      for (const r of t) {
        const i = e.fs.resolvePath(r, e.cwd);
        let a = !1;
        try {
          await e.fs.stat(i), a = !0;
        } catch {
          a = !1;
        }
        if (a) {
          const c = await e.fs.readFile(i);
          await e.fs.writeFile(i, c);
        } else {
          if (o)
            continue;
          await e.fs.writeFile(i, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `touch: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, tr = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, []), o = t.d, r = t.s, i = t.c || t.C, a = t.t;
    let c = expandSet(s[0] ?? ""), l = expandSet(s[1] ?? "");
    const d = e.stdin;
    i && c && (c = getComplement(c)), a && l && (c = c.slice(0, l.length));
    let u;
    if (o) {
      const f = new Set(c.split(""));
      u = d.split("").filter((p) => !f.has(p)).join("");
    } else if (c && l) {
      const f = /* @__PURE__ */ new Map();
      for (let p = 0; p < c.length; p++)
        f.set(c[p], l[Math.min(p, l.length - 1)]);
      u = d.split("").map((p) => f.get(p) ?? p).join("");
    } else
      u = d;
    if (r) {
      const f = l ? new Set(l.split("")) : c ? new Set(c.split("")) : null;
      if (f) {
        let p = "", h = "";
        for (const m of u)
          f.has(m) && m === h || (p += m, h = m);
        u = p;
      }
    }
    return { stdout: u, stderr: "", exitCode: 0 };
  }
};
function expandSet(n) {
  let e = n;
  e = e.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), e = e.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), e = e.replace(/\[:digit:\]/g, "0123456789"), e = e.replace(/\[:space:\]/g, ` 	
\r`), e = e.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), e = e.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"), e = e.replace(/\[:punct:\]/g, "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"), e = e.replace(/\[:print:\]/g, " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~");
  let t = "", s = 0;
  for (; s < e.length; )
    if (s + 2 < e.length && e[s + 1] === "-") {
      const o = e.charCodeAt(s), r = e.charCodeAt(s + 2);
      for (let i = o; i <= r; i++)
        t += String.fromCharCode(i);
      s += 3;
    } else
      t += e[s], s++;
  return t;
}
function getComplement(n) {
  const e = new Set(n.split(""));
  let t = "";
  for (let s = 9; s <= 126; s++)
    if (s === 9 || s === 10 || s === 13 || s >= 32 && s <= 126) {
      const o = String.fromCharCode(s);
      e.has(o) || (t += o);
    }
  return t;
}
const trap = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["l", "p"]);
    return t.l ? {
      stdout: [
        "EXIT",
        "HUP",
        "INT",
        "QUIT",
        "ILL",
        "TRAP",
        "ABRT",
        "BUS",
        "FPE",
        "KILL",
        "USR1",
        "SEGV",
        "USR2",
        "PIPE",
        "ALRM",
        "TERM",
        "STKFLT",
        "CHLD",
        "CONT",
        "STOP",
        "TSTP",
        "TTIN",
        "TTOU",
        "URG",
        "XCPU",
        "XFSZ",
        "VTALRM",
        "PROF",
        "WINCH",
        "IO",
        "PWR",
        "SYS",
        "ERR",
        "DEBUG",
        "RETURN"
      ].map((i, a) => `${a}) SIG${i}`).join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    } : t.p ? s.length === 0 ? {
      stdout: `# Trap handlers would be listed here
`,
      stderr: "",
      exitCode: 0
    } : {
      stdout: s.map((r) => `# trap for ${r} would be shown here`).join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    } : s.length === 0 ? {
      stdout: "",
      stderr: `trap: usage: trap [-lp] [ACTION] [SIGNAL...]
`,
      exitCode: 1
    } : (s[0], s.slice(1).length === 0 ? {
      stdout: "",
      stderr: `trap: usage: trap ACTION SIGNAL...
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    });
  }
}, kill = {
  name: "kill",
  description: "Send signal to process",
  async exec(n, e) {
    const { flags: t, values: s, positional: o } = parseArgs(n, ["l", "L", "s"]);
    if (t.l || t.L) {
      const i = [
        "HUP",
        "INT",
        "QUIT",
        "ILL",
        "TRAP",
        "ABRT",
        "BUS",
        "FPE",
        "KILL",
        "USR1",
        "SEGV",
        "USR2",
        "PIPE",
        "ALRM",
        "TERM",
        "STKFLT",
        "CHLD",
        "CONT",
        "STOP",
        "TSTP",
        "TTIN",
        "TTOU",
        "URG",
        "XCPU",
        "XFSZ",
        "VTALRM",
        "PROF",
        "WINCH",
        "IO",
        "PWR",
        "SYS"
      ];
      return t.L ? {
        stdout: i.map((a, c) => `${c + 1}) SIG${a}`).join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: i.join(" ") + `
`,
        stderr: "",
        exitCode: 0
      };
    }
    const r = s.s || "TERM";
    return o.length === 0 ? {
      stdout: "",
      stderr: `kill: usage: kill [-s SIGNAL] PID...
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: `kill: sending signal ${r} to processes: ${o.join(", ")}
`,
      exitCode: 0
    };
  }
}, trueCmd = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, tsort = {
  name: "tsort",
  description: "Perform topological sort",
  async exec(n, e) {
    const t = n.length > 0 ? n : ["-"];
    let s;
    try {
      if (t[0] === "-" || t.length === 0)
        s = e.stdin;
      else {
        const d = e.fs.resolvePath(t[0], e.cwd);
        s = await e.fs.readFile(d);
      }
    } catch (d) {
      return {
        stdout: "",
        stderr: `tsort: ${t[0]}: ${d instanceof Error ? d.message : String(d)}
`,
        exitCode: 1
      };
    }
    const o = s.trim().split(/\s+/).filter(Boolean);
    if (o.length % 2 !== 0)
      return {
        stdout: "",
        stderr: `tsort: odd number of tokens
`,
        exitCode: 1
      };
    const r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Set();
    for (let d = 0; d < o.length; d += 2) {
      const u = o[d], f = o[d + 1];
      a.add(u), a.add(f), r.has(u) || r.set(u, /* @__PURE__ */ new Set()), r.get(u).add(f);
    }
    for (const d of a)
      i.has(d) || i.set(d, 0);
    for (const [d, u] of r)
      for (const f of u)
        i.set(f, (i.get(f) || 0) + 1);
    const c = [], l = [];
    for (const [d, u] of i)
      u === 0 && c.push(d);
    for (c.sort(); c.length > 0; ) {
      c.sort();
      const d = c.shift();
      l.push(d);
      const u = r.get(d);
      if (u)
        for (const f of u) {
          const p = i.get(f) - 1;
          i.set(f, p), p === 0 && c.push(f);
        }
    }
    return l.length !== a.size ? {
      stdout: "",
      stderr: `tsort: cycle detected
`,
      exitCode: 1
    } : {
      stdout: l.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, type = {
  name: "type",
  description: "Display information about command type",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    if (t.length === 0)
      return { stdout: "", stderr: `type: missing operand
`, exitCode: 1 };
    const o = s.a, r = s.t, i = s.p, a = [];
    let c = 0;
    for (const l of t) {
      const d = (e.env.PATH || "/bin:/usr/bin").split(":");
      let u = !1;
      for (const f of d) {
        const p = f + "/" + l;
        try {
          if (await e.fs.exists(p) && (u = !0, r ? a.push("file") : i ? a.push(p) : a.push(`${l} is ${p}`), !o))
            break;
        } catch {
        }
      }
      u || (!r && !i && a.push(`type: ${l}: not found`), c = 1);
    }
    return {
      stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: c
    };
  }
}, ulimit = {
  name: "ulimit",
  description: "Control user resource limits",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, [
      "S",
      "soft",
      "H",
      "hard",
      "a",
      "all",
      "c",
      "core-size",
      "d",
      "data-size",
      "f",
      "file-size",
      "l",
      "lock-memory",
      "m",
      "memory-size",
      "n",
      "open-files",
      "s",
      "stack-size",
      "t",
      "cpu-time",
      "u",
      "user-processes",
      "v",
      "virtual-memory"
    ]);
    t.S || t.soft, t.H || t.hard;
    const o = t.a || t.all, r = {
      "core file size": { value: "unlimited", unit: "blocks" },
      "data seg size": { value: "unlimited", unit: "kbytes" },
      "file size": { value: "unlimited", unit: "blocks" },
      "max locked memory": { value: "unlimited", unit: "kbytes" },
      "max memory size": { value: "unlimited", unit: "kbytes" },
      "open files": { value: "1024", unit: "" },
      "stack size": { value: "8192", unit: "kbytes" },
      "cpu time": { value: "unlimited", unit: "seconds" },
      "max user processes": { value: "2048", unit: "" },
      "virtual memory": { value: "unlimited", unit: "kbytes" }
    };
    if (o)
      return {
        stdout: Object.entries(r).map(([l, { value: d, unit: u }]) => {
          const f = u ? ` (${u})` : "";
          return `${l}${f.padEnd(25 - l.length)} ${d}`;
        }).join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    let i = null;
    t.c || t["core-size"] ? i = "core file size" : t.d || t["data-size"] ? i = "data seg size" : t.f || t["file-size"] ? i = "file size" : t.l || t["lock-memory"] ? i = "max locked memory" : t.m || t["memory-size"] ? i = "max memory size" : t.n || t["open-files"] ? i = "open files" : t.s || t["stack-size"] ? i = "stack size" : t.t || t["cpu-time"] ? i = "cpu time" : t.u || t["user-processes"] ? i = "max user processes" : (t.v || t["virtual-memory"]) && (i = "virtual memory"), i || (i = "file size");
    const a = r[i];
    if (!a)
      return {
        stdout: "",
        stderr: `ulimit: invalid resource
`,
        exitCode: 1
      };
    if (s.length > 0) {
      const c = s[0];
      return c !== "unlimited" && isNaN(parseInt(c)) ? {
        stdout: "",
        stderr: `ulimit: ${c}: invalid number
`,
        exitCode: 1
      } : {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    return {
      stdout: a.value + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, umask = {
  name: "umask",
  description: "Set or display file creation mask",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, ["S", "p"]), o = t.S, r = t.p, i = "0022";
    if (s.length === 0)
      if (o) {
        const c = parseInt(i, 8);
        return {
          stdout: maskToSymbolic(c) + `
`,
          stderr: "",
          exitCode: 0
        };
      } else return r ? {
        stdout: `umask ${i}
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: i + `
`,
        stderr: "",
        exitCode: 0
      };
    const a = s[0];
    return /^[0-7]{3,4}$/.test(a) ? {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : /^[ugoa]*[+-=][rwxXst]*$/.test(a) ? {
      stdout: "",
      stderr: "",
      exitCode: 0
    } : {
      stdout: "",
      stderr: `umask: ${a}: invalid symbolic mode
`,
      exitCode: 1
    };
  }
};
function maskToSymbolic(n) {
  const e = 511 & ~n, t = e >> 6 & 7, s = e >> 3 & 7, o = e & 7, r = (i) => (i & 4 ? "r" : "-") + (i & 2 ? "w" : "-") + (i & 1 ? "x" : "-");
  return `u=${r(t)},g=${r(s)},o=${r(o)}`;
}
const unalias = {
  name: "unalias",
  description: "Remove alias definitions",
  async exec(n, e) {
    const { positional: t, flags: s } = parseArgs(n);
    return t.length === 0 && !s.a ? {
      stdout: "",
      stderr: `unalias: usage: unalias [-a] name [name ...]
`,
      exitCode: 2
    } : {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, unexpand = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, ["t", "tabs"]), r = t.t || t.tabs || "8", i = parseInt(r, 10);
    if (isNaN(i) || i <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${r}'
`,
        exitCode: 1
      };
    const a = o.a || o.all;
    try {
      const { content: c } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), l = c.split(`
`), d = [];
      for (const u of l) {
        let f = "", p = 0, h = 0;
        for (let m = 0; m < u.length; m++) {
          const g = u[m];
          g === " " ? (h++, p++, p % i === 0 && (a || f.trim() === "" ? (h >= i && (f += "	".repeat(Math.floor(h / i)), h = h % i), h > 0 && (f += " ".repeat(h), h = 0)) : (f += " ".repeat(h), h = 0))) : (h > 0 && (f += " ".repeat(h), h = 0), f += g, p++);
        }
        h > 0 && (f += " ".repeat(h)), d.push(f);
      }
      return {
        stdout: d.join(`
`) + (c.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (c) {
      return {
        stdout: "",
        stderr: `unexpand: ${c instanceof Error ? c.message : c}
`,
        exitCode: 1
      };
    }
  }
}, uniq = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, ["f", "s", "w"]), r = o.f ? parseInt(o.f) : 0, i = o.s ? parseInt(o.s) : 0, a = o.w ? parseInt(o.w) : void 0, c = t.i;
    try {
      const { content: l } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), d = l.split(`
`);
      d.length > 0 && d[d.length - 1] === "" && d.pop();
      const u = [];
      let f = "", p = "", h = 0;
      for (const m of d) {
        const g = getComparisonKey(m, r, i, a, c);
        g === p ? h++ : (h > 0 && emitLine(f, h, t, u), f = m, p = g, h = 1);
      }
      return h > 0 && emitLine(f, h, t, u), { stdout: u.join(`
`) + (u.length > 0 ? `
` : ""), stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `uniq: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
};
function getComparisonKey(n, e, t, s, o) {
  let r = n;
  return e > 0 && (r = n.split(/\s+/).slice(e).join(" ")), t > 0 && (r = r.substring(t)), s !== void 0 && (r = r.substring(0, s)), o && (r = r.toLowerCase()), r;
}
function emitLine(n, e, t, s) {
  t.d && e < 2 || t.u && e > 1 || (t.c ? s.push(`${String(e).padStart(7)} ${n}`) : s.push(n));
}
const uname = {
  name: "uname",
  description: "Print system information",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.a, o = e.env.UNAME_SYSNAME ?? "FluffyOS", r = e.env.HOSTNAME ?? "localhost", i = e.env.UNAME_RELEASE ?? "1.0.0", a = e.env.UNAME_VERSION ?? "#1", c = e.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${o} ${r} ${i} ${a} ${c}
`, stderr: "", exitCode: 0 };
    if (t.s || !t.n && !t.r && !t.v && !t.m)
      return { stdout: o + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return t.s && l.push(o), t.n && l.push(r), t.r && l.push(i), t.v && l.push(a), t.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, uptime = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.p || t.pretty, o = t.s || t.since, r = 86400 + 3600 * 5 + 1380, i = Math.floor(r / 86400), a = Math.floor(r % 86400 / 3600), c = Math.floor(r % 3600 / 60), l = /* @__PURE__ */ new Date(), d = new Date(l.getTime() - r * 1e3), u = [];
    if (o)
      u.push(d.toISOString());
    else if (s) {
      const f = [];
      i > 0 && f.push(`${i} day${i !== 1 ? "s" : ""}`), a > 0 && f.push(`${a} hour${a !== 1 ? "s" : ""}`), c > 0 && f.push(`${c} minute${c !== 1 ? "s" : ""}`), u.push(`up ${f.join(", ")}`);
    } else {
      const f = l.toTimeString().split(" ")[0], p = i > 0 ? `${i} day${i !== 1 ? "s" : ""}, ${a}:${String(c).padStart(2, "0")}` : `${a}:${String(c).padStart(2, "0")}`;
      u.push(` ${f} up ${p}, 1 user, load average: 0.50, 0.40, 0.35`);
    }
    return {
      stdout: u.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, watch = {
  name: "watch",
  description: "Execute a program periodically, showing output",
  async exec(n, e) {
    const { values: t, positional: s, flags: o } = parseArgs(n, [
      "n",
      "interval",
      "d",
      "differences",
      "t",
      "no-title",
      "b",
      "beep",
      "e",
      "errexit",
      "g",
      "chgexit",
      "help"
    ]);
    if (o.help)
      return {
        stdout: `Usage: watch [options] command
Execute a program periodically, showing output fullscreen.

Options:
  -n, --interval <secs>  Seconds to wait between updates (default: 2)
  -d, --differences      Highlight changes between updates
  -t, --no-title        Turn off header showing interval, command, and time
  -b, --beep            Beep if command has a non-zero exit status
  -e, --errexit         Exit if command has a non-zero exit status
  -g, --chgexit         Exit when output from command changes
  -h, --help            Display this help and exit

Examples:
  watch -n 5 ls -l       # Update every 5 seconds
  watch -d df -h         # Highlight differences in disk usage
  watch date             # Show current time, updating every 2 seconds

`,
        stderr: "",
        exitCode: 0
      };
    if (s.length === 0)
      return {
        stdout: "",
        stderr: `watch: missing command
Try 'watch --help' for more information.
`,
        exitCode: 1
      };
    const r = parseFloat(t.n || t.interval || "2"), i = s.join(" ");
    return {
      stdout: (o.t || o["no-title"] ? "" : `Every ${r}s: ${i}

`) + `watch: This is a stub implementation.
In a real shell, this would execute '${i}' every ${r} seconds.

To implement watch in a browser environment:
1. Use setInterval to run command periodically
2. Update a dedicated output area
3. Handle options like -d (differences), -e (errexit), -g (chgexit)
4. Provide a way to stop watching (Ctrl+C)

Browser shells should implement watch at the shell level for proper integration.

`,
      stderr: "",
      exitCode: 0
    };
  }
}, wc = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.l, r = t.w, i = t.c, a = !o && !r && !i;
    try {
      const { content: c, files: l } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), d = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), u = c.split(/\s+/).filter(Boolean).length, f = c.length, p = [];
      return (a || o) && p.push(String(d).padStart(6)), (a || r) && p.push(String(u).padStart(6)), (a || i) && p.push(String(f).padStart(6)), l.length === 1 && p.push(" " + s[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, which = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), o = t.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const r = s[0], i = e.env.PATH || "/bin:/usr/bin:/usr/local/bin", a = i.split(":"), c = [];
    for (const l of a) {
      const d = `${l}/${r}`;
      try {
        if (await e.fs.exists(d) && (await e.fs.stat(d)).type === "file" && (c.push(d), !o))
          break;
      } catch {
        continue;
      }
    }
    return c.length === 0 ? {
      stdout: "",
      stderr: `which: no ${r} in (${i})
`,
      exitCode: 1
    } : {
      stdout: c.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, whoami = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, e) {
    return { stdout: (e.env.USER ?? e.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, xargs = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, e) {
    const { flags: t, positional: s, values: o } = parseArgs(n, ["n", "I", "i", "d", "delimiter"]), r = t.I || t.L || t.l, i = o.I || o.i, a = o.n ? parseInt(o.n) : void 0, c = o.d || o.delimiter || /\s+/, l = t.t || t.verbose, d = t.r, u = s.length > 0 ? s.join(" ") : "echo";
    let f;
    if (typeof c == "string" ? f = e.stdin.split(c).filter(Boolean) : f = e.stdin.trim().split(c).filter(Boolean), f.length === 0) {
      if (d)
        return { stdout: "", stderr: "", exitCode: 0 };
      f = [""];
    }
    const p = [], h = [];
    if (i) {
      const m = typeof i == "string" ? i : "{}";
      for (const g of f) {
        const x = u.replace(new RegExp(escapeRegex(m), "g"), g);
        h.push(x), l && p.push(`+ ${x}`);
      }
    } else if (a)
      for (let m = 0; m < f.length; m += a) {
        const g = f.slice(m, m + a), x = `${u} ${g.map(escapeArg).join(" ")}`;
        h.push(x), l && p.push(`+ ${x}`);
      }
    else if (r)
      for (const m of f) {
        const g = `${u} ${escapeArg(m)}`;
        h.push(g), l && p.push(`+ ${g}`);
      }
    else {
      const m = u === "echo" ? f.join(" ") : `${u} ${f.map(escapeArg).join(" ")}`;
      h.push(m), l && p.push(`+ ${m}`);
    }
    return u === "echo" && !i && !a ? p.push(...f) : p.push(...h), {
      stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function escapeArg(n) {
  return /[^a-zA-Z0-9._\-/=]/.test(n) ? `'${n.replace(/'/g, "'\\''")}'` : n;
}
function escapeRegex(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const yes = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, e) {
    const { positional: t } = parseArgs(n), s = t.length > 0 ? t.join(" ") : "y", o = [], r = 1e3;
    for (let i = 0; i < r; i++)
      o.push(s);
    return {
      stdout: o.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, allCommands = {
  ".": dot,
  alias,
  array: arrayHelper,
  awk,
  base64,
  basename,
  bc,
  break: breakCmd,
  case: caseCmd,
  cc,
  cat,
  chmod,
  chown,
  clear,
  column,
  comm,
  continue: continueCmd,
  cp,
  curl,
  cut,
  date,
  declare,
  df,
  diff,
  dirname,
  do: doCmd,
  done,
  du,
  echo,
  elif,
  else: elseCmd,
  env,
  esac,
  eval: evalCmd,
  exit,
  expand,
  expr,
  export: exportCmd,
  false: falseCmd,
  fi,
  file,
  find,
  fmt,
  fold,
  for: forCmd,
  free,
  function: functionCmd,
  gcc,
  getopts,
  grep,
  hash,
  head,
  heredoc,
  hexdump,
  hostname,
  id,
  if: ifCmd,
  in: inCmd,
  install,
  join,
  kill,
  less,
  let: letCmd,
  ln,
  local,
  ls,
  make,
  md5sum,
  mkdir,
  mv,
  nl,
  nohup,
  od,
  paste,
  patch,
  "pkg-config": pkgConfig,
  pr,
  "process-substitution": processSubstitution,
  printenv,
  printf,
  pwd,
  read,
  readlink,
  readonly,
  realpath,
  return: returnCmd,
  rm,
  sed,
  seq,
  set,
  sha256sum,
  shift,
  sleep,
  sort,
  source,
  stat,
  strings,
  tail,
  tar,
  tee,
  test,
  then,
  time,
  timeout,
  touch,
  tr,
  trap,
  true: trueCmd,
  tsort,
  type,
  ulimit,
  umask,
  unalias,
  unexpand,
  uniq,
  unset,
  uname,
  until,
  uptime,
  watch,
  wc,
  which,
  while: whileCmd,
  whoami,
  xargs,
  yes
}, commandList = Object.values(allCommands);
export {
  alias,
  allCommands,
  arithmeticExpansion,
  arrayHelper,
  awk,
  base64,
  basename,
  bc,
  breakCmd as break,
  caseCmd as case,
  cat,
  cc,
  chmod,
  chown,
  clear,
  column,
  comm,
  commandList,
  continueCmd as continue,
  cp,
  curl,
  cut,
  date,
  declare,
  df,
  diff,
  dirname,
  doCmd as do,
  done,
  dot,
  du,
  echo,
  elif,
  elseCmd as else,
  env,
  esac,
  evalCmd as eval,
  exit,
  expand,
  exportCmd,
  expr,
  falseCmd as false,
  fi,
  file,
  find,
  fmt,
  fold,
  forCmd as for,
  free,
  functionCmd as function,
  gcc,
  getopts,
  grep,
  hash,
  head,
  heredoc,
  hexdump,
  hostname,
  id,
  ifCmd as if,
  inCmd as in,
  install,
  join,
  kill,
  less,
  letCmd as let,
  letCmd,
  ln,
  local,
  ls,
  make,
  md5sum,
  mkdir,
  mv,
  nl,
  nohup,
  od,
  paste,
  patch,
  pkgConfig,
  pr,
  printenv,
  printf,
  processSubstitution,
  pwd,
  read,
  readlink,
  readonly,
  realpath,
  returnCmd as return,
  rm,
  sed,
  seq,
  set,
  sha256sum,
  shift,
  sleep,
  sort,
  source,
  stat,
  strings,
  tail,
  tar,
  tee,
  test,
  then,
  time,
  timeout,
  touch,
  tr,
  trap,
  trueCmd as true,
  tsort,
  type,
  ulimit,
  umask,
  unalias,
  uname,
  unexpand,
  uniq,
  unset,
  until,
  uptime,
  watch,
  wc,
  which,
  whileCmd as while,
  whoami,
  xargs,
  yes
};
