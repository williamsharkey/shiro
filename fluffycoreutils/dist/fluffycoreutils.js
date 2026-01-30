function parseArgs(n, e = []) {
  const t = {}, s = {}, r = [], o = new Set(e);
  for (let i = 0; i < n.length; i++) {
    const a = n[i];
    if (a === "--") {
      r.push(...n.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const c = a.slice(2);
      o.has(c) && i + 1 < n.length ? s[c] = n[++i] : t[c] = !0;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const c = a.slice(1);
      if (o.has(c) && i + 1 < n.length)
        s[c] = n[++i];
      else
        for (let l = 0; l < c.length; l++) {
          const d = c[l];
          if (o.has(d)) {
            const u = c.slice(l + 1);
            u ? s[d] = u : i + 1 < n.length && (s[d] = n[++i]);
            break;
          }
          t[d] = !0;
        }
    } else
      r.push(a);
  }
  return { flags: t, values: s, positional: r };
}
async function readInput(n, e, t, s, r) {
  if (n.length === 0)
    return { content: e, files: [] };
  const o = [], i = [];
  for (const a of n) {
    const c = r(a, s);
    o.push(c), i.push(await t.readFile(c));
  }
  return { content: i.join(""), files: o };
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
    const r = [];
    for (const o of t)
      s.p && r.push(`alias ${o}`);
    return {
      stdout: r.join(`
`) + (r.length > 0 ? `
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
    const r = s[0], o = s.slice(1), i = {
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
      FILENAME: o[0] || "-",
      variables: {}
    };
    if (t.v) {
      const a = t.v.split("=");
      a.length === 2 && (i.variables[a[0]] = a[1]);
    }
    try {
      const { content: a } = await readInput(
        o,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = a.endsWith(`
`) ? a.slice(0, -1).split(`
`) : a.split(`
`), l = [], d = r.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), u = r.match(/END\s*\{\s*([^}]*)\s*\}/), f = r.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
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
            const w = executeAction(y, m, i);
            w !== null && l.push(w);
          }
        } else if (!d && !u) {
          const x = executeAction(r, m, i);
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
    const r = s.match(/printf\s+(.+)/);
    if (r)
      return formatPrintf(r[1], e, t);
  }
  if (s.startsWith("print")) {
    const r = s.substring(5).trim();
    if (!r || r === "")
      return e.join(t.OFS);
    if (r.includes(","))
      return r.split(/\s*,\s*/).map((c) => {
        let l = substituteVariables(c.trim(), e, t);
        return l = evaluateArithmetic$1(l), l.replace(/^["'](.*)["']$/, "$1");
      }).join(t.OFS);
    let o = r;
    return o = substituteVariables(o, e, t), o = evaluateArithmetic$1(o), o = o.replace(/^["'](.*)["']$/, "$1"), o = o.replace(/\s+/g, " ").trim(), o;
  }
  return null;
}
function substituteVariables(n, e, t) {
  let s = n;
  s = s.replace(/\$0/g, e.join(t.OFS)), s = s.replace(/\$NF/g, e[e.length - 1] || "");
  for (let r = 1; r <= e.length; r++)
    s = s.replace(new RegExp(`\\$${r}\\b`, "g"), e[r - 1] || "");
  s = s.replace(/\bNR\b/g, String(t.NR)), s = s.replace(/\bNF\b/g, String(t.NF)), s = s.replace(/\bFS\b/g, t.FS), s = s.replace(/\bOFS\b/g, t.OFS), s = s.replace(/\bRS\b/g, t.RS), s = s.replace(/\bORS\b/g, t.ORS), s = s.replace(/\bFILENAME\b/g, t.FILENAME);
  for (const [r, o] of Object.entries(t.variables))
    s = s.replace(new RegExp(`\\b${r}\\b`, "g"), o);
  return s;
}
function evaluateArithmetic$1(n) {
  const e = /^([\d.]+)\s*([\+\-\*\/])\s*([\d.]+)$/, t = n.match(e);
  if (t) {
    const s = parseFloat(t[1]), r = t[2], o = parseFloat(t[3]);
    let i;
    switch (r) {
      case "+":
        i = s + o;
        break;
      case "-":
        i = s - o;
        break;
      case "*":
        i = s * o;
        break;
      case "/":
        i = s / o;
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
  let r = s[0].trim().replace(/^["'](.*)["']$/, "$1");
  const o = [];
  for (let c = 1; c < s.length; c++) {
    const l = substituteVariables(s[c].trim(), e, t);
    o.push(l);
  }
  let i = r, a = 0;
  return i = i.replace(/%(-)?(\d+)?(?:\.(\d+))?([sdifgex%])/g, (c, l, d, u, f) => {
    if (f === "%") return "%";
    if (a >= o.length) return c;
    const p = o[a++];
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
  return s = s.replace(/length\s*\(\s*([^)]*)\s*\)/g, (r, o) => {
    const i = o ? substituteVariables(o, e, t) : e.join(t.OFS);
    return String(i.length);
  }), s = s.replace(/substr\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (r, o, i, a) => {
    const c = substituteVariables(o.trim(), e, t), l = parseInt(substituteVariables(i.trim(), e, t)) - 1, d = a ? parseInt(substituteVariables(a.trim(), e, t)) : void 0;
    return d ? c.slice(l, l + d) : c.slice(l);
  }), s = s.replace(/index\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (r, o, i) => {
    const a = substituteVariables(o.trim(), e, t), c = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = a.indexOf(c);
    return String(l === -1 ? 0 : l + 1);
  }), s = s.replace(/tolower\s*\(\s*([^)]*)\s*\)/g, (r, o) => substituteVariables(o, e, t).toLowerCase()), s = s.replace(/toupper\s*\(\s*([^)]*)\s*\)/g, (r, o) => substituteVariables(o, e, t).toUpperCase()), s = s.replace(/split\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (r, o, i, a) => {
    const c = substituteVariables(o.trim(), e, t), l = a ? substituteVariables(a.trim(), e, t).replace(/^["'](.*)["']$/, "$1") : t.FS, d = c.split(new RegExp(l));
    return String(d.length);
  }), s = s.replace(/gsub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (r, o, i, a) => {
    const c = substituteVariables(o.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), d = a ? substituteVariables(a.trim(), e, t) : e[0] || "";
    try {
      const u = new RegExp(c, "g");
      return d.replace(u, l);
    } catch {
      return d;
    }
  }), s = s.replace(/sub\s*\(\s*([^,)]+)\s*,\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g, (r, o, i, a) => {
    const c = substituteVariables(o.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), l = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1"), d = a ? substituteVariables(a.trim(), e, t) : e[0] || "";
    try {
      const u = new RegExp(c);
      return d.replace(u, l);
    } catch {
      return d;
    }
  }), s = s.replace(/match\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)/g, (r, o, i) => {
    const a = substituteVariables(o.trim(), e, t), c = substituteVariables(i.trim(), e, t).replace(/^["'](.*)["']$/, "$1");
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
    const { flags: t, positional: s } = parseArgs(n), r = t.d || t.decode, o = t.w ? parseInt(t.w) : 76, i = t.i || t["ignore-garbage"];
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let c;
      if (r) {
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
        if (o > 0) {
          const d = [];
          for (let u = 0; u < l.length; u += o)
            d.push(l.substring(u, u + o));
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["l", "q", "s", "w"]), o = t.l;
    t.q;
    const i = r.s ? parseInt(r.s) : 0;
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
    o && (u = 20);
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
          const g = evaluateExpression$1(m, d, u, o);
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
        const h = evaluateExpression$1(f, d, u, o), m = formatNumber$1(h, u);
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
      const { content: r } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return t.n ? { stdout: r.split(`
`).map((a, c) => `${String(c + 1).padStart(6)}	${a}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: r, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `cat: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, gcc = {
  name: "gcc",
  description: "GNU C Compiler (stub)",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = parseArgs(n, [
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
    if (r.length === 0)
      return {
        stdout: "",
        stderr: `gcc: fatal error: no input files
compilation terminated.
`,
        exitCode: 1
      };
    const o = r, i = s.o || "a.out";
    for (const f of o) {
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
    for (const f of o)
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
      for (const f of o)
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
      for (const f of o)
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
    const { flags: t, positional: s } = parseArgs(n), r = t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = s[0], i = s.slice(1), a = parseInt(o, 8);
    if (isNaN(a))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function c(l) {
      const d = e.fs.resolvePath(l, e.cwd);
      if (r)
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
    const r = s[0], o = s.slice(1);
    t.R;
    const i = t.v, a = r.split(":");
    a[0], a[1];
    const c = [];
    try {
      for (const l of o)
        i && c.push(`ownership of '${l}' retained as ${r}`);
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["t", "s", "c", "x", "n"]);
    try {
      const { content: o } = await readInput(
        r,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), i = o.split(`
`);
      if (i.length > 0 && i[i.length - 1] === "" && i.pop(), t.t) {
        const f = s.s || "	", p = new RegExp(f), h = i.map((y) => y.split(p)), m = Math.max(...h.map((y) => y.length)), g = new Array(m).fill(0);
        for (const y of h)
          for (let w = 0; w < y.length; w++)
            g[w] = Math.max(g[w] || 0, y[w].length);
        const x = h.map((y) => y.map((w, S) => {
          const $ = g[S];
          return w.padEnd($);
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
    } catch (o) {
      return {
        stdout: "",
        stderr: `column: ${o.message}
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
    const r = t[1], o = t[2], i = t[3];
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
          if (!o) {
            const y = r ? "" : "	";
            p.push(y + x);
          }
          m++;
        } else if (x === null)
          r || p.push(g), h++;
        else if (g < x)
          r || p.push(g), h++;
        else if (g > x) {
          if (!o) {
            const y = r ? "" : "	";
            p.push(y + x);
          }
          m++;
        } else {
          if (!i) {
            let y = "";
            r || (y += "	"), o || (y += "	"), p.push(y + g);
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
    const { flags: t, positional: s } = parseArgs(n), r = t.r || t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const o = e.fs.resolvePath(s[s.length - 1], e.cwd), i = s.slice(0, -1);
    let a = !1;
    try {
      a = (await e.fs.stat(o)).type === "dir";
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
        const u = e.fs.resolvePath(d, e.cwd), f = await e.fs.stat(u), p = d.split("/").pop(), h = a ? o + "/" + p : o;
        if (f.type === "dir") {
          if (!r)
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (r.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = r[0], i = s.X || s.request || (s.d || s.data ? "POST" : "GET"), a = s.o || s.output, c = t.s || t.silent, l = t.i || t.include, d = t.I || t.head, u = t.L || t.location, f = {}, p = s.H || s.header;
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
      const x = await fetch(o, g);
      let y = "";
      if ((l || d) && (y += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((w, S) => {
        y += `${S}: ${w}
`;
      }), y += `
`), !d) {
        const w = await x.text();
        y += w;
      }
      if (a) {
        const w = e.fs.resolvePath(a, e.cwd);
        return await e.fs.writeFile(w, d ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
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
    const { values: t, positional: s } = parseArgs(n, ["d", "f", "c"]), r = t.d ?? "	", o = t.f, i = t.c;
    if (!o && !i)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: a } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = parseRanges(o ?? i), l = a.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const d = [];
      for (const u of l)
        if (o) {
          const f = u.split(r), p = c.flatMap((h) => f.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          d.push(p.join(r));
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
      const [s, r] = e.split("-");
      return {
        start: s ? parseInt(s, 10) : 1,
        end: r ? parseInt(r, 10) : 1 / 0
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["d", "date", "r", "reference", "u"]);
    let o;
    if (r.d || r.date) {
      const c = r.d || r.date;
      if (o = new Date(c), isNaN(o.getTime()))
        return {
          stdout: "",
          stderr: `date: invalid date '${c}'
`,
          exitCode: 1
        };
    } else {
      if (r.r || r.reference)
        return {
          stdout: "",
          stderr: `date: -r/--reference not supported in browser environment
`,
          exitCode: 1
        };
      o = /* @__PURE__ */ new Date();
    }
    const i = t.u || t.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const c = s[0].slice(1);
      return { stdout: formatDate$1(o, c, i) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (i ? o.toUTCString() : o.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function formatDate$1(n, e, t = !1) {
  const s = (y) => String(y).padStart(2, "0"), r = (y) => String(y).padStart(3, "0"), o = (y) => t ? n[`getUTC${y}`]() : n[`get${y}`](), i = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], a = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], c = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], d = o("FullYear"), u = o("Month"), f = o("Date"), p = o("Hours"), h = o("Minutes"), m = o("Seconds"), g = o("Milliseconds"), x = o("Day");
  return e.replace(/%Y/g, String(d)).replace(/%y/g, String(d).slice(-2)).replace(/%m/g, s(u + 1)).replace(/%d/g, s(f)).replace(/%e/g, String(f).padStart(2, " ")).replace(/%H/g, s(p)).replace(/%I/g, s(p % 12 || 12)).replace(/%M/g, s(h)).replace(/%S/g, s(m)).replace(/%N/g, r(g) + "000000").replace(/%p/g, p >= 12 ? "PM" : "AM").replace(/%P/g, p >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, i[x]).replace(/%a/g, a[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, c[u]).replace(/%b/g, l[u]).replace(/%h/g, l[u]).replace(/%F/g, `${d}-${s(u + 1)}-${s(f)}`).replace(/%T/g, `${s(p)}:${s(h)}:${s(m)}`).replace(/%R/g, `${s(p)}:${s(h)}`).replace(/%n/g, `
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
      const [r, o] = s.split("=", 2);
      return o !== void 0 ? `${r}=${o}` : r;
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
        stdout: s.map((o) => {
          const i = e.env[o];
          return i !== void 0 ? `declare -- ${o}="${i}"
` : "";
        }).join(""),
        stderr: "",
        exitCode: 0
      };
    for (const r of s) {
      const [o, i] = r.split("=", 2);
      i !== void 0 && e.env && (e.env[o] = i);
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
    for (const r of s) {
      const [o, i] = r.split("=", 2);
      i !== void 0 && e.env && (e.env[o] = i);
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
      for (const r of s)
        delete e.env[r];
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
    const { flags: t } = parseArgs(n), s = t.h, r = t.i, o = [];
    return r ? (o.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on"), o.push("virtual             0      0       0    0% /")) : s ? (o.push("Filesystem      Size  Used Avail Use% Mounted on"), o.push("virtual         100G   10G   90G  10% /")) : (o.push("Filesystem     1K-blocks    Used Available Use% Mounted on"), o.push("virtual        104857600 10485760  94371840  10% /")), {
      stdout: o.join(`
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["U", "context", "C"]), o = t.u || r.U !== void 0, i = r.U || r.context || r.C || (t.u ? 3 : 0), a = typeof i == "string" ? parseInt(i) : 3, c = t.q || t.brief, l = t.i, d = t.w || t["ignore-all-space"], u = t.y || t["side-by-side"];
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
`), w = x.split(`
`), S = computeDiff(y, w, { ignoreCase: l, ignoreWhitespace: d }), $ = [];
      if (o) {
        $.push(`--- ${s[0]}`), $.push(`+++ ${s[1]}`);
        let C = 0;
        for (; C < S.length; ) {
          if (S[C].type === "equal") {
            C++;
            continue;
          }
          const v = Math.max(0, C - 1);
          let E = C;
          for (; E < S.length; ) {
            const I = S[E];
            if (I.type !== "equal")
              E++;
            else if (I.lines.length <= a * 2)
              E++;
            else
              break;
          }
          const T = (((f = S[v]) == null ? void 0 : f.line1) ?? 0) + 1, A = (((p = S[v]) == null ? void 0 : p.line2) ?? 0) + 1;
          let F = 0, R = 0;
          for (let I = v; I < E; I++)
            (S[I].type === "equal" || S[I].type === "delete") && (F += S[I].lines.length), (S[I].type === "equal" || S[I].type === "add") && (R += S[I].lines.length);
          $.push(`@@ -${T},${F} +${A},${R} @@`);
          for (let I = v; I < E; I++) {
            const P = S[I];
            P.type === "equal" ? P.lines.forEach((M) => $.push(` ${M}`)) : P.type === "delete" ? P.lines.forEach((M) => $.push(`-${M}`)) : P.type === "add" && P.lines.forEach((M) => $.push(`+${M}`));
          }
          C = E;
        }
      } else if (u)
        for (const b of S)
          b.type === "equal" ? b.lines.forEach((v) => {
            const E = v.substring(0, 40).padEnd(40);
            $.push(`${E} | ${v}`);
          }) : b.type === "delete" ? b.lines.forEach((v) => {
            const E = v.substring(0, 40).padEnd(40);
            $.push(`${E} <`);
          }) : b.type === "add" && b.lines.forEach((v) => {
            $.push(`${" ".repeat(40)} > ${v}`);
          });
      else
        for (const C of S) {
          if (C.type === "equal") continue;
          const b = (C.line1 ?? 0) + 1, v = (C.line2 ?? 0) + 1;
          C.type === "delete" ? ($.push(`${b},${b + C.lines.length - 1}d${v - 1}`), C.lines.forEach((E) => $.push(`< ${E}`))) : C.type === "add" && ($.push(`${b - 1}a${v},${v + C.lines.length - 1}`), C.lines.forEach((E) => $.push(`> ${E}`)));
        }
      return { stdout: $.join(`
`) + ($.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (h) {
      return { stdout: "", stderr: `diff: ${h instanceof Error ? h.message : h}
`, exitCode: 2 };
    }
  }
};
function computeDiff(n, e, t = {}) {
  const s = n.length, r = e.length, o = (d) => {
    let u = d;
    return t.ignoreWhitespace && (u = u.replace(/\s+/g, "")), t.ignoreCase && (u = u.toLowerCase()), u;
  }, i = Array(s + 1).fill(0).map(() => Array(r + 1).fill(0));
  for (let d = 1; d <= s; d++)
    for (let u = 1; u <= r; u++)
      o(n[d - 1]) === o(e[u - 1]) ? i[d][u] = i[d - 1][u - 1] + 1 : i[d][u] = Math.max(i[d - 1][u], i[d][u - 1]);
  const a = [];
  let c = s, l = r;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && o(n[c - 1]) === o(e[l - 1]) ? (a.length > 0 && a[a.length - 1].type === "equal" ? a[a.length - 1].lines.unshift(n[c - 1]) : a.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || i[c][l - 1] >= i[c - 1][l]) ? (a.length > 0 && a[a.length - 1].type === "add" ? a[a.length - 1].lines.unshift(e[l - 1]) : a.push({ type: "add", lines: [e[l - 1]], line1: c, line2: l - 1 }), l--) : (a.length > 0 && a[a.length - 1].type === "delete" ? a[a.length - 1].lines.unshift(n[c - 1]) : a.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: l }), c--);
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["max-depth", "d"]), o = s.length > 0 ? s : ["."], i = t.s, a = t.a, c = t.h, l = r["max-depth"] || r.d, d = l ? parseInt(l) : 1 / 0, u = [];
    try {
      for (const f of o) {
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
async function calculateSize(n, e, t, s, r, o, i, a) {
  try {
    const c = await e.stat(n);
    if (c.type === "file")
      return c.size;
    if (c.type === "dir" && t < s) {
      const l = await e.readdir(n);
      let d = 0;
      for (const u of l) {
        const f = n + "/" + u.name, p = await calculateSize(f, e, t + 1, s, r, o, i, a);
        if (d += p, r && u.type === "file") {
          const h = a ? formatHuman(p) : String(Math.ceil(p / 1024));
          i.push(`${h}	${f}`);
        }
        if (o && u.type === "dir" && t + 1 < s) {
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
    const { flags: e } = parseArgs(n), t = e.n, s = n.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let r = e.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return t || (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
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
    return { stdout: Object.entries(e.env).map(([s, r]) => `${s}=${r}`).sort().join(`
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["t", "tabs"]), o = t.t || t.tabs || "8", i = parseInt(o, 10);
    if (isNaN(i) || i <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const a = r.i || r.initial;
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
      const s = String(evaluateExpression(n.slice(0, e))), r = String(evaluateExpression(n.slice(e + 1))), o = parseFloat(s), i = parseFloat(r), a = !isNaN(o) && !isNaN(i);
      let c = !1;
      if (a)
        switch (t) {
          case "=":
            c = o === i;
            break;
          case "!=":
            c = o !== i;
            break;
          case "<":
            c = o < i;
            break;
          case ">":
            c = o > i;
            break;
          case "<=":
            c = o <= i;
            break;
          case ">=":
            c = o >= i;
            break;
        }
      else
        switch (t) {
          case "=":
            c = s === r;
            break;
          case "!=":
            c = s !== r;
            break;
          case "<":
            c = s < r;
            break;
          case ">":
            c = s > r;
            break;
          case "<=":
            c = s <= r;
            break;
          case ">=":
            c = s >= r;
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
        const s = new RegExp("^" + t), r = e.match(s);
        return r ? r[0].length : 0;
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
      return { stdout: Object.entries(e.env).map(([o, i]) => `export ${o}="${i}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const t = [], s = [];
    for (const r of n) {
      const o = r.indexOf("=");
      if (o === -1) {
        const i = r;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i)) {
          s.push(`export: \`${i}': not a valid identifier`);
          continue;
        }
        i in e.env ? t.push(`export ${i}="${e.env[i]}"`) : t.push(`export ${i}=""`);
      } else {
        const i = r.slice(0, o);
        let a = r.slice(o + 1);
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
    const r = s.b, o = s.i || s.mime, i = s["mime-type"], a = s["mime-encoding"], c = [];
    try {
      for (const l of t) {
        const d = e.fs.resolvePath(l, e.cwd);
        try {
          if ((await e.fs.stat(d)).type === "dir") {
            const m = r ? "directory" : `${l}: directory`;
            c.push(m);
            continue;
          }
          const f = await e.fs.readFile(d), p = detectFileType(f, l);
          let h;
          i ? h = r ? p.mimeType : `${l}: ${p.mimeType}` : a ? h = r ? p.encoding : `${l}: ${p.encoding}` : o ? h = r ? `${p.mimeType}; charset=${p.encoding}` : `${l}: ${p.mimeType}; charset=${p.encoding}` : h = r ? p.description : `${l}: ${p.description}`, c.push(h);
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
  let t = "text/plain", s = "us-ascii", r = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", r = "UTF-8 Unicode text"), n.length === 0)
    return t = "application/x-empty", r = "empty", { mimeType: t, encoding: s, description: r };
  const o = (i = e.split(".").pop()) == null ? void 0 : i.toLowerCase();
  if (o)
    switch (o) {
      case "js":
      case "mjs":
        t = "text/javascript", r = "JavaScript source";
        break;
      case "ts":
        t = "text/x-typescript", r = "TypeScript source";
        break;
      case "json":
        t = "application/json", r = "JSON data";
        break;
      case "html":
      case "htm":
        t = "text/html", r = "HTML document";
        break;
      case "css":
        t = "text/css", r = "CSS stylesheet";
        break;
      case "xml":
        t = "text/xml", r = "XML document";
        break;
      case "md":
        t = "text/markdown", r = "Markdown text";
        break;
      case "sh":
        t = "text/x-shellscript", r = "shell script";
        break;
      case "py":
        t = "text/x-python", r = "Python script";
        break;
      case "txt":
        t = "text/plain", r = "ASCII text";
        break;
    }
  if (n.startsWith("#!/bin/sh") || n.startsWith("#!/bin/bash"))
    t = "text/x-shellscript", r = "Bourne-Again shell script";
  else if (n.startsWith("#!/usr/bin/env node"))
    t = "text/javascript", r = "Node.js script";
  else if (n.startsWith("#!/usr/bin/env python"))
    t = "text/x-python", r = "Python script";
  else if (n.startsWith("{") && n.trim().endsWith("}"))
    try {
      JSON.parse(n), t = "application/json", r = "JSON data";
    } catch {
    }
  else n.startsWith("<?xml") ? (t = "text/xml", r = "XML document") : (n.startsWith("<!DOCTYPE html") || n.startsWith("<html")) && (t = "text/html", r = "HTML document");
  return { mimeType: t, encoding: s, description: r };
}
const find = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = parseArgs(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = s[0] ?? ".", i = t.name, a = t.iname, c = t.path, l = t.type, d = t.maxdepth ? parseInt(t.maxdepth) : 1 / 0, u = t.mindepth ? parseInt(t.mindepth) : 0, f = t.exec, p = r.print !== !1, h = e.fs.resolvePath(o, e.cwd), m = [], g = [];
    let x;
    if (i) {
      const C = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${C}$`);
    }
    let y;
    if (a) {
      const C = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      y = new RegExp(`^${C}$`, "i");
    }
    let w;
    if (c) {
      const C = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      w = new RegExp(C);
    }
    async function S(C, b, v) {
      let E;
      try {
        E = await e.fs.readdir(C);
      } catch {
        return;
      }
      for (const T of E) {
        const A = C + "/" + T.name, F = b ? b + "/" + T.name : T.name, R = o === "." ? "./" + F : o + "/" + F, I = v + 1;
        let P = !0;
        if (!(I > d)) {
          if (I < u && (P = !1), x && !x.test(T.name) && (P = !1), y && !y.test(T.name) && (P = !1), w && !w.test(R) && (P = !1), l === "f" && T.type !== "file" && (P = !1), l === "d" && T.type !== "dir" && (P = !1), P && (p && m.push(R), f)) {
            const M = f.replace(/\{\}/g, R);
            g.push(`Executing: ${M}`);
          }
          T.type === "dir" && I < d && await S(A, F, I);
        }
      }
    }
    0 >= u && (!l || l === "d") && !x && !y && !w && p && m.push(o === "." ? "." : o), await S(h, "", 0);
    let $ = "";
    return m.length > 0 && ($ = m.join(`
`) + `
`), g.length > 0 && ($ += g.join(`
`) + `
`), { stdout: $, stderr: "", exitCode: 0 };
  }
}, fmt = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = parseArgs(n, ["w", "width"]), o = parseInt(t.w || t.width || "75", 10);
    r.u;
    const i = r.s;
    if (isNaN(o) || o <= 0)
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
              l.push(...wrapLine(f, o));
          else {
            const f = d.join(" ").trim();
            f && l.push(...wrapLine(f, o));
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
  let r = "";
  for (const o of s)
    r.length === 0 ? r = o : r.length + 1 + o.length <= e ? r += " " + o : (t.push(r), r = o);
  return r.length > 0 && t.push(r), t;
}
const fold = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = parseArgs(n, ["w", "width"]), o = parseInt(t.w || t.width || "80", 10);
    r.b;
    const i = r.s;
    if (isNaN(o) || o <= 0)
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
        if (d.length <= o) {
          l.push(d);
          continue;
        }
        let u = d;
        for (; u.length > o; ) {
          let f = o;
          if (i) {
            const p = u.substring(0, o).lastIndexOf(" ");
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
    const { flags: t } = parseArgs(n), s = t.h, r = t.b, o = t.m, i = t.g, a = [], c = 8388608, l = 4194304, d = 4194304, u = 524288, f = 1048576, p = 5242880;
    return s ? (a.push("               total        used        free      shared  buff/cache   available"), a.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), a.push("Swap:           2.0G          0B        2.0G")) : r ? (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:    ${c * 1024} ${l * 1024} ${d * 1024} ${u * 1024} ${f * 1024} ${p * 1024}`), a.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : o ? (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:           ${Math.floor(c / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(d / 1024)}         ${Math.floor(u / 1024)}        ${Math.floor(f / 1024)}        ${Math.floor(p / 1024)}`), a.push("Swap:          2048           0        2048")) : i ? (a.push("               total        used        free      shared  buff/cache   available"), a.push("Mem:               8           4           4           0           1           5"), a.push("Swap:              2           0           2")) : (a.push("               total        used        free      shared  buff/cache   available"), a.push(`Mem:        ${c}     ${l}     ${d}      ${u}     ${f}     ${p}`), a.push("Swap:       2097152           0     2097152")), {
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
    const t = n[0], s = n[1], r = n.slice(2);
    let o = parseInt(((p = e.env) == null ? void 0 : p.OPTIND) || "1");
    const i = t.startsWith(":"), a = i ? t.slice(1) : t, c = /* @__PURE__ */ new Map();
    for (let m = 0; m < a.length; m++) {
      const g = a[m];
      if (g === ":") continue;
      const x = a[m + 1] === ":";
      c.set(g, x);
    }
    const l = r.length > 0 ? r : (h = e.env) != null && h.$1 ? [e.env.$1, e.env.$2, e.env.$3].filter(Boolean) : [];
    if (l.length === 0 || o > l.length)
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const d = l[o - 1];
    if (!d || !d.startsWith("-") || d === "-" || d === "--")
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const u = d[1];
    if (!c.has(u))
      return e.env && (e.env[s] = "?", e.env.OPTARG = u, e.env.OPTIND = String(o + 1)), i ? {
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
      else if (o < l.length)
        m = l[o], e.env && (e.env.OPTIND = String(o + 2));
      else
        return e.env && (e.env[s] = "?", e.env.OPTARG = u, e.env.OPTIND = String(o + 1)), i ? {
          stdout: "",
          stderr: "",
          exitCode: 0
        } : {
          stdout: "",
          stderr: `getopts: option requires an argument -- ${u}
`,
          exitCode: 0
        };
      e.env && (e.env[s] = u, e.env.OPTARG = m, e.env.OPTIND || (e.env.OPTIND = String(o + 1)));
    } else
      e.env && (e.env[s] = u, e.env.OPTIND = String(o + 1), delete e.env.OPTARG);
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["e"]), o = !!t.i, i = !!t.v, a = !!t.c, c = !!t.l, l = !!t.n, d = !!(t.r || t.R), u = s.e ?? r.shift();
    if (!u)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const f = o ? "i" : "";
    let p;
    try {
      p = new RegExp(u, f);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${u}
`, exitCode: 2 };
    }
    const h = r.length > 0 ? r : ["-"], m = h.length > 1 || d, g = [];
    let x = !1;
    async function y($, C) {
      let b;
      try {
        if ($ === "-")
          b = e.stdin;
        else {
          const T = e.fs.resolvePath($, e.cwd);
          b = await e.fs.readFile(T);
        }
      } catch {
        g.push(`grep: ${$}: No such file or directory`);
        return;
      }
      const v = b.split(`
`);
      v.length > 0 && v[v.length - 1] === "" && v.pop();
      let E = 0;
      for (let T = 0; T < v.length; T++)
        if (p.test(v[T]) !== i && (x = !0, E++, !a && !c)) {
          const F = m ? `${C}:` : "", R = l ? `${T + 1}:` : "";
          g.push(`${F}${R}${v[T]}`);
        }
      a && g.push(m ? `${C}:${E}` : String(E)), c && E > 0 && g.push(C);
    }
    async function w($) {
      const C = e.fs.resolvePath($, e.cwd);
      let b;
      try {
        b = await e.fs.readdir(C);
      } catch {
        return;
      }
      for (const v of b) {
        const E = C + "/" + v.name;
        v.type === "dir" ? await w(E) : await y(E, E);
      }
    }
    for (const $ of h)
      if ($ === "-")
        await y("-", "(standard input)");
      else if (d) {
        const C = e.fs.resolvePath($, e.cwd);
        let b;
        try {
          b = await e.fs.stat(C);
        } catch {
          continue;
        }
        b.type === "dir" ? await w(C) : await y($, $);
      } else
        await y($, $);
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
      stdout: s.length === 0 ? "" : s.map((o) => `builtin hash ${o}=/usr/bin/${o}`).join(`
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
      stdout: s.map((o) => `/usr/bin/${o}`).join(`
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
    const t = n.flatMap((i) => {
      const a = i.match(/^-(\d+)$/);
      return a ? ["-n", a[1]] : [i];
    }), { values: s, positional: r } = parseArgs(t, ["n"]), o = parseInt(s.n ?? "10", 10);
    try {
      const { content: i } = await readInput(
        r,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: i.split(`
`).slice(0, o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `head: ${i instanceof Error ? i.message : i}
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["n", "s", "C"]), o = r.C, i = t.n ? parseInt(t.n) : void 0, a = t.s ? parseInt(t.s) : 0;
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
      if (o) {
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
            const x = p.charCodeAt(g), y = g + 1 < p.length ? p.charCodeAt(g + 1) : 0, w = (x << 8 | y).toString(16).padStart(4, "0");
            m.push(w);
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
    const { positional: t, flags: s } = parseArgs(n), r = t[0] || e.env.USER || "user", o = s.u || s.user, i = s.g || s.group, a = s.G || s.groups, c = s.n || s.name;
    s.r || s.real;
    const l = 1e3, d = 1e3, u = [1e3], f = r, p = "users", h = [];
    if (o)
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    t.m || t.mode;
    const o = t.t || t["target-directory"], i = r.d || r.directory, a = r.v || r.verbose;
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
      else if (o) {
        const l = e.fs.resolvePath(o, e.cwd);
        for (const d of s) {
          const u = e.fs.resolvePath(d, e.cwd), f = d.split("/").pop() || d, p = l + "/" + f, h = await e.fs.readFile(u);
          await e.fs.writeFile(p, h), a && c.push(`'${d}' -> '${o}/${f}'`);
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const o = t[1] ? parseInt(t[1]) - 1 : 0, i = t[2] ? parseInt(t[2]) - 1 : 0, a = t.t || /\s+/, c = t.o, l = r.i;
    try {
      const d = e.fs.resolvePath(s[0], e.cwd), u = e.fs.resolvePath(s[1], e.cwd), f = await e.fs.readFile(d), p = await e.fs.readFile(u), h = f.split(`
`).filter(($) => $.trim() !== ""), m = p.split(`
`).filter(($) => $.trim() !== ""), g = ($) => $.map((C) => C.split(a)), x = g(h), y = g(m), w = /* @__PURE__ */ new Map();
      for (const $ of y) {
        const C = ($[i] || "").trim(), b = l ? C.toLowerCase() : C;
        w.has(b) || w.set(b, []), w.get(b).push($);
      }
      const S = [];
      for (const $ of x) {
        const C = ($[o] || "").trim(), b = l ? C.toLowerCase() : C, v = w.get(b) || [];
        for (const E of v) {
          let T;
          if (c)
            T = c.split(",").map((F) => {
              const [R, I] = F.split(".").map((M) => parseInt(M));
              return (R === 1 ? $ : E)[I - 1] || "";
            }).join(" ");
          else {
            const A = $[o] || "", F = $.filter((I, P) => P !== o), R = E.filter((I, P) => P !== i);
            T = [A, ...F, ...R].join(" ");
          }
          S.push(T);
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
      const { content: r } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), o = r.split(`
`), i = t.N || t.n;
      let a = "";
      return i ? a = o.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : a = r, a && !a.endsWith(`
`) && (a += `
`), { stdout: a, stderr: "", exitCode: 0 };
    } catch (r) {
      return {
        stdout: "",
        stderr: `less: ${r instanceof Error ? r.message : r}
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
        const o = s[1], i = s[2], a = evaluateArithmetic(i, e.env || {});
        return e.env && (e.env[o] = String(a)), {
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
  t = t.replace(/\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g, (s, r) => e[r] || "0");
  try {
    if (t = t.replace(/\s+/g, ""), /^[\d+\-*/%()]+$/.test(t)) {
      const r = new Function(`return (${t})`)();
      return Math.floor(r);
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
    const { flags: t, positional: s } = parseArgs(n), r = t.s, o = t.f, i = t.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const a = e.fs.resolvePath(s[0], e.cwd), c = e.fs.resolvePath(s[1], e.cwd), l = [];
    try {
      if (await e.fs.exists(c))
        if (o)
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
      if (r && e.fs.symlink)
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
    const { flags: t, positional: s } = parseArgs(n), r = s.length > 0 ? s : ["."], o = t.a, i = t.l, a = t.h, c = [];
    for (const l of r) {
      const d = e.fs.resolvePath(l, e.cwd), u = await e.fs.stat(d);
      if (u.type === "file") {
        c.push(i ? formatLong(d.split("/").pop(), u, a) : d.split("/").pop());
        continue;
      }
      r.length > 1 && c.push(`${l}:`);
      const f = await e.fs.readdir(d), p = o ? f : f.filter((h) => !h.name.startsWith("."));
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
  const s = e.type === "dir" ? "d" : "-", r = e.mode ?? (e.type === "dir" ? 493 : 420), o = formatPerms(r), i = t ? humanSize(e.size) : String(e.size).padStart(8), a = new Date(e.mtime), c = formatDate(a);
  return `${s}${o}  1 user user ${i} ${c} ${n}`;
}
function formatPerms(n) {
  let t = "";
  for (let s = 2; s >= 0; s--) {
    const r = n >> s * 3 & 7;
    for (let o = 2; o >= 0; o--)
      t += r & 1 << o ? "rwx"[2 - o] : "-";
  }
  return t;
}
function formatDate(n) {
  const t = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), r = String(n.getHours()).padStart(2, "0"), o = String(n.getMinutes()).padStart(2, "0");
  return `${t} ${s} ${r}:${o}`;
}
function humanSize(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const make = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = parseArgs(n, ["f", "file", "C", "j"]), o = t.f || t.file || "Makefile", i = t.C;
    t.j;
    const a = r.n || r["dry-run"], c = r.p || r.print, l = s.length > 0 ? s : ["all"];
    try {
      const d = i ? e.fs.resolvePath(i, e.cwd) : e.cwd, u = e.fs.resolvePath(o, d);
      let f;
      try {
        f = await e.fs.readFile(u);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${o}: No such file or directory
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
            for (const w of y.commands)
              c || a ? h.push(w) : h.push(`# ${w}`);
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
  for (let r = 0; r < t.length; r++) {
    const o = t[r];
    if (!(o.trim().startsWith("#") || o.trim() === ""))
      if (o.includes(":") && !o.startsWith("	")) {
        const i = o.indexOf(":"), a = o.substring(0, i).trim(), c = o.substring(i + 1).trim(), l = c ? c.split(/\s+/) : [];
        s = { target: a, prerequisites: l, commands: [] }, e.set(a, s);
      } else o.startsWith("	") && s && s.commands.push(o.substring(1));
  }
  return e;
}
const md5sum = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), r = t.c || t.check, o = t.b || t.binary;
    if (r)
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
        const d = await md5(l), u = o ? "*" : " ";
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
    const r = n.charCodeAt(s);
    e = (e << 5) - e + r, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(32, "0");
}
const mkdir = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), r = t.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const o of s) {
        const i = e.fs.resolvePath(o, e.cwd);
        await e.fs.mkdir(i, { recursive: r });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `mkdir: ${o instanceof Error ? o.message : o}
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
    const s = e.fs.resolvePath(t[t.length - 1], e.cwd), r = t.slice(0, -1);
    let o = !1;
    try {
      o = (await e.fs.stat(s)).type === "dir";
    } catch {
    }
    if (r.length > 1 && !o)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const i of r) {
        const a = e.fs.resolvePath(i, e.cwd), c = i.split("/").pop(), l = o ? s + "/" + c : s;
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["b", "s", "w", "n", "v"]), o = t.b || "t", i = t.s || "	", a = parseInt(t.w || "6", 10), c = t.n || "rn", l = parseInt(t.v || "1", 10);
    r.p;
    const d = r.ba;
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
        const x = d ? "a" : o;
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
    const t = n[0], s = n.slice(1), r = `nohup: ignoring input and appending output to 'nohup.out'
`;
    try {
      const o = e.fs.resolvePath("nohup.out", e.cwd), a = `[${(/* @__PURE__ */ new Date()).toISOString()}] Command: ${t} ${s.join(" ")}
`;
      let c = "";
      try {
        c = await e.fs.readFile(o);
      } catch {
      }
      await e.fs.writeFile(o, c + a);
    } catch (o) {
      return {
        stdout: "",
        stderr: `nohup: cannot create nohup.out: ${o.message}
`,
        exitCode: 125
      };
    }
    return {
      stdout: "",
      stderr: r,
      exitCode: 0
    };
  }
}, od = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = parseArgs(n, ["t", "N", "j", "w", "A"]), o = t.t || "o2", i = t.N ? parseInt(t.N) : void 0, a = t.j ? parseInt(t.j) : 0, c = t.w ? parseInt(t.w) : 16, l = t.A || "o", d = r.b || r.c || r.d || r.o || r.s || r.x;
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
      d ? r.b ? (h = "o", m = 1) : r.c ? (h = "c", m = 1) : r.d || r.s ? (h = "d", m = 2) : r.o ? (h = "o", m = 2) : r.x && (h = "x", m = 2) : o && (h = o[0] || "o", m = parseInt(o.substring(1)) || 2);
      let g = a;
      for (let x = 0; x < f.length; x += c) {
        const y = f.substring(x, x + c), w = formatAddress(g, l), S = formatChunk(y, h, m);
        p.push(`${w} ${S}`), g += y.length;
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
  for (let r = 0; r < n.length; r += t) {
    const o = n.substring(r, r + t);
    let i = 0;
    for (let a = 0; a < o.length; a++)
      i = i << 8 | o.charCodeAt(a);
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
        s.push(formatChar(o.charCodeAt(0)));
        break;
      case "a":
        s.push(namedChar(o.charCodeAt(0)));
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["d", "delimiters"]), o = t.d || t.delimiters || "	", i = r.s;
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
          const d = o.split(""), u = [];
          for (let f = 0; f < l.length; f++)
            u.push(l[f]), f < l.length - 1 && u.push(d[f % d.length]);
          c.push(u.join(""));
        }
      else {
        const l = Math.max(...a.map((u) => u.length)), d = o.split("");
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["p", "i", "input", "o", "output"]), o = t.p ? parseInt(t.p) : 0, i = t.i || t.input, a = t.o || t.output, c = r.R || r.reverse, l = r["dry-run"];
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
        const h = stripPath(p.newFile, o), m = stripPath(p.oldFile, o);
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
  let s = null, r = null;
  for (const o of t)
    if (o.startsWith("--- "))
      s = { oldFile: o.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (o.startsWith("+++ ") && s)
      s.newFile = o.substring(4).split("	")[0], e.push(s);
    else if (o.startsWith("@@ ") && s) {
      const i = o.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      i && (r = {
        oldStart: parseInt(i[1]),
        oldLines: parseInt(i[2]),
        newStart: parseInt(i[3]),
        newLines: parseInt(i[4]),
        lines: []
      }, s.hunks.push(r));
    } else r && (o.startsWith(" ") || o.startsWith("+") || o.startsWith("-")) && r.lines.push(o);
  return e;
}
function stripPath(n, e) {
  return n.split("/").slice(e).join("/");
}
function applyPatch(n, e, t) {
  const s = n.split(`
`);
  for (const r of e) {
    const o = r.oldStart - 1, i = r.oldLines, a = [];
    for (const c of r.lines) {
      const l = c[0], d = c.substring(1);
      if (t) {
        if (l === "+")
          continue;
        a.push(d);
      } else
        (l === "+" || l === " ") && a.push(d);
    }
    s.splice(o, i, ...a);
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
    const r = s[0];
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
        }[r] || "1.0.0") + `
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
      }[r] || "";
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
      }[r] || "";
      return {
        stdout: i ? i + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    return t["print-provides"] ? {
      stdout: `${r} = 1.0.0
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
    const { flags: t, positional: s, values: r } = parseArgs(n, [
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
    ]), o = r.h || r.header || "", i = parseInt(r.l || r.length || "66"), a = parseInt(r.w || r.width || "72"), c = t.t || t["omit-header"], l = t.d || t["double-space"], d = t.n || t["number-lines"], u = t.m || t.merge, f = r.s || r.separator || "	", p = t.a || t.across, h = parseInt(r.columns || "1"), m = s.length > 0 ? s : ["-"];
    let g = "";
    for (const x of m) {
      let y;
      try {
        if (x === "-")
          y = e.stdin;
        else {
          const A = e.fs.resolvePath(x, e.cwd);
          y = await e.fs.readFile(A);
        }
      } catch (A) {
        return {
          stdout: "",
          stderr: `pr: ${x}: ${A instanceof Error ? A.message : String(A)}
`,
          exitCode: 1
        };
      }
      const w = y.split(`
`), S = x === "-" ? "" : x, $ = (/* @__PURE__ */ new Date()).toISOString().split("T")[0], C = o || S, b = c ? [] : [
        "",
        "",
        `${$}  ${C}  Page 1`,
        "",
        ""
      ];
      let v = [...w];
      l && (v = v.flatMap((A) => [A, ""])), d && (v = v.map((A, F) => `${(F + 1).toString().padStart(6, " ")}  ${A}`)), h > 1 ? v = formatColumns(v, h, a, f, p) : u && m.length > 1;
      const E = i - b.length - 5, T = [];
      for (let A = 0; A < v.length; A += E)
        T.push(v.slice(A, A + E));
      for (let A = 0; A < T.length; A++) {
        if (!c) {
          const F = `${$}  ${C}  Page ${A + 1}`;
          g += `

` + F + `


`;
        }
        g += T[A].join(`
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
function formatColumns(n, e, t, s, r) {
  const o = Math.floor((t - (e - 1) * s.length) / e), i = [];
  if (r)
    for (let a = 0; a < n.length; a += e) {
      const l = n.slice(a, a + e).map((d) => d.padEnd(o).slice(0, o));
      i.push(l.join(s));
    }
  else {
    const a = Math.ceil(n.length / e);
    for (let c = 0; c < a; c++) {
      const l = [];
      for (let d = 0; d < e; d++) {
        const u = d * a + c, f = u < n.length ? n[u] : "";
        l.push(f.padEnd(o).slice(0, o));
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
    const { positional: t, flags: s } = parseArgs(n), r = s[0] || s.null;
    if (t.length === 0) {
      const o = [];
      for (const [a, c] of Object.entries(e.env))
        o.push(`${a}=${c}`);
      const i = r ? "\0" : `
`;
      return {
        stdout: o.join(i) + (o.length > 0 ? i : ""),
        stderr: "",
        exitCode: 0
      };
    } else {
      const o = [];
      for (const a of t)
        if (a in e.env)
          o.push(e.env[a]);
        else
          return {
            stdout: "",
            stderr: "",
            exitCode: 1
          };
      const i = r ? "\0" : `
`;
      return {
        stdout: o.join(i) + (o.length > 0 ? i : ""),
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
    let s = 0, r = "", o = 0;
    for (; o < e.length; )
      if (e[o] === "\\") {
        switch (o++, e[o]) {
          case "n":
            r += `
`;
            break;
          case "t":
            r += "	";
            break;
          case "\\":
            r += "\\";
            break;
          case '"':
            r += '"';
            break;
          default:
            r += "\\" + (e[o] ?? "");
            break;
        }
        o++;
      } else if (e[o] === "%")
        if (o++, e[o] === "%")
          r += "%", o++;
        else {
          let i = "";
          for (; o < e.length && !/[sdf]/.test(e[o]); )
            i += e[o], o++;
          const a = e[o] ?? "s";
          o++;
          const c = t[s++] ?? "";
          switch (a) {
            case "s":
              r += c;
              break;
            case "d":
              r += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = i.includes(".") ? parseInt(i.split(".")[1], 10) : 6;
              r += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        r += e[o], o++;
    return { stdout: r, stderr: "", exitCode: 0 };
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
    const { positional: t, flags: s, values: r } = parseArgs(n, ["r", "p", "n", "t", "d", "a", "s"]);
    let o = e.stdin || "";
    r.p;
    const i = r.d || `
`, a = r.n ? parseInt(r.n) : void 0;
    let c;
    if (a !== void 0)
      c = o.slice(0, a);
    else {
      const d = o.indexOf(i);
      d >= 0 ? c = o.slice(0, d) : c = o;
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
    const { flags: t, positional: s } = parseArgs(n), r = t.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const o = e.fs.resolvePath(s[0], e.cwd);
    return r ? { stdout: o + `
`, stderr: "", exitCode: 0 } : { stdout: o + `
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
    const r = t.q || t.quiet, o = !t.s;
    t.s;
    const i = [], a = [];
    for (const d of s)
      try {
        let u = e.fs.resolvePath(d, e.cwd);
        if (o) {
          const f = u.split("/").filter((h) => h !== "" && h !== "."), p = [];
          for (const h of f)
            h === ".." ? p.length > 0 && p.pop() : p.push(h);
          u = "/" + p.join("/");
        }
        await e.fs.exists(u) ? i.push(u) : r || a.push(`realpath: ${d}: No such file or directory`);
      } catch (u) {
        r || a.push(`realpath: ${d}: ${u instanceof Error ? u.message : u}`);
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
    const { flags: t, positional: s } = parseArgs(n), r = t.r || t.R, o = t.f;
    if (s.length === 0 && !o)
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
          if (o) continue;
          return { stdout: "", stderr: `rm: cannot remove '${a}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `rm: cannot remove '${a}': Is a directory
`, exitCode: 1 };
          await i(c);
        } else
          await e.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, sed = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n), r = t.i, o = s.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const i = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!i)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
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
      if (r && h.length > 0) {
        for (const g of h) {
          const x = e.fs.resolvePath(g, e.cwd), w = (await e.fs.readFile(x)).split(`
`).map((S) => S.replace(f, c)).join(`
`);
          await e.fs.writeFile(x, w);
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["separator", "s", "format", "f"]);
    if (r.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let o = 1, i = 1, a;
    if (r.length === 1 ? a = parseFloat(r[0]) : r.length === 2 ? (o = parseFloat(r[0]), a = parseFloat(r[1])) : r.length >= 3 ? (o = parseFloat(r[0]), i = parseFloat(r[1]), a = parseFloat(r[2])) : a = 1, isNaN(o) || isNaN(i) || isNaN(a))
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
      for (let h = o; h <= a; h += i)
        u.push(String(h));
    else
      for (let h = o; h >= a; h += i)
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["e", "u", "x", "v", "n", "o"]);
    if (n.length === 0) {
      const o = Object.entries(e.env || {}).map(([i, a]) => `${i}=${a}`).join(`
`);
      return {
        stdout: o ? o + `
` : "",
        stderr: "",
        exitCode: 0
      };
    }
    if (t.o || s.o) {
      const o = s.o || r[0], i = [
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
      return o ? i.includes(o) ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `set: ${o}: invalid option name
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
    const { flags: t, positional: s } = parseArgs(n), r = t.c || t.check, o = t.b || t.binary;
    if (r)
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
        const d = await sha256(l), u = o ? "*" : " ";
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
    const r = new e.TextEncoder().encode(n), o = await e.crypto.subtle.digest("SHA-256", r);
    return Array.from(new e.Uint8Array(o)).map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  let t = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    t = (t << 5) - t + r, t = t & t;
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
}, PASSAGES = [
  "The Lord is my shepherd; I shall not want.",
  "Be still and know that I am God.",
  "Ask and it shall be given unto you.",
  "I am the way, the truth, and the life.",
  "Let there be light.",
  "In the beginning was the Word.",
  "Faith can move mountains.",
  "The truth shall set you free.",
  "Love thy neighbor as thyself.",
  "Seek and ye shall find.",
  "Blessed are the pure in heart.",
  "I have called you by name; you are mine.",
  "Fear not, for I am with you.",
  "Come unto me, all ye that labor.",
  "Behold, I stand at the door and knock.",
  "The heavens declare the glory of God.",
  "Thou shalt have no other gods before me.",
  "For God so loved the world.",
  "Be strong and of good courage.",
  "My grace is sufficient for thee."
], RESET = "\x1B[0m", BOLD = "\x1B[1m", DIM = "\x1B[2m", YELLOW = "\x1B[33m", CYAN = "\x1B[36m", WHITE = "\x1B[97m", MAGENTA = "\x1B[35m", RED = "\x1B[31m", GOLD = "\x1B[93m";
function getRandomPassage() {
  return PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
}
function visibleLength(n) {
  return n.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function padCenter(n, e) {
  const t = visibleLength(n), s = e - t, r = Math.floor(s / 2), o = s - r;
  return " ".repeat(Math.max(0, r)) + n + " ".repeat(Math.max(0, o));
}
function wrapText(n, e) {
  const t = n.split(" "), s = [];
  let r = "";
  for (const o of t)
    r.length + o.length + 1 <= e ? r += (r ? " " : "") + o : (r && s.push(r), r = o);
  return r && s.push(r), s;
}
const shrine = {
  name: "shrine",
  description: "A tribute to Terry A. Davis, creator of TempleOS (1969-2018)",
  async exec() {
    const n = getRandomPassage(), e = 40, t = wrapText(n, e - 4), s = [];
    s.push(`${GOLD}                        ┼${RESET}`), s.push(`${GOLD}                       ╱│╲${RESET}`), s.push(`${GOLD}                      ╱ │ ╲${RESET}`), s.push(`${GOLD}    ╔═══════════════╦═══╪═══╦═══════════════╗${RESET}`), s.push(`${GOLD}    ║${CYAN}░░░░░░░░░░░░░░░${GOLD}║${YELLOW}   ┼   ${GOLD}║${CYAN}░░░░░░░░░░░░░░░${GOLD}║${RESET}`), s.push(`${GOLD}    ╠═══════════════╩═══════╩═══════════════╣${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${BOLD}${WHITE}✟  TERRY A. DAVIS  ✟${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}December 15, 1969 — August 11, 2018${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${RED})  (  (${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${YELLOW}(  )  )  )${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${RED}) (  (  ) (${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${MAGENTA}\\\\║//${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}~ God Says ~${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${" ".repeat(e)}${GOLD}║${RESET}`);
    for (const r of t)
      s.push(`${GOLD}    ║${RESET}${padCenter(`${CYAN}${r}${RESET}`, e)}${GOLD}║${RESET}`);
    return s.push(`${GOLD}    ║${RESET}${" ".repeat(e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}Creator of TempleOS${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}640x480 · 16 Colors · HolyC${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}"God's Third Temple"${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`), s.push(`${GOLD}    ║${RESET}${" ".repeat(e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${BOLD}${WHITE}☆ REST IN PEACE ☆${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${padCenter(`${CYAN}Programmer · Prophet · Pioneer${RESET}`, e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ║${RESET}${" ".repeat(e)}${GOLD}║${RESET}`), s.push(`${GOLD}    ╚════════════════════════════════════════╝${RESET}`), s.push(`${GOLD}         ╲▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂╱${RESET}`), s.push(`${DIM}            ∙ Run again for new passage ∙${RESET}`), s.push(""), {
      stdout: s.join(`
`),
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
    let r = 0;
    const o = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
    if (!o)
      return {
        stdout: "",
        stderr: `sleep: invalid time interval '${s}'
`,
        exitCode: 1
      };
    const i = parseFloat(o[1]);
    switch (o[2] || "s") {
      case "s":
        r = i;
        break;
      case "m":
        r = i * 60;
        break;
      case "h":
        r = i * 3600;
        break;
      case "d":
        r = i * 86400;
        break;
    }
    return await new Promise((c) => globalThis.setTimeout(c, r * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, sort = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n);
    try {
      const { content: r } = await readInput(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let o = r.split(`
`).filter(Boolean);
      return t.n ? o.sort((i, a) => parseFloat(i) - parseFloat(a)) : o.sort(), t.u && (o = [...new Set(o)]), t.r && o.reverse(), { stdout: o.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `sort: ${r instanceof Error ? r.message : r}
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
      const r = e.fs.resolvePath(s, e.cwd), o = await e.fs.readFile(r);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    } catch (r) {
      return {
        stdout: "",
        stderr: `source: ${s}: ${r instanceof Error ? r.message : r}
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
    const { positional: t, flags: s, values: r } = parseArgs(n, ["c", "format"]);
    if (t.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const o = r.c || r.format, i = s.t;
    s.f;
    const a = [];
    try {
      for (const c of t) {
        const l = e.fs.resolvePath(c, e.cwd);
        try {
          const d = await e.fs.stat(l);
          if (o) {
            const u = formatStat(c, d, o);
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["n", "bytes"]), o = parseInt(t.n || t.bytes || "4", 10), i = r.f;
    r.a;
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
        const f = extractStrings(d, o);
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
  let r = "";
  for (let o = 0; o < n.length; o++) {
    const i = n[o];
    s.test(i) ? r += i : (r.length >= e && t.push(r), r = "");
  }
  return r.length >= e && t.push(r), t;
}
const tail = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, e) {
    const t = n.flatMap((i) => {
      const a = i.match(/^-(\d+)$/);
      return a ? ["-n", a[1]] : [i];
    }), { values: s, positional: r } = parseArgs(t, ["n"]), o = parseInt(s.n ?? "10", 10);
    try {
      const { content: i } = await readInput(
        r,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: i.split(`
`).slice(-o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `tail: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, tar = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = parseArgs(n, ["f", "C"]), o = t.c || t.create, i = t.x || t.extract, a = t.t || t.list, c = t.v || t.verbose, l = s.f, d = s.C;
    let u = e.cwd;
    d && (u = e.fs.resolvePath(d, e.cwd));
    const f = [o, i, a].filter(Boolean).length;
    if (f === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (f > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (o) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = r;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const h = [];
        async function m(w, S) {
          const $ = e.fs.resolvePath(w, u);
          if ((await e.fs.stat($)).type === "dir") {
            h.push({ path: S + "/", content: "", isDir: !0 });
            const b = await e.fs.readdir($);
            for (const v of b)
              await m($ + "/" + v.name, S + "/" + v.name);
          } else {
            const b = await e.fs.readFile($);
            h.push({ path: S, content: b, isDir: !1 });
          }
        }
        for (const w of p)
          await m(w, w);
        const g = ["FLUFFY-TAR-V1"];
        for (const w of h)
          c && console.error(w.path), g.push(`FILE:${w.path}`), g.push(`SIZE:${w.content.length}`), g.push(`TYPE:${w.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(w.content), g.push("DATA-END");
        const x = g.join(`
`), y = e.fs.resolvePath(l, e.cwd);
        return await e.fs.writeFile(y, x), {
          stdout: c ? h.map((w) => w.path).join(`
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
          const y = m[g].slice(5), w = parseInt(m[g + 1].slice(5), 10), S = m[g + 2].slice(5);
          g += 4;
          const $ = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            $.push(m[g]), g++;
          const C = $.join(`
`);
          g++;
          const b = e.fs.resolvePath(y, u);
          if (S === "dir")
            await e.fs.mkdir(b, { recursive: !0 });
          else {
            const v = b.lastIndexOf("/");
            if (v > 0) {
              const E = b.slice(0, v);
              try {
                await e.fs.mkdir(E, { recursive: !0 });
              } catch {
              }
            }
            await e.fs.writeFile(b, C);
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
    const { flags: t, positional: s } = parseArgs(n), r = t.a, o = e.stdin;
    try {
      for (const i of s) {
        const a = e.fs.resolvePath(i, e.cwd);
        if (r) {
          let c = "";
          try {
            c = await e.fs.readFile(a);
          } catch {
          }
          await e.fs.writeFile(a, c + o);
        } else
          await e.fs.writeFile(a, o);
      }
      return { stdout: o, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: o, stderr: `tee: ${i instanceof Error ? i.message : i}
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
  var r, o;
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
              const l = await ((o = (r = e.fs).readFile) == null ? void 0 : o.call(r, c));
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
    const r = s.v || s.verbose, o = s.p, i = t.join(" "), a = globalThis.performance, c = a ? a.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const u = ((a ? a.now() : Date.now()) - c) / 1e3, f = Math.floor(u / 60), p = u % 60;
    let h;
    return o ? h = `real ${u.toFixed(2)}
user 0.00
sys 0.00
` : r ? h = `        ${u.toFixed(3)} real         0.000 user         0.000 sys
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
    const { positional: t, flags: s, values: r } = parseArgs(n, ["k", "kill-after", "s", "signal"]);
    if (t.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const o = t[0], i = t.slice(1);
    if (i.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let a = parseDuration(o);
    if (a === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${o}'
`,
        exitCode: 1
      };
    r.k || r["kill-after"];
    const c = r.s || r.signal || "TERM", l = s["preserve-status"];
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
    const r = s.c;
    try {
      for (const o of t) {
        const i = e.fs.resolvePath(o, e.cwd);
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
          if (r)
            continue;
          await e.fs.writeFile(i, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `touch: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, tr = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, e) {
    const { flags: t, positional: s } = parseArgs(n, []), r = t.d, o = t.s, i = t.c || t.C, a = t.t;
    let c = expandSet(s[0] ?? ""), l = expandSet(s[1] ?? "");
    const d = e.stdin;
    i && c && (c = getComplement(c)), a && l && (c = c.slice(0, l.length));
    let u;
    if (r) {
      const f = new Set(c.split(""));
      u = d.split("").filter((p) => !f.has(p)).join("");
    } else if (c && l) {
      const f = /* @__PURE__ */ new Map();
      for (let p = 0; p < c.length; p++)
        f.set(c[p], l[Math.min(p, l.length - 1)]);
      u = d.split("").map((p) => f.get(p) ?? p).join("");
    } else
      u = d;
    if (o) {
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
      const r = e.charCodeAt(s), o = e.charCodeAt(s + 2);
      for (let i = r; i <= o; i++)
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
      const r = String.fromCharCode(s);
      e.has(r) || (t += r);
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
      stdout: s.map((o) => `# trap for ${o} would be shown here`).join(`
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
    const { flags: t, values: s, positional: r } = parseArgs(n, ["l", "L", "s"]);
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
    const o = s.s || "TERM";
    return r.length === 0 ? {
      stdout: "",
      stderr: `kill: usage: kill [-s SIGNAL] PID...
`,
      exitCode: 1
    } : {
      stdout: "",
      stderr: `kill: sending signal ${o} to processes: ${r.join(", ")}
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
    const r = s.trim().split(/\s+/).filter(Boolean);
    if (r.length % 2 !== 0)
      return {
        stdout: "",
        stderr: `tsort: odd number of tokens
`,
        exitCode: 1
      };
    const o = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Set();
    for (let d = 0; d < r.length; d += 2) {
      const u = r[d], f = r[d + 1];
      a.add(u), a.add(f), o.has(u) || o.set(u, /* @__PURE__ */ new Set()), o.get(u).add(f);
    }
    for (const d of a)
      i.has(d) || i.set(d, 0);
    for (const [d, u] of o)
      for (const f of u)
        i.set(f, (i.get(f) || 0) + 1);
    const c = [], l = [];
    for (const [d, u] of i)
      u === 0 && c.push(d);
    for (c.sort(); c.length > 0; ) {
      c.sort();
      const d = c.shift();
      l.push(d);
      const u = o.get(d);
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
    const r = s.a, o = s.t, i = s.p, a = [];
    let c = 0;
    for (const l of t) {
      const d = (e.env.PATH || "/bin:/usr/bin").split(":");
      let u = !1;
      for (const f of d) {
        const p = f + "/" + l;
        try {
          if (await e.fs.exists(p) && (u = !0, o ? a.push("file") : i ? a.push(p) : a.push(`${l} is ${p}`), !r))
            break;
        } catch {
        }
      }
      u || (!o && !i && a.push(`type: ${l}: not found`), c = 1);
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
    const r = t.a || t.all, o = {
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
    if (r)
      return {
        stdout: Object.entries(o).map(([l, { value: d, unit: u }]) => {
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
    const a = o[i];
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
    const { flags: t, positional: s } = parseArgs(n, ["S", "p"]), r = t.S, o = t.p, i = "0022";
    if (s.length === 0)
      if (r) {
        const c = parseInt(i, 8);
        return {
          stdout: maskToSymbolic(c) + `
`,
          stderr: "",
          exitCode: 0
        };
      } else return o ? {
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
  const e = 511 & ~n, t = e >> 6 & 7, s = e >> 3 & 7, r = e & 7, o = (i) => (i & 4 ? "r" : "-") + (i & 2 ? "w" : "-") + (i & 1 ? "x" : "-");
  return `u=${o(t)},g=${o(s)},o=${o(r)}`;
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
    const { values: t, positional: s, flags: r } = parseArgs(n, ["t", "tabs"]), o = t.t || t.tabs || "8", i = parseInt(o, 10);
    if (isNaN(i) || i <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const a = r.a || r.all;
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["f", "s", "w"]), o = r.f ? parseInt(r.f) : 0, i = r.s ? parseInt(r.s) : 0, a = r.w ? parseInt(r.w) : void 0, c = t.i;
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
        const g = getComparisonKey(m, o, i, a, c);
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
function getComparisonKey(n, e, t, s, r) {
  let o = n;
  return e > 0 && (o = n.split(/\s+/).slice(e).join(" ")), t > 0 && (o = o.substring(t)), s !== void 0 && (o = o.substring(0, s)), r && (o = o.toLowerCase()), o;
}
function emitLine(n, e, t, s) {
  t.d && e < 2 || t.u && e > 1 || (t.c ? s.push(`${String(e).padStart(7)} ${n}`) : s.push(n));
}
const uname = {
  name: "uname",
  description: "Print system information",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.a, r = e.env.UNAME_SYSNAME ?? "FluffyOS", o = e.env.HOSTNAME ?? "localhost", i = e.env.UNAME_RELEASE ?? "1.0.0", a = e.env.UNAME_VERSION ?? "#1", c = e.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${r} ${o} ${i} ${a} ${c}
`, stderr: "", exitCode: 0 };
    if (t.s || !t.n && !t.r && !t.v && !t.m)
      return { stdout: r + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return t.s && l.push(r), t.n && l.push(o), t.r && l.push(i), t.v && l.push(a), t.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, uptime = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, e) {
    const { flags: t } = parseArgs(n), s = t.p || t.pretty, r = t.s || t.since, o = 86400 + 3600 * 5 + 1380, i = Math.floor(o / 86400), a = Math.floor(o % 86400 / 3600), c = Math.floor(o % 3600 / 60), l = /* @__PURE__ */ new Date(), d = new Date(l.getTime() - o * 1e3), u = [];
    if (r)
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
    const { values: t, positional: s, flags: r } = parseArgs(n, [
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
    if (r.help)
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
    const o = parseFloat(t.n || t.interval || "2"), i = s.join(" ");
    return {
      stdout: (r.t || r["no-title"] ? "" : `Every ${o}s: ${i}

`) + `watch: This is a stub implementation.
In a real shell, this would execute '${i}' every ${o} seconds.

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
    const { flags: t, positional: s } = parseArgs(n), r = t.l, o = t.w, i = t.c, a = !r && !o && !i;
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
      return (a || r) && p.push(String(d).padStart(6)), (a || o) && p.push(String(u).padStart(6)), (a || i) && p.push(String(f).padStart(6)), l.length === 1 && p.push(" " + s[0]), { stdout: p.join(" ") + `
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
    const { flags: t, positional: s } = parseArgs(n), r = t.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = s[0], i = e.env.PATH || "/bin:/usr/bin:/usr/local/bin", a = i.split(":"), c = [];
    for (const l of a) {
      const d = `${l}/${o}`;
      try {
        if (await e.fs.exists(d) && (await e.fs.stat(d)).type === "file" && (c.push(d), !r))
          break;
      } catch {
        continue;
      }
    }
    return c.length === 0 ? {
      stdout: "",
      stderr: `which: no ${o} in (${i})
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
    const { flags: t, positional: s, values: r } = parseArgs(n, ["n", "I", "i", "d", "delimiter"]), o = t.I || t.L || t.l, i = r.I || r.i, a = r.n ? parseInt(r.n) : void 0, c = r.d || r.delimiter || /\s+/, l = t.t || t.verbose, d = t.r, u = s.length > 0 ? s.join(" ") : "echo";
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
    else if (o)
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
    const { positional: t } = parseArgs(n), s = t.length > 0 ? t.join(" ") : "y", r = [], o = 1e3;
    for (let i = 0; i < o; i++)
      r.push(s);
    return {
      stdout: r.join(`
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
  shrine,
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
  shrine,
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
