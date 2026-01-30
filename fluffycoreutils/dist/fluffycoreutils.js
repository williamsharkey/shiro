function y(n, e = []) {
  const t = {}, s = {}, r = [], o = new Set(e);
  for (let a = 0; a < n.length; a++) {
    const i = n[a];
    if (i === "--") {
      r.push(...n.slice(a + 1));
      break;
    }
    if (i.startsWith("--")) {
      const c = i.slice(2);
      o.has(c) && a + 1 < n.length ? s[c] = n[++a] : t[c] = !0;
    } else if (i.startsWith("-") && i.length > 1 && !/^-\d/.test(i)) {
      const c = i.slice(1);
      if (o.has(c) && a + 1 < n.length)
        s[c] = n[++a];
      else
        for (let l = 0; l < c.length; l++) {
          const u = c[l];
          if (o.has(u)) {
            const d = c.slice(l + 1);
            d ? s[u] = d : a + 1 < n.length && (s[u] = n[++a]);
            break;
          }
          t[u] = !0;
        }
    } else
      r.push(i);
  }
  return { flags: t, values: s, positional: r };
}
async function j(n, e, t, s, r) {
  if (n.length === 0)
    return { content: e, files: [] };
  const o = [], a = [];
  for (const i of n) {
    const c = r(i, s);
    o.push(c), a.push(await t.readFile(c));
  }
  return { content: a.join(""), files: o };
}
const X = {
  name: "alias",
  description: "Define or display aliases",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
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
}, Q = {
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
}, ee = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, e) {
    const { values: t, positional: s } = y(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const r = s[0], o = s.slice(1), a = t.F || /\s+/, i = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (t.v) {
      const l = t.v.split("=");
      l.length === 2 && (c[l[0]] = l[1]);
    }
    try {
      const { content: l } = await j(
        o,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), u = l.split(`
`).filter((x) => x !== "" || l.endsWith(`
`)), d = [], p = r.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), f = r.match(/END\s*\{\s*([^}]*)\s*\}/), h = r.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let m = 0, g = 0;
      if (p) {
        const x = D(p[1], [], 0, 0, c);
        x && d.push(x);
      }
      for (const x of u) {
        m++;
        const w = x.split(i).filter((b) => b !== "");
        g = w.length;
        let C = !0;
        if (h) {
          const b = h[1], v = h[2];
          if (b)
            try {
              C = new RegExp(b).test(x);
            } catch {
              C = !1;
            }
          if (C) {
            const $ = D(v, w, m, g, c);
            $ !== null && d.push($);
          }
        } else if (!p && !f) {
          const b = D(r, w, m, g, c);
          b !== null && d.push(b);
        }
      }
      if (f) {
        const x = D(f[1], [], m, 0, c);
        x && d.push(x);
      }
      return {
        stdout: d.join(`
`) + (d.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (l) {
      return {
        stdout: "",
        stderr: `awk: ${l instanceof Error ? l.message : l}
`,
        exitCode: 1
      };
    }
  }
};
function D(n, e, t, s, r) {
  let o = n.trim();
  if (o.startsWith("print")) {
    const a = o.substring(5).trim();
    if (!a || a === "")
      return e.join(" ");
    let i = a;
    i = i.replace(/\$0/g, e.join(" ")), i = i.replace(/\$NF/g, e[e.length - 1] || "");
    for (let c = 1; c <= e.length; c++)
      i = i.replace(new RegExp(`\\$${c}`, "g"), e[c - 1] || "");
    i = i.replace(/\bNR\b/g, String(t)), i = i.replace(/\bNF\b/g, String(s));
    for (const [c, l] of Object.entries(r))
      i = i.replace(new RegExp(`\\b${c}\\b`, "g"), l);
    return i = i.replace(/^["'](.*)["']$/, "$1"), i = i.replace(/\s+/g, " ").trim(), i;
  }
  return null;
}
const te = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.d || t.decode, o = t.w ? parseInt(t.w) : 76, a = t.i || t["ignore-garbage"];
    try {
      const { content: i } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let c;
      if (r) {
        const l = a ? i.replace(/[^A-Za-z0-9+/=]/g, "") : i.replace(/\s/g, "");
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
        const l = globalThis.btoa(i);
        if (o > 0) {
          const u = [];
          for (let d = 0; d < l.length; d += o)
            u.push(l.substring(d, d + o));
          c = u.join(`
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
    } catch (i) {
      return {
        stdout: "",
        stderr: `base64: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
}, se = {
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
}, ne = {
  name: "break",
  description: "Exit from a for, while, or until loop",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? parseInt(t[0]) : 1;
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
}, re = {
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
}, oe = {
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
}, ie = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    try {
      const { content: r } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return t.n ? { stdout: r.split(`
`).map((i, c) => `${String(c + 1).padStart(6)}	${i}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: r, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `cat: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, Y = {
  name: "gcc",
  description: "GNU C Compiler (stub)",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, [
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
    const o = r, a = s.o || "a.out";
    for (const p of o) {
      const f = e.fs.resolvePath(p, e.cwd);
      if (!await e.fs.exists(f))
        return {
          stdout: "",
          stderr: `gcc: error: ${p}: No such file or directory
gcc: fatal error: no input files
compilation terminated.
`,
          exitCode: 1
        };
    }
    let i = !1, c = "";
    for (const p of o)
      if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp"))
        try {
          const f = e.fs.resolvePath(p, e.cwd), h = await e.fs.readFile(f);
          c += h + `
`, (/int\s+main\s*\(/.test(h) || /void\s+main\s*\(/.test(h)) && (i = !0);
        } catch (f) {
          return {
            stdout: "",
            stderr: `gcc: error: ${p}: ${f.message}
`,
            exitCode: 1
          };
        }
    if (t.E)
      return {
        stdout: c.split(`
`).filter((f) => !f.trim().startsWith("#")).join(`
`),
        stderr: "",
        exitCode: 0
      };
    if (t.c) {
      for (const p of o)
        if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp")) {
          const f = p.replace(/\.(c|cc|cpp)$/, ".o"), h = e.fs.resolvePath(f, e.cwd);
          await e.fs.writeFile(h, `# Object file stub for ${p}
`);
        }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    if (t.S) {
      for (const p of o)
        if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp")) {
          const f = p.replace(/\.(c|cc|cpp)$/, ".s"), h = e.fs.resolvePath(f, e.cwd);
          await e.fs.writeFile(h, `# Assembly stub for ${p}
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
    if (!i && !t.shared && !t.c)
      return {
        stdout: "",
        stderr: `gcc: error: undefined reference to 'main'
collect2: error: ld returned 1 exit status
`,
        exitCode: 1
      };
    const l = e.fs.resolvePath(a, e.cwd), u = /printf\s*\(\s*["'].*[Hh]ello.*["']/.test(c) || /puts\s*\(\s*["'].*[Hh]ello.*["']/.test(c);
    let d = `#!/bin/sh
`;
    return u ? d += `echo 'Hello, World!'
` : d += `# Compiled binary stub
`, await e.fs.writeFile(l, d), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, ae = {
  name: "cc",
  description: "C Compiler (alias for gcc)",
  async exec(n, e) {
    return Y.exec(n, e);
  }
}, ce = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = s[0], a = s.slice(1), i = parseInt(o, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function c(l) {
      const u = e.fs.resolvePath(l, e.cwd);
      if (r)
        try {
          if ((await e.fs.stat(u)).type === "dir") {
            const p = await e.fs.readdir(u);
            for (const f of p)
              await c(u + "/" + f.name);
          }
        } catch {
        }
    }
    try {
      for (const l of a)
        await c(l);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `chmod: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
}, le = {
  name: "chown",
  description: "Change file owner and group",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    if (s.length < 2)
      return { stdout: "", stderr: `chown: missing operand
`, exitCode: 1 };
    const r = s[0], o = s.slice(1);
    t.R;
    const a = t.v, i = r.split(":");
    i[0], i[1];
    const c = [];
    try {
      for (const l of o)
        a && c.push(`ownership of '${l}' retained as ${r}`);
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
}, de = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, ue = {
  name: "column",
  description: "Format input into columns",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["t", "s", "c", "x", "n"]);
    try {
      const { content: o } = await j(
        r,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), a = o.split(`
`);
      if (a.length > 0 && a[a.length - 1] === "" && a.pop(), t.t) {
        const p = s.s || "	", f = new RegExp(p), h = a.map((w) => w.split(f)), m = Math.max(...h.map((w) => w.length)), g = new Array(m).fill(0);
        for (const w of h)
          for (let C = 0; C < w.length; C++)
            g[C] = Math.max(g[C] || 0, w[C].length);
        const x = h.map((w) => w.map((C, b) => {
          const v = g[b];
          return C.padEnd(v);
        }).join("  ")).join(`
`);
        return {
          stdout: x ? x + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      const i = s.c ? parseInt(s.c) : 80, c = a.flatMap((p) => p.split(/\s+/).filter((f) => f));
      if (c.length === 0)
        return { stdout: "", stderr: "", exitCode: 0 };
      const u = Math.max(...c.map((p) => p.length)) + 2, d = Math.max(1, Math.floor(i / u));
      if (t.x) {
        const p = Math.ceil(c.length / d), f = Array(p).fill(null).map(() => []);
        for (let m = 0; m < c.length; m++) {
          const g = m % p;
          f[g].push(c[m]);
        }
        const h = f.map((m) => m.map((g) => g.padEnd(u)).join("").trimEnd()).join(`
`);
        return {
          stdout: h ? h + `
` : "",
          stderr: "",
          exitCode: 0
        };
      } else {
        const p = [];
        for (let f = 0; f < c.length; f += d) {
          const h = c.slice(f, f + d);
          p.push(h.map((m) => m.padEnd(u)).join("").trimEnd());
        }
        return {
          stdout: p.join(`
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
}, fe = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `comm: missing operand
`,
        exitCode: 1
      };
    const r = t[1], o = t[2], a = t[3];
    try {
      const i = e.fs.resolvePath(s[0], e.cwd), c = e.fs.resolvePath(s[1], e.cwd), l = await e.fs.readFile(i), u = await e.fs.readFile(c), d = l.split(`
`).filter((g) => g !== "" || l.endsWith(`
`)), p = u.split(`
`).filter((g) => g !== "" || u.endsWith(`
`));
      d.length > 0 && d[d.length - 1] === "" && d.pop(), p.length > 0 && p[p.length - 1] === "" && p.pop();
      const f = [];
      let h = 0, m = 0;
      for (; h < d.length || m < p.length; ) {
        const g = h < d.length ? d[h] : null, x = m < p.length ? p[m] : null;
        if (g === null) {
          if (!o) {
            const w = r ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else if (x === null)
          r || f.push(g), h++;
        else if (g < x)
          r || f.push(g), h++;
        else if (g > x) {
          if (!o) {
            const w = r ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else {
          if (!a) {
            let w = "";
            r || (w += "	"), o || (w += "	"), f.push(w + g);
          }
          h++, m++;
        }
      }
      return {
        stdout: f.join(`
`) + (f.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (i) {
      return {
        stdout: "",
        stderr: `comm: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
}, pe = {
  name: "continue",
  description: "Continue to next iteration of a for, while, or until loop",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? parseInt(t[0]) : 1;
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
}, he = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.r || t.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const o = e.fs.resolvePath(s[s.length - 1], e.cwd), a = s.slice(0, -1);
    let i = !1;
    try {
      i = (await e.fs.stat(o)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !i)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(u, d) {
      const p = await e.fs.readFile(u);
      await e.fs.writeFile(d, p);
    }
    async function l(u, d) {
      await e.fs.mkdir(d, { recursive: !0 });
      const p = await e.fs.readdir(u);
      for (const f of p) {
        const h = u + "/" + f.name, m = d + "/" + f.name;
        f.type === "dir" ? await l(h, m) : await c(h, m);
      }
    }
    try {
      for (const u of a) {
        const d = e.fs.resolvePath(u, e.cwd), p = await e.fs.stat(d), f = u.split("/").pop(), h = i ? o + "/" + f : o;
        if (p.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${u}'
`, exitCode: 1 };
          await l(d, h);
        } else
          await c(d, h);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `cp: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, me = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (r.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = r[0], a = s.X || s.request || (s.d || s.data ? "POST" : "GET"), i = s.o || s.output, c = t.s || t.silent, l = t.i || t.include, u = t.I || t.head, d = t.L || t.location, p = {}, f = s.H || s.header;
    if (f) {
      const g = f.split(":");
      g.length >= 2 && (p[g[0].trim()] = g.slice(1).join(":").trim());
    }
    const h = s["user-agent"] || "fluffycoreutils-curl/0.1.0";
    p["User-Agent"] = h;
    let m;
    (s.d || s.data) && (m = s.d || s.data, p["Content-Type"] || (p["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const g = {
        method: u ? "HEAD" : a,
        headers: p,
        redirect: d ? "follow" : "manual"
      };
      m && a !== "GET" && a !== "HEAD" && (g.body = m);
      const x = await fetch(o, g);
      let w = "";
      if ((l || u) && (w += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((C, b) => {
        w += `${b}: ${C}
`;
      }), w += `
`), !u) {
        const C = await x.text();
        w += C;
      }
      if (i) {
        const C = e.fs.resolvePath(i, e.cwd);
        return await e.fs.writeFile(C, u ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${w.length}  100  ${w.length}    0     0   ${w.length}      0 --:--:-- --:--:-- --:--:--  ${w.length}
`,
          exitCode: 0
        };
      }
      return !c && !x.ok ? {
        stdout: w,
        stderr: `curl: (22) The requested URL returned error: ${x.status}
`,
        exitCode: 22
      } : { stdout: w, stderr: "", exitCode: 0 };
    } catch (g) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${g instanceof Error ? g.message : String(g)}
`,
        exitCode: 6
      };
    }
  }
}, ge = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, e) {
    const { values: t, positional: s } = y(n, ["d", "f", "c"]), r = t.d ?? "	", o = t.f, a = t.c;
    if (!o && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = xe(o ?? a), l = i.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const u = [];
      for (const d of l)
        if (o) {
          const p = d.split(r), f = c.flatMap((h) => p.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          u.push(f.join(r));
        } else {
          const p = d.split(""), f = c.flatMap((h) => p.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          u.push(f.join(""));
        }
      return { stdout: u.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `cut: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
};
function xe(n) {
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
const ye = {
  name: "date",
  description: "Display date and time",
  async exec(n, e) {
    const { flags: t, positional: s, values: r } = y(n, ["d", "date", "r", "reference", "u"]);
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
    const a = t.u || t.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const c = s[0].slice(1);
      return { stdout: we(o, c, a) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (a ? o.toUTCString() : o.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function we(n, e, t = !1) {
  const s = (w) => String(w).padStart(2, "0"), r = (w) => String(w).padStart(3, "0"), o = (w) => t ? n[`getUTC${w}`]() : n[`get${w}`](), a = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], c = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], u = o("FullYear"), d = o("Month"), p = o("Date"), f = o("Hours"), h = o("Minutes"), m = o("Seconds"), g = o("Milliseconds"), x = o("Day");
  return e.replace(/%Y/g, String(u)).replace(/%y/g, String(u).slice(-2)).replace(/%m/g, s(d + 1)).replace(/%d/g, s(p)).replace(/%e/g, String(p).padStart(2, " ")).replace(/%H/g, s(f)).replace(/%I/g, s(f % 12 || 12)).replace(/%M/g, s(h)).replace(/%S/g, s(m)).replace(/%N/g, r(g) + "000000").replace(/%p/g, f >= 12 ? "PM" : "AM").replace(/%P/g, f >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, a[x]).replace(/%a/g, i[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, c[d]).replace(/%b/g, l[d]).replace(/%h/g, l[d]).replace(/%F/g, `${u}-${s(d + 1)}-${s(p)}`).replace(/%T/g, `${s(f)}:${s(h)}:${s(m)}`).replace(/%R/g, `${s(f)}:${s(h)}`).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const ve = {
  name: "local",
  description: "Declare local variables in shell functions",
  async exec(n, e) {
    const { positional: t } = y(n, ["r", "a", "i", "x"]);
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
}, Ce = {
  name: "declare",
  description: "Declare variables and give them attributes",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n, ["r", "a", "A", "i", "x", "p", "f", "g"]);
    if (t.p)
      return s.length === 0 ? {
        stdout: `# Shell variables would be listed here
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: s.map((o) => {
          const a = e.env[o];
          return a !== void 0 ? `declare -- ${o}="${a}"
` : "";
        }).join(""),
        stderr: "",
        exitCode: 0
      };
    for (const r of s) {
      const [o, a] = r.split("=", 2);
      a !== void 0 && e.env && (e.env[o] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, $e = {
  name: "readonly",
  description: "Mark variables as readonly",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n, ["p", "f"]);
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
      const [o, a] = r.split("=", 2);
      a !== void 0 && e.env && (e.env[o] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, be = {
  name: "unset",
  description: "Unset variables or functions",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n, ["v", "f"]);
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
}, Se = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(n, e) {
    const { flags: t } = y(n), s = t.h, r = t.i, o = [];
    return r ? (o.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on"), o.push("virtual             0      0       0    0% /")) : s ? (o.push("Filesystem      Size  Used Avail Use% Mounted on"), o.push("virtual         100G   10G   90G  10% /")) : (o.push("Filesystem     1K-blocks    Used Available Use% Mounted on"), o.push("virtual        104857600 10485760  94371840  10% /")), {
      stdout: o.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Pe = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, e) {
    var p, f;
    const { flags: t, positional: s, values: r } = y(n, ["U", "context", "C"]), o = t.u || r.U !== void 0, a = r.U || r.context || r.C || (t.u ? 3 : 0), i = typeof a == "string" ? parseInt(a) : 3, c = t.q || t.brief, l = t.i, u = t.w || t["ignore-all-space"], d = t.y || t["side-by-side"];
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
      const w = g.split(`
`), C = x.split(`
`), b = Ee(w, C, { ignoreCase: l, ignoreWhitespace: u }), v = [];
      if (o) {
        v.push(`--- ${s[0]}`), v.push(`+++ ${s[1]}`);
        let $ = 0;
        for (; $ < b.length; ) {
          if (b[$].type === "equal") {
            $++;
            continue;
          }
          const P = Math.max(0, $ - 1);
          let E = $;
          for (; E < b.length; ) {
            const I = b[E];
            if (I.type !== "equal")
              E++;
            else if (I.lines.length <= i * 2)
              E++;
            else
              break;
          }
          const F = (((p = b[P]) == null ? void 0 : p.line1) ?? 0) + 1, k = (((f = b[P]) == null ? void 0 : f.line2) ?? 0) + 1;
          let N = 0, M = 0;
          for (let I = P; I < E; I++)
            (b[I].type === "equal" || b[I].type === "delete") && (N += b[I].lines.length), (b[I].type === "equal" || b[I].type === "add") && (M += b[I].lines.length);
          v.push(`@@ -${F},${N} +${k},${M} @@`);
          for (let I = P; I < E; I++) {
            const T = b[I];
            T.type === "equal" ? T.lines.forEach((R) => v.push(` ${R}`)) : T.type === "delete" ? T.lines.forEach((R) => v.push(`-${R}`)) : T.type === "add" && T.lines.forEach((R) => v.push(`+${R}`));
          }
          $ = E;
        }
      } else if (d)
        for (const S of b)
          S.type === "equal" ? S.lines.forEach((P) => {
            const E = P.substring(0, 40).padEnd(40);
            v.push(`${E} | ${P}`);
          }) : S.type === "delete" ? S.lines.forEach((P) => {
            const E = P.substring(0, 40).padEnd(40);
            v.push(`${E} <`);
          }) : S.type === "add" && S.lines.forEach((P) => {
            v.push(`${" ".repeat(40)} > ${P}`);
          });
      else
        for (const $ of b) {
          if ($.type === "equal") continue;
          const S = ($.line1 ?? 0) + 1, P = ($.line2 ?? 0) + 1;
          $.type === "delete" ? (v.push(`${S},${S + $.lines.length - 1}d${P - 1}`), $.lines.forEach((E) => v.push(`< ${E}`))) : $.type === "add" && (v.push(`${S - 1}a${P},${P + $.lines.length - 1}`), $.lines.forEach((E) => v.push(`> ${E}`)));
        }
      return { stdout: v.join(`
`) + (v.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (h) {
      return { stdout: "", stderr: `diff: ${h instanceof Error ? h.message : h}
`, exitCode: 2 };
    }
  }
};
function Ee(n, e, t = {}) {
  const s = n.length, r = e.length, o = (u) => {
    let d = u;
    return t.ignoreWhitespace && (d = d.replace(/\s+/g, "")), t.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(s + 1).fill(0).map(() => Array(r + 1).fill(0));
  for (let u = 1; u <= s; u++)
    for (let d = 1; d <= r; d++)
      o(n[u - 1]) === o(e[d - 1]) ? a[u][d] = a[u - 1][d - 1] + 1 : a[u][d] = Math.max(a[u - 1][d], a[u][d - 1]);
  const i = [];
  let c = s, l = r;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && o(n[c - 1]) === o(e[l - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(e[l - 1]) : i.push({ type: "add", lines: [e[l - 1]], line1: c, line2: l - 1 }), l--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: l }), c--);
  return i.reverse();
}
const Ie = {
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
}, Fe = {
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
}, Te = {
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
}, je = {
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
}, Ne = {
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
}, Me = {
  name: "du",
  description: "Estimate file space usage",
  async exec(n, e) {
    const { flags: t, positional: s, values: r } = y(n, ["max-depth", "d"]), o = s.length > 0 ? s : ["."], a = t.s, i = t.a, c = t.h, l = r["max-depth"] || r.d, u = l ? parseInt(l) : 1 / 0, d = [];
    try {
      for (const p of o) {
        const f = e.fs.resolvePath(p, e.cwd), h = await Z(f, e.fs, 0, u, i, !a, d, c), m = c ? W(h) : String(Math.ceil(h / 1024));
        d.push(`${m}	${p}`);
      }
      return {
        stdout: d.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (p) {
      return {
        stdout: "",
        stderr: `du: ${p instanceof Error ? p.message : p}
`,
        exitCode: 1
      };
    }
  }
};
async function Z(n, e, t, s, r, o, a, i) {
  try {
    const c = await e.stat(n);
    if (c.type === "file")
      return c.size;
    if (c.type === "dir" && t < s) {
      const l = await e.readdir(n);
      let u = 0;
      for (const d of l) {
        const p = n + "/" + d.name, f = await Z(p, e, t + 1, s, r, o, a, i);
        if (u += f, r && d.type === "file") {
          const h = i ? W(f) : String(Math.ceil(f / 1024));
          a.push(`${h}	${p}`);
        }
        if (o && d.type === "dir" && t + 1 < s) {
          const h = i ? W(f) : String(Math.ceil(f / 1024));
          a.push(`${h}	${p}`);
        }
      }
      return u;
    }
    return 0;
  } catch {
    return 0;
  }
}
function W(n) {
  const e = ["", "K", "M", "G", "T"];
  let t = n, s = 0;
  for (; t >= 1024 && s < e.length - 1; )
    t /= 1024, s++;
  return Math.ceil(t) + e[s];
}
const Ae = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: e } = y(n), t = e.n, s = n.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let r = e.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return t || (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
  }
}, Re = {
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
}, ke = {
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
}, Oe = {
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
}, De = {
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
}, Le = {
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
}, We = {
  name: "env",
  description: "Print environment variables",
  async exec(n, e) {
    return { stdout: Object.entries(e.env).map(([s, r]) => `${s}=${r}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, Ue = {
  name: "eval",
  description: "Evaluate and execute arguments as a shell command",
  async exec(n, e) {
    const { positional: t } = y(n);
    return t.join(" "), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, qe = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? parseInt(t[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, ze = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["t", "tabs"]), o = t.t || t.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.i || r.initial;
    try {
      const { content: c } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), l = c.split(`
`), u = [];
      for (const d of l) {
        let p = "", f = 0;
        for (let h = 0; h < d.length; h++) {
          const m = d[h];
          if (m === "	")
            if (!i || i && p.trim() === "") {
              const g = a - f % a;
              p += " ".repeat(g), f += g;
            } else
              p += m, f++;
          else
            p += m, f++;
        }
        u.push(p);
      }
      return {
        stdout: u.join(`
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
}, He = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(n, e) {
    const { positional: t } = y(n);
    if (t.length === 0)
      return { stdout: "", stderr: `expr: missing operand
`, exitCode: 1 };
    try {
      const s = A(t);
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
function A(n) {
  if (n.length === 0)
    throw new Error("syntax error");
  if (n.length === 1)
    return n[0];
  for (let e = 0; e < n.length; e++)
    if (n[e] === "|") {
      const t = A(n.slice(0, e)), s = A(n.slice(e + 1));
      return t && t !== "0" && t !== "" ? t : s;
    }
  for (let e = 0; e < n.length; e++)
    if (n[e] === "&") {
      const t = A(n.slice(0, e)), s = A(n.slice(e + 1));
      return t && t !== "0" && t !== "" && s && s !== "0" && s !== "" ? t : 0;
    }
  for (let e = 0; e < n.length; e++) {
    const t = n[e];
    if (["=", "!=", "<", ">", "<=", ">="].includes(t)) {
      const s = String(A(n.slice(0, e))), r = String(A(n.slice(e + 1))), o = parseFloat(s), a = parseFloat(r), i = !isNaN(o) && !isNaN(a);
      let c = !1;
      if (i)
        switch (t) {
          case "=":
            c = o === a;
            break;
          case "!=":
            c = o !== a;
            break;
          case "<":
            c = o < a;
            break;
          case ">":
            c = o > a;
            break;
          case "<=":
            c = o <= a;
            break;
          case ">=":
            c = o >= a;
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
      const t = Number(A(n.slice(0, e))), s = Number(A(n.slice(e + 1)));
      return n[e] === "+" ? t + s : t - s;
    }
  for (let e = n.length - 1; e >= 0; e--)
    if (["*", "/", "%"].includes(n[e])) {
      const t = Number(A(n.slice(0, e))), s = Number(A(n.slice(e + 1)));
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
const Ge = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(n, e) {
    if (n.length === 0)
      return { stdout: Object.entries(e.env).map(([o, a]) => `export ${o}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const t = [], s = [];
    for (const r of n) {
      const o = r.indexOf("=");
      if (o === -1) {
        const a = r;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          s.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in e.env ? t.push(`export ${a}="${e.env[a]}"`) : t.push(`export ${a}=""`);
      } else {
        const a = r.slice(0, o);
        let i = r.slice(o + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          s.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        (i.startsWith('"') && i.endsWith('"') || i.startsWith("'") && i.endsWith("'")) && (i = i.slice(1, -1)), e.env[a] = i, t.push(`export ${a}="${i}"`);
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
}, Be = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, _e = {
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
}, Je = {
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
}, Ye = {
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
}, Ze = {
  name: "file",
  description: "Determine file type",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
    if (t.length === 0)
      return { stdout: "", stderr: `file: missing operand
`, exitCode: 1 };
    const r = s.b, o = s.i || s.mime, a = s["mime-type"], i = s["mime-encoding"], c = [];
    try {
      for (const l of t) {
        const u = e.fs.resolvePath(l, e.cwd);
        try {
          if ((await e.fs.stat(u)).type === "dir") {
            const m = r ? "directory" : `${l}: directory`;
            c.push(m);
            continue;
          }
          const p = await e.fs.readFile(u), f = Ve(p, l);
          let h;
          a ? h = r ? f.mimeType : `${l}: ${f.mimeType}` : i ? h = r ? f.encoding : `${l}: ${f.encoding}` : o ? h = r ? `${f.mimeType}; charset=${f.encoding}` : `${l}: ${f.mimeType}; charset=${f.encoding}` : h = r ? f.description : `${l}: ${f.description}`, c.push(h);
        } catch (d) {
          c.push(`${l}: cannot open (${d instanceof Error ? d.message : d})`);
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
function Ve(n, e) {
  var a;
  let t = "text/plain", s = "us-ascii", r = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", r = "UTF-8 Unicode text"), n.length === 0)
    return t = "application/x-empty", r = "empty", { mimeType: t, encoding: s, description: r };
  const o = (a = e.split(".").pop()) == null ? void 0 : a.toLowerCase();
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
const Ke = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = s[0] ?? ".", a = t.name, i = t.iname, c = t.path, l = t.type, u = t.maxdepth ? parseInt(t.maxdepth) : 1 / 0, d = t.mindepth ? parseInt(t.mindepth) : 0, p = t.exec, f = r.print !== !1, h = e.fs.resolvePath(o, e.cwd), m = [], g = [];
    let x;
    if (a) {
      const $ = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${$}$`);
    }
    let w;
    if (i) {
      const $ = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      w = new RegExp(`^${$}$`, "i");
    }
    let C;
    if (c) {
      const $ = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      C = new RegExp($);
    }
    async function b($, S, P) {
      let E;
      try {
        E = await e.fs.readdir($);
      } catch {
        return;
      }
      for (const F of E) {
        const k = $ + "/" + F.name, N = S ? S + "/" + F.name : F.name, M = o === "." ? "./" + N : o + "/" + N, I = P + 1;
        let T = !0;
        if (!(I > u)) {
          if (I < d && (T = !1), x && !x.test(F.name) && (T = !1), w && !w.test(F.name) && (T = !1), C && !C.test(M) && (T = !1), l === "f" && F.type !== "file" && (T = !1), l === "d" && F.type !== "dir" && (T = !1), T && (f && m.push(M), p)) {
            const R = p.replace(/\{\}/g, M);
            g.push(`Executing: ${R}`);
          }
          F.type === "dir" && I < u && await b(k, N, I);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !w && !C && f && m.push(o === "." ? "." : o), await b(h, "", 0);
    let v = "";
    return m.length > 0 && (v = m.join(`
`) + `
`), g.length > 0 && (v += g.join(`
`) + `
`), { stdout: v, stderr: "", exitCode: 0 };
  }
}, Xe = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(t.w || t.width || "75", 10);
    r.u;
    const a = r.s;
    if (isNaN(o) || o <= 0)
      return {
        stdout: "",
        stderr: `fmt: invalid width: '${t.w || t.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = i.split(`
`), l = [];
      let u = [];
      const d = () => {
        if (u.length !== 0) {
          if (a)
            for (const p of u)
              l.push(...q(p, o));
          else {
            const p = u.join(" ").trim();
            p && l.push(...q(p, o));
          }
          u = [];
        }
      };
      for (const p of c) {
        const f = p.trim();
        f === "" ? (d(), l.push("")) : u.push(f);
      }
      return d(), {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (i) {
      return {
        stdout: "",
        stderr: `fmt: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
};
function q(n, e) {
  const t = [], s = n.split(/\s+/);
  let r = "";
  for (const o of s)
    r.length === 0 ? r = o : r.length + 1 + o.length <= e ? r += " " + o : (t.push(r), r = o);
  return r.length > 0 && t.push(r), t;
}
const Qe = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(t.w || t.width || "80", 10);
    r.b;
    const a = r.s;
    if (isNaN(o) || o <= 0)
      return {
        stdout: "",
        stderr: `fold: invalid width: '${t.w || t.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), c = i.split(`
`), l = [];
      for (const u of c) {
        if (u.length <= o) {
          l.push(u);
          continue;
        }
        let d = u;
        for (; d.length > o; ) {
          let p = o;
          if (a) {
            const f = d.substring(0, o).lastIndexOf(" ");
            f > 0 && (p = f + 1);
          }
          l.push(d.substring(0, p)), d = d.substring(p);
        }
        d.length > 0 && l.push(d);
      }
      return {
        stdout: l.join(`
`) + (i.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (i) {
      return {
        stdout: "",
        stderr: `fold: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
}, et = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(n, e) {
    const { flags: t } = y(n), s = t.h, r = t.b, o = t.m, a = t.g, i = [], c = 8388608, l = 4194304, u = 4194304, d = 524288, p = 1048576, f = 5242880;
    return s ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), i.push("Swap:           2.0G          0B        2.0G")) : r ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:    ${c * 1024} ${l * 1024} ${u * 1024} ${d * 1024} ${p * 1024} ${f * 1024}`), i.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : o ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:           ${Math.floor(c / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(u / 1024)}         ${Math.floor(d / 1024)}        ${Math.floor(p / 1024)}        ${Math.floor(f / 1024)}`), i.push("Swap:          2048           0        2048")) : a ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:               8           4           4           0           1           5"), i.push("Swap:              2           0           2")) : (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:        ${c}     ${l}     ${u}      ${d}     ${p}     ${f}`), i.push("Swap:       2097152           0     2097152")), {
      stdout: i.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, tt = {
  name: "getopts",
  description: "Parse option arguments (shell built-in)",
  async exec(n, e) {
    var f, h;
    if (n.length < 2)
      return {
        stdout: "",
        stderr: `getopts: usage: getopts OPTSTRING NAME [args...]
`,
        exitCode: 1
      };
    const t = n[0], s = n[1], r = n.slice(2);
    let o = parseInt(((f = e.env) == null ? void 0 : f.OPTIND) || "1");
    const a = t.startsWith(":"), i = a ? t.slice(1) : t, c = /* @__PURE__ */ new Map();
    for (let m = 0; m < i.length; m++) {
      const g = i[m];
      if (g === ":") continue;
      const x = i[m + 1] === ":";
      c.set(g, x);
    }
    const l = r.length > 0 ? r : (h = e.env) != null && h.$1 ? [e.env.$1, e.env.$2, e.env.$3].filter(Boolean) : [];
    if (l.length === 0 || o > l.length)
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const u = l[o - 1];
    if (!u || !u.startsWith("-") || u === "-" || u === "--")
      return e.env && (e.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const d = u[1];
    if (!c.has(d))
      return e.env && (e.env[s] = "?", e.env.OPTARG = d, e.env.OPTIND = String(o + 1)), a ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `getopts: illegal option -- ${d}
`,
        exitCode: 0
      };
    if (c.get(d)) {
      let m;
      if (u.length > 2)
        m = u.slice(2);
      else if (o < l.length)
        m = l[o], e.env && (e.env.OPTIND = String(o + 2));
      else
        return e.env && (e.env[s] = "?", e.env.OPTARG = d, e.env.OPTIND = String(o + 1)), a ? {
          stdout: "",
          stderr: "",
          exitCode: 0
        } : {
          stdout: "",
          stderr: `getopts: option requires an argument -- ${d}
`,
          exitCode: 0
        };
      e.env && (e.env[s] = d, e.env.OPTARG = m, e.env.OPTIND || (e.env.OPTIND = String(o + 1)));
    } else
      e.env && (e.env[s] = d, e.env.OPTIND = String(o + 1), delete e.env.OPTARG);
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, st = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["e"]), o = !!t.i, a = !!t.v, i = !!t.c, c = !!t.l, l = !!t.n, u = !!(t.r || t.R), d = s.e ?? r.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const p = o ? "i" : "";
    let f;
    try {
      f = new RegExp(d, p);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const h = r.length > 0 ? r : ["-"], m = h.length > 1 || u, g = [];
    let x = !1;
    async function w(v, $) {
      let S;
      try {
        if (v === "-")
          S = e.stdin;
        else {
          const F = e.fs.resolvePath(v, e.cwd);
          S = await e.fs.readFile(F);
        }
      } catch {
        g.push(`grep: ${v}: No such file or directory`);
        return;
      }
      const P = S.split(`
`);
      P.length > 0 && P[P.length - 1] === "" && P.pop();
      let E = 0;
      for (let F = 0; F < P.length; F++)
        if (f.test(P[F]) !== a && (x = !0, E++, !i && !c)) {
          const N = m ? `${$}:` : "", M = l ? `${F + 1}:` : "";
          g.push(`${N}${M}${P[F]}`);
        }
      i && g.push(m ? `${$}:${E}` : String(E)), c && E > 0 && g.push($);
    }
    async function C(v) {
      const $ = e.fs.resolvePath(v, e.cwd);
      let S;
      try {
        S = await e.fs.readdir($);
      } catch {
        return;
      }
      for (const P of S) {
        const E = $ + "/" + P.name;
        P.type === "dir" ? await C(E) : await w(E, E);
      }
    }
    for (const v of h)
      if (v === "-")
        await w("-", "(standard input)");
      else if (u) {
        const $ = e.fs.resolvePath(v, e.cwd);
        let S;
        try {
          S = await e.fs.stat($);
        } catch {
          continue;
        }
        S.type === "dir" ? await C($) : await w(v, v);
      } else
        await w(v, v);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, nt = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, e) {
    const { values: t, positional: s } = y(n, ["n"]), r = parseInt(t.n ?? "10", 10);
    try {
      const { content: o } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: o.split(`
`).slice(0, r).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `head: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, rt = {
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
}, ot = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["n", "s", "C"]), o = r.C, a = t.n ? parseInt(t.n) : void 0, i = t.s ? parseInt(t.s) : 0;
    try {
      const { content: c } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let l = c.substring(i, a ? i + a : void 0);
      const u = [];
      if (o) {
        for (let p = 0; p < l.length; p += 16) {
          const f = l.substring(p, p + 16), h = (i + p).toString(16).padStart(8, "0"), m = z(f.substring(0, 8)), g = z(f.substring(8, 16)), x = it(f);
          u.push(`${h}  ${m}  ${g}  |${x}|`);
        }
        const d = (i + l.length).toString(16).padStart(8, "0");
        u.push(d);
      } else {
        for (let p = 0; p < l.length; p += 16) {
          const f = l.substring(p, p + 16), h = (i + p).toString(16).padStart(7, "0"), m = [];
          for (let g = 0; g < f.length; g += 2) {
            const x = f.charCodeAt(g), w = g + 1 < f.length ? f.charCodeAt(g + 1) : 0, C = (x << 8 | w).toString(16).padStart(4, "0");
            m.push(C);
          }
          u.push(`${h} ${m.join(" ")}`);
        }
        const d = (i + l.length).toString(16).padStart(7, "0");
        u.push(d);
      }
      return {
        stdout: u.join(`
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
function z(n) {
  const e = [];
  for (let t = 0; t < 8; t++)
    t < n.length ? e.push(n.charCodeAt(t).toString(16).padStart(2, "0")) : e.push("  ");
  return e.join(" ");
}
function it(n) {
  let e = "";
  for (let t = 0; t < 16; t++)
    if (t < n.length) {
      const s = n.charCodeAt(t);
      e += s >= 32 && s < 127 ? n[t] : ".";
    } else
      e += " ";
  return e;
}
const at = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, e) {
    return { stdout: (e.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, ct = {
  name: "id",
  description: "Print user identity",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n), r = t[0] || e.env.USER || "user", o = s.u || s.user, a = s.g || s.group, i = s.G || s.groups, c = s.n || s.name;
    s.r || s.real;
    const l = 1e3, u = 1e3, d = [1e3], p = r, f = "users", h = [];
    if (o)
      c ? h.push(p) : h.push(String(l));
    else if (a)
      c ? h.push(f) : h.push(String(u));
    else if (i)
      c ? h.push(f) : h.push(d.join(" "));
    else {
      const m = d.map((g) => `${g}(${f})`).join(",");
      h.push(`uid=${l}(${p}) gid=${u}(${f}) groups=${m}`);
    }
    return {
      stdout: h.join(`
`) + (h.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, lt = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    t.m || t.mode;
    const o = t.t || t["target-directory"], a = r.d || r.directory, i = r.v || r.verbose;
    if (s.length === 0)
      return { stdout: "", stderr: `install: missing operand
`, exitCode: 1 };
    const c = [];
    try {
      if (a)
        for (const l of s) {
          const u = e.fs.resolvePath(l, e.cwd);
          await e.fs.mkdir(u, { recursive: !0 }), i && c.push(`install: creating directory '${l}'`);
        }
      else if (o) {
        const l = e.fs.resolvePath(o, e.cwd);
        for (const u of s) {
          const d = e.fs.resolvePath(u, e.cwd), p = u.split("/").pop() || u, f = l + "/" + p, h = await e.fs.readFile(d);
          await e.fs.writeFile(f, h), i && c.push(`'${u}' -> '${o}/${p}'`);
        }
      } else {
        if (s.length < 2)
          return { stdout: "", stderr: `install: missing destination
`, exitCode: 1 };
        const l = s[s.length - 1], u = s.slice(0, -1), d = e.fs.resolvePath(l, e.cwd);
        let p = !1;
        try {
          p = (await e.fs.stat(d)).type === "dir";
        } catch {
          p = u.length > 1;
        }
        if (p && u.length > 1)
          for (const f of u) {
            const h = e.fs.resolvePath(f, e.cwd), m = f.split("/").pop() || f, g = d + "/" + m, x = await e.fs.readFile(h);
            await e.fs.writeFile(g, x), i && c.push(`'${f}' -> '${l}/${m}'`);
          }
        else {
          const f = e.fs.resolvePath(u[0], e.cwd), h = await e.fs.readFile(f);
          await e.fs.writeFile(d, h), i && c.push(`'${u[0]}' -> '${l}'`);
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
}, dt = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const o = t[1] ? parseInt(t[1]) - 1 : 0, a = t[2] ? parseInt(t[2]) - 1 : 0, i = t.t || /\s+/, c = t.o, l = r.i;
    try {
      const u = e.fs.resolvePath(s[0], e.cwd), d = e.fs.resolvePath(s[1], e.cwd), p = await e.fs.readFile(u), f = await e.fs.readFile(d), h = p.split(`
`).filter((v) => v.trim() !== ""), m = f.split(`
`).filter((v) => v.trim() !== ""), g = (v) => v.map(($) => $.split(i)), x = g(h), w = g(m), C = /* @__PURE__ */ new Map();
      for (const v of w) {
        const $ = (v[a] || "").trim(), S = l ? $.toLowerCase() : $;
        C.has(S) || C.set(S, []), C.get(S).push(v);
      }
      const b = [];
      for (const v of x) {
        const $ = (v[o] || "").trim(), S = l ? $.toLowerCase() : $, P = C.get(S) || [];
        for (const E of P) {
          let F;
          if (c)
            F = c.split(",").map((N) => {
              const [M, I] = N.split(".").map((R) => parseInt(R));
              return (M === 1 ? v : E)[I - 1] || "";
            }).join(" ");
          else {
            const k = v[o] || "", N = v.filter((I, T) => T !== o), M = E.filter((I, T) => T !== a);
            F = [k, ...N, ...M].join(" ");
          }
          b.push(F);
        }
      }
      return {
        stdout: b.join(`
`) + (b.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `join: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
}, ut = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    try {
      const { content: r } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), o = r.split(`
`), a = t.N || t.n;
      let i = "";
      return a ? i = o.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : i = r, i && !i.endsWith(`
`) && (i += `
`), { stdout: i, stderr: "", exitCode: 0 };
    } catch (r) {
      return {
        stdout: "",
        stderr: `less: ${r instanceof Error ? r.message : r}
`,
        exitCode: 1
      };
    }
  }
}, ft = {
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
        const o = s[1], a = s[2], i = U(a, e.env || {});
        return e.env && (e.env[o] = String(i)), {
          stdout: "",
          stderr: "",
          exitCode: i === 0 ? 1 : 0
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: U(t, e.env || {}) === 0 ? 1 : 0
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
function U(n, e) {
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
const Ns = {
  evaluate: U
}, pt = {
  name: "ln",
  description: "Make links between files",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.s, o = t.f, a = t.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const i = e.fs.resolvePath(s[0], e.cwd), c = e.fs.resolvePath(s[1], e.cwd), l = [];
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
        await e.fs.symlink(i, c), a && l.push(`'${c}' -> '${i}'`);
      else {
        const u = await e.fs.readFile(i);
        await e.fs.writeFile(c, u), a && l.push(`'${c}' => '${i}'`);
      }
      return {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return { stdout: "", stderr: `ln: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, ht = {
  name: "ls",
  description: "List directory contents",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = s.length > 0 ? s : ["."], o = t.a, a = t.l, i = t.h, c = [];
    for (const l of r) {
      const u = e.fs.resolvePath(l, e.cwd), d = await e.fs.stat(u);
      if (d.type === "file") {
        c.push(a ? H(u.split("/").pop(), d, i) : u.split("/").pop());
        continue;
      }
      r.length > 1 && c.push(`${l}:`);
      const p = await e.fs.readdir(u), f = o ? p : p.filter((h) => !h.name.startsWith("."));
      if (f.sort((h, m) => h.name.localeCompare(m.name)), a) {
        c.push(`total ${f.length}`);
        for (const h of f)
          c.push(H(h.name, h, i));
      } else
        c.push(f.map((h) => h.type === "dir" ? h.name + "/" : h.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function H(n, e, t) {
  const s = e.type === "dir" ? "d" : "-", r = e.mode ?? (e.type === "dir" ? 493 : 420), o = mt(r), a = t ? xt(e.size) : String(e.size).padStart(8), i = new Date(e.mtime), c = gt(i);
  return `${s}${o}  1 user user ${a} ${c} ${n}`;
}
function mt(n) {
  let t = "";
  for (let s = 2; s >= 0; s--) {
    const r = n >> s * 3 & 7;
    for (let o = 2; o >= 0; o--)
      t += r & 1 << o ? "rwx"[2 - o] : "-";
  }
  return t;
}
function gt(n) {
  const t = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), r = String(n.getHours()).padStart(2, "0"), o = String(n.getMinutes()).padStart(2, "0");
  return `${t} ${s} ${r}:${o}`;
}
function xt(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const yt = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["f", "file", "C", "j"]), o = t.f || t.file || "Makefile", a = t.C;
    t.j;
    const i = r.n || r["dry-run"], c = r.p || r.print, l = s.length > 0 ? s : ["all"];
    try {
      const u = a ? e.fs.resolvePath(a, e.cwd) : e.cwd, d = e.fs.resolvePath(o, u);
      let p;
      try {
        p = await e.fs.readFile(d);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${o}: No such file or directory
`,
          exitCode: 2
        };
      }
      const f = wt(p), h = [];
      for (const m of l) {
        const g = f.get(m);
        if (!g)
          return {
            stdout: "",
            stderr: `make: *** No rule to make target '${m}'. Stop.
`,
            exitCode: 2
          };
        for (const x of g.prerequisites) {
          const w = f.get(x);
          if (w)
            for (const C of w.commands)
              c || i ? h.push(C) : h.push(`# ${C}`);
        }
        for (const x of g.commands)
          c || i ? h.push(x) : h.push(`# ${x}`);
      }
      return {
        stdout: h.join(`
`) + (h.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `make: ${u instanceof Error ? u.message : u}
`,
        exitCode: 2
      };
    }
  }
};
function wt(n) {
  const e = /* @__PURE__ */ new Map(), t = n.split(`
`);
  let s = null;
  for (let r = 0; r < t.length; r++) {
    const o = t[r];
    if (!(o.trim().startsWith("#") || o.trim() === ""))
      if (o.includes(":") && !o.startsWith("	")) {
        const a = o.indexOf(":"), i = o.substring(0, a).trim(), c = o.substring(a + 1).trim(), l = c ? c.split(/\s+/) : [];
        s = { target: i, prerequisites: l, commands: [] }, e.set(i, s);
      } else o.startsWith("	") && s && s.commands.push(o.substring(1));
  }
  return e;
}
const vt = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.c || t.check, o = t.b || t.binary;
    if (r)
      return {
        stdout: "",
        stderr: `md5sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const a = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const c of a) {
        let l;
        if (c === "-")
          l = e.stdin;
        else {
          const p = e.fs.resolvePath(c, e.cwd);
          l = await e.fs.readFile(p);
        }
        const u = await Ct(l), d = o ? "*" : " ";
        i.push(`${u}${d}${c === "-" ? "-" : c}`);
      }
      return {
        stdout: i.join(`
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
async function Ct(n) {
  let e = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    e = (e << 5) - e + r, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(32, "0");
}
const $t = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const o of s) {
        const a = e.fs.resolvePath(o, e.cwd);
        await e.fs.mkdir(a, { recursive: r });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `mkdir: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, bt = {
  name: "mv",
  description: "Move or rename files",
  async exec(n, e) {
    const { positional: t } = y(n);
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
      for (const a of r) {
        const i = e.fs.resolvePath(a, e.cwd), c = a.split("/").pop(), l = o ? s + "/" + c : s;
        await e.fs.rename(i, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, St = {
  name: "nl",
  description: "Number lines of files",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["b", "s", "w", "n", "v"]), o = t.b || "t", a = t.s || "	", i = parseInt(t.w || "6", 10), c = t.n || "rn", l = parseInt(t.v || "1", 10);
    r.p;
    const u = r.ba;
    try {
      const { content: d } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), p = d.split(`
`), f = [];
      let h = l;
      for (const m of p) {
        let g = !1;
        const x = u ? "a" : o;
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
              const w = x.substring(1);
              try {
                g = new RegExp(w).test(m);
              } catch {
                g = !1;
              }
            }
        }
        if (g) {
          const w = Pt(h, i, c);
          f.push(w + a + m), h++;
        } else
          f.push(" ".repeat(i) + a + m);
      }
      return {
        stdout: f.join(`
`) + (d.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `nl: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
};
function Pt(n, e, t) {
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
const Et = {
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
      const o = e.fs.resolvePath("nohup.out", e.cwd), i = `[${(/* @__PURE__ */ new Date()).toISOString()}] Command: ${t} ${s.join(" ")}
`;
      let c = "";
      try {
        c = await e.fs.readFile(o);
      } catch {
      }
      await e.fs.writeFile(o, c + i);
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
}, It = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["t", "N", "j", "w", "A"]), o = t.t || "o2", a = t.N ? parseInt(t.N) : void 0, i = t.j ? parseInt(t.j) : 0, c = t.w ? parseInt(t.w) : 16, l = t.A || "o", u = r.b || r.c || r.d || r.o || r.s || r.x;
    try {
      const { content: d } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let p = d.substring(i, a ? i + a : void 0);
      const f = [];
      let h = "o", m = 2;
      u ? r.b ? (h = "o", m = 1) : r.c ? (h = "c", m = 1) : r.d || r.s ? (h = "d", m = 2) : r.o ? (h = "o", m = 2) : r.x && (h = "x", m = 2) : o && (h = o[0] || "o", m = parseInt(o.substring(1)) || 2);
      let g = i;
      for (let x = 0; x < p.length; x += c) {
        const w = p.substring(x, x + c), C = G(g, l), b = Ft(w, h, m);
        f.push(`${C} ${b}`), g += w.length;
      }
      return l !== "n" && f.push(G(g, l)), {
        stdout: f.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `od: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
};
function G(n, e) {
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
function Ft(n, e, t) {
  const s = [];
  for (let r = 0; r < n.length; r += t) {
    const o = n.substring(r, r + t);
    let a = 0;
    for (let i = 0; i < o.length; i++)
      a = a << 8 | o.charCodeAt(i);
    switch (e) {
      case "o":
        s.push(a.toString(8).padStart(t * 3, "0"));
        break;
      case "x":
        s.push(a.toString(16).padStart(t * 2, "0"));
        break;
      case "d":
        s.push(a.toString(10).padStart(t * 3, " "));
        break;
      case "c":
        s.push(Tt(o.charCodeAt(0)));
        break;
      case "a":
        s.push(jt(o.charCodeAt(0)));
        break;
      default:
        s.push(a.toString(8).padStart(t * 3, "0"));
    }
  }
  return s.join(" ");
}
function Tt(n) {
  return n >= 32 && n < 127 ? `  ${String.fromCharCode(n)}` : n === 0 ? " \\0" : n === 7 ? " \\a" : n === 8 ? " \\b" : n === 9 ? " \\t" : n === 10 ? " \\n" : n === 11 ? " \\v" : n === 12 ? " \\f" : n === 13 ? " \\r" : n.toString(8).padStart(3, "0");
}
function jt(n) {
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
const Nt = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["d", "delimiters"]), o = t.d || t.delimiters || "	", a = r.s;
    s.length === 0 && s.push("-");
    try {
      const i = [];
      for (const l of s) {
        let u;
        if (l === "-")
          u = e.stdin;
        else {
          const d = e.fs.resolvePath(l, e.cwd);
          u = await e.fs.readFile(d);
        }
        i.push(u.split(`
`).filter((d, p, f) => p < f.length - 1 || d !== ""));
      }
      const c = [];
      if (a)
        for (const l of i) {
          const u = o.split(""), d = [];
          for (let p = 0; p < l.length; p++)
            d.push(l[p]), p < l.length - 1 && d.push(u[p % u.length]);
          c.push(d.join(""));
        }
      else {
        const l = Math.max(...i.map((d) => d.length)), u = o.split("");
        for (let d = 0; d < l; d++) {
          const p = [];
          for (let f = 0; f < i.length; f++) {
            const h = i[f][d] || "";
            p.push(h), f < i.length - 1 && p.push(u[f % u.length]);
          }
          c.push(p.join(""));
        }
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (i) {
      return {
        stdout: "",
        stderr: `paste: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
}, Mt = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["p", "i", "input", "o", "output"]), o = t.p ? parseInt(t.p) : 0, a = t.i || t.input, i = t.o || t.output, c = r.R || r.reverse, l = r["dry-run"];
    try {
      let u;
      if (a) {
        const f = e.fs.resolvePath(a, e.cwd);
        u = await e.fs.readFile(f);
      } else if (s.length > 0) {
        const f = e.fs.resolvePath(s[0], e.cwd);
        u = await e.fs.readFile(f);
      } else
        u = e.stdin;
      const d = At(u), p = [];
      for (const f of d) {
        const h = B(f.newFile, o), m = B(f.oldFile, o);
        if (p.push(`patching file ${h}`), !l) {
          let g;
          try {
            const w = e.fs.resolvePath(h, e.cwd);
            g = await e.fs.readFile(w);
          } catch {
            g = "";
          }
          const x = Rt(g, f.hunks, c);
          if (i) {
            const w = e.fs.resolvePath(i, e.cwd);
            await e.fs.writeFile(w, x);
          } else {
            const w = e.fs.resolvePath(h, e.cwd);
            await e.fs.writeFile(w, x);
          }
        }
      }
      return {
        stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (u) {
      return {
        stdout: "",
        stderr: `patch: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
};
function At(n) {
  const e = [], t = n.split(`
`);
  let s = null, r = null;
  for (const o of t)
    if (o.startsWith("--- "))
      s = { oldFile: o.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (o.startsWith("+++ ") && s)
      s.newFile = o.substring(4).split("	")[0], e.push(s);
    else if (o.startsWith("@@ ") && s) {
      const a = o.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      a && (r = {
        oldStart: parseInt(a[1]),
        oldLines: parseInt(a[2]),
        newStart: parseInt(a[3]),
        newLines: parseInt(a[4]),
        lines: []
      }, s.hunks.push(r));
    } else r && (o.startsWith(" ") || o.startsWith("+") || o.startsWith("-")) && r.lines.push(o);
  return e;
}
function B(n, e) {
  return n.split("/").slice(e).join("/");
}
function Rt(n, e, t) {
  const s = n.split(`
`);
  for (const r of e) {
    const o = r.oldStart - 1, a = r.oldLines, i = [];
    for (const c of r.lines) {
      const l = c[0], u = c.substring(1);
      if (t) {
        if (l === "+")
          continue;
        i.push(u);
      } else
        (l === "+" || l === " ") && i.push(u);
    }
    s.splice(o, a, ...i);
  }
  return s.join(`
`);
}
const kt = {
  name: "pkg-config",
  description: "Return metainformation about installed libraries",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n, [
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
      const a = {
        zlib: "-I/usr/include",
        openssl: "-I/usr/include/openssl",
        libcurl: "-I/usr/include/curl",
        sqlite3: "-I/usr/include",
        "glib-2.0": "-I/usr/include/glib-2.0 -I/usr/lib/glib-2.0/include"
      }[r] || "";
      return {
        stdout: a ? a + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    if (t.libs) {
      const a = {
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
        stdout: a ? a + `
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
}, Ot = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n), r = s[0] || s.null;
    if (t.length === 0) {
      const o = [];
      for (const [i, c] of Object.entries(e.env))
        o.push(`${i}=${c}`);
      const a = r ? "\0" : `
`;
      return {
        stdout: o.join(a) + (o.length > 0 ? a : ""),
        stderr: "",
        exitCode: 0
      };
    } else {
      const o = [];
      for (const i of t)
        if (i in e.env)
          o.push(e.env[i]);
        else
          return {
            stdout: "",
            stderr: "",
            exitCode: 1
          };
      const a = r ? "\0" : `
`;
      return {
        stdout: o.join(a) + (o.length > 0 ? a : ""),
        stderr: "",
        exitCode: 0
      };
    }
  }
}, Dt = {
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
          let a = "";
          for (; o < e.length && !/[sdf]/.test(e[o]); )
            a += e[o], o++;
          const i = e[o] ?? "s";
          o++;
          const c = t[s++] ?? "";
          switch (i) {
            case "s":
              r += c;
              break;
            case "d":
              r += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              r += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        r += e[o], o++;
    return { stdout: r, stderr: "", exitCode: 0 };
  }
}, Lt = {
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
}, Wt = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, e) {
    return { stdout: e.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, Ut = {
  name: "read",
  description: "Read a line from stdin into variables",
  async exec(n, e) {
    var l;
    const { positional: t, flags: s, values: r } = y(n, ["r", "p", "n", "t", "d", "a", "s"]);
    let o = e.stdin || "";
    r.p;
    const a = r.d || `
`, i = r.n ? parseInt(r.n) : void 0;
    let c;
    if (i !== void 0)
      c = o.slice(0, i);
    else {
      const u = o.indexOf(a);
      u >= 0 ? c = o.slice(0, u) : c = o;
    }
    if (s.r || (c = c.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\")), t.length === 0)
      e.env && (e.env.REPLY = c);
    else if (t.length === 1)
      e.env && (e.env[t[0]] = c);
    else {
      const u = ((l = e.env) == null ? void 0 : l.IFS) || ` 	
`, d = new RegExp(`[${u.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&")}]+`), p = c.split(d).filter((f) => f);
      for (let f = 0; f < t.length; f++) {
        const h = t[f];
        f < t.length - 1 ? e.env && (e.env[h] = p[f] || "") : e.env && (e.env[h] = p.slice(f).join(" "));
      }
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, qt = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const o = e.fs.resolvePath(s[0], e.cwd);
    return r ? { stdout: o + `
`, stderr: "", exitCode: 0 } : { stdout: o + `
`, stderr: "", exitCode: 0 };
  }
}, zt = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const r = t.q || t.quiet, o = !t.s;
    t.s;
    const a = [], i = [];
    for (const u of s)
      try {
        let d = e.fs.resolvePath(u, e.cwd);
        if (o) {
          const p = d.split("/").filter((h) => h !== "" && h !== "."), f = [];
          for (const h of p)
            h === ".." ? f.length > 0 && f.pop() : f.push(h);
          d = "/" + f.join("/");
        }
        await e.fs.exists(d) ? a.push(d) : r || i.push(`realpath: ${u}: No such file or directory`);
      } catch (d) {
        r || i.push(`realpath: ${u}: ${d instanceof Error ? d.message : d}`);
      }
    const c = i.length > 0 ? i.join(`
`) + `
` : "", l = i.length > 0 ? 1 : 0;
    return {
      stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
      stderr: c,
      exitCode: l
    };
  }
}, Ht = {
  name: "return",
  description: "Return from a shell function",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? parseInt(t[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, Gt = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.r || t.R, o = t.f;
    if (s.length === 0 && !o)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(i) {
      const c = await e.fs.readdir(i);
      for (const l of c) {
        const u = i + "/" + l.name;
        l.type === "dir" ? await a(u) : await e.fs.unlink(u);
      }
      await e.fs.rmdir(i);
    }
    try {
      for (const i of s) {
        const c = e.fs.resolvePath(i, e.cwd);
        let l;
        try {
          l = await e.fs.stat(c);
        } catch {
          if (o) continue;
          return { stdout: "", stderr: `rm: cannot remove '${i}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `rm: cannot remove '${i}': Is a directory
`, exitCode: 1 };
          await a(c);
        } else
          await e.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, Bt = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.i, o = s.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
`, exitCode: 1 };
    const [, , i, c, l] = a, u = l.includes("g"), d = l.includes("i");
    let p;
    try {
      const f = (u ? "g" : "") + (d ? "i" : "");
      p = new RegExp(i, f);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${i}
`, exitCode: 2 };
    }
    try {
      const { content: f, files: h } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), m = f.split(`
`).map((g) => g.replace(p, c)).join(`
`);
      if (r && h.length > 0) {
        for (const g of h) {
          const x = e.fs.resolvePath(g, e.cwd), C = (await e.fs.readFile(x)).split(`
`).map((b) => b.replace(p, c)).join(`
`);
          await e.fs.writeFile(x, C);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (f) {
      return { stdout: "", stderr: `sed: ${f instanceof Error ? f.message : f}
`, exitCode: 1 };
    }
  }
}, _t = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["separator", "s", "format", "f"]);
    if (r.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let o = 1, a = 1, i;
    if (r.length === 1 ? i = parseFloat(r[0]) : r.length === 2 ? (o = parseFloat(r[0]), i = parseFloat(r[1])) : r.length >= 3 ? (o = parseFloat(r[0]), a = parseFloat(r[1]), i = parseFloat(r[2])) : i = 1, isNaN(o) || isNaN(a) || isNaN(i))
      return {
        stdout: "",
        stderr: `seq: invalid number
`,
        exitCode: 1
      };
    if (a === 0)
      return {
        stdout: "",
        stderr: `seq: increment must not be 0
`,
        exitCode: 1
      };
    const c = s.s || s.separator || `
`, l = s.f || s.format, u = t.w, d = [];
    if (a > 0)
      for (let h = o; h <= i; h += a)
        d.push(String(h));
    else
      for (let h = o; h >= i; h += a)
        d.push(String(h));
    if (u) {
      const h = Math.max(...d.map((m) => m.length));
      for (let m = 0; m < d.length; m++)
        d[m] = d[m].padStart(h, "0");
    }
    if (l && typeof l == "string")
      for (let h = 0; h < d.length; h++) {
        const m = parseFloat(d[h]);
        l.includes("%g") || l.includes("%d") || l.includes("%i") ? d[h] = l.replace(/%[gdi]/, String(m)) : l.includes("%f") ? d[h] = l.replace(/%f/, m.toFixed(6)) : l.includes("%e") && (d[h] = l.replace(/%e/, m.toExponential()));
      }
    return {
      stdout: d.join(c) + ((typeof c == "string" ? c : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, Jt = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["e", "u", "x", "v", "n", "o"]);
    if (n.length === 0) {
      const o = Object.entries(e.env || {}).map(([a, i]) => `${a}=${i}`).join(`
`);
      return {
        stdout: o ? o + `
` : "",
        stderr: "",
        exitCode: 0
      };
    }
    if (t.o || s.o) {
      const o = s.o || r[0], a = [
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
      return o ? a.includes(o) ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `set: ${o}: invalid option name
`,
        exitCode: 1
      } : {
        stdout: a.map((i) => `${i}		off`).join(`
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
}, Yt = {
  name: "sha256sum",
  description: "Compute SHA256 message digest",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.c || t.check, o = t.b || t.binary;
    if (r)
      return {
        stdout: "",
        stderr: `sha256sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const a = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const c of a) {
        let l;
        if (c === "-")
          l = e.stdin;
        else {
          const p = e.fs.resolvePath(c, e.cwd);
          l = await e.fs.readFile(p);
        }
        const u = await Zt(l), d = o ? "*" : " ";
        i.push(`${u}${d}${c === "-" ? "-" : c}`);
      }
      return {
        stdout: i.join(`
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
async function Zt(n) {
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
const Vt = {
  name: "shift",
  description: "Shift positional parameters",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? parseInt(t[0]) : 1;
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
}, Kt = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(n, e) {
    const { positional: t } = y(n);
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
    const a = parseFloat(o[1]);
    switch (o[2] || "s") {
      case "s":
        r = a;
        break;
      case "m":
        r = a * 60;
        break;
      case "h":
        r = a * 3600;
        break;
      case "d":
        r = a * 86400;
        break;
    }
    return await new Promise((c) => globalThis.setTimeout(c, r * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, Xt = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n);
    try {
      const { content: r } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      let o = r.split(`
`).filter(Boolean);
      return t.n ? o.sort((a, i) => parseFloat(a) - parseFloat(i)) : o.sort(), t.u && (o = [...new Set(o)]), t.r && o.reverse(), { stdout: o.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `sort: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, V = {
  name: "source",
  description: "Execute commands from a file in the current shell",
  async exec(n, e) {
    const { positional: t } = y(n);
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
}, Qt = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(n, e) {
    return V.exec(n, e);
  }
}, es = {
  name: "stat",
  description: "Display file status",
  async exec(n, e) {
    const { positional: t, flags: s, values: r } = y(n, ["c", "format"]);
    if (t.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const o = r.c || r.format, a = s.t;
    s.f;
    const i = [];
    try {
      for (const c of t) {
        const l = e.fs.resolvePath(c, e.cwd);
        try {
          const u = await e.fs.stat(l);
          if (o) {
            const d = ts(c, u, o);
            i.push(d);
          } else if (a)
            i.push(`${c} ${u.size} 0 ${u.mode} 0 0 0 0 0 0 ${u.mtime}`);
          else {
            const d = u.type === "dir" ? "directory" : "regular file", p = K(u.mode), f = new Date(u.mtime).toISOString();
            i.push(`  File: ${c}`), i.push(`  Size: ${u.size}	Blocks: 0	IO Block: 4096	${d}`), i.push("Device: 0	Inode: 0	Links: 1"), i.push(`Access: (${p})	Uid: (0/root)	Gid: (0/root)`), i.push(`Access: ${f}`), i.push(`Modify: ${f}`), i.push(`Change: ${f}`);
          }
        } catch (u) {
          i.push(`stat: cannot stat '${c}': ${u instanceof Error ? u.message : u}`);
        }
      }
      return {
        stdout: i.join(`
`) + (i.length > 0 ? `
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
function K(n) {
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
function ts(n, e, t) {
  return t.replace(/%n/g, n).replace(/%N/g, `'${n}'`).replace(/%s/g, String(e.size)).replace(/%b/g, "0").replace(/%f/g, e.mode.toString(16)).replace(/%a/g, e.mode.toString(8)).replace(/%A/g, K(e.mode).split("/")[1]).replace(/%F/g, e.type === "dir" ? "directory" : "regular file").replace(/%u/g, "0").replace(/%g/g, "0").replace(/%U/g, "root").replace(/%G/g, "root").replace(/%i/g, "0").replace(/%h/g, "1").replace(/%W/g, String(Math.floor(e.mtime / 1e3))).replace(/%X/g, String(Math.floor(e.mtime / 1e3))).replace(/%Y/g, String(Math.floor(e.mtime / 1e3))).replace(/%y/g, new Date(e.mtime).toISOString()).replace(/%%/g, "%");
}
const ss = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["n", "bytes"]), o = parseInt(t.n || t.bytes || "4", 10), a = r.f;
    r.a;
    try {
      const i = s.length > 0 ? s : ["-"], c = [];
      for (const l of i) {
        let u, d = l;
        if (l === "-")
          u = e.stdin, d = "(standard input)";
        else {
          const f = e.fs.resolvePath(l, e.cwd);
          u = await e.fs.readFile(f);
        }
        const p = ns(u, o);
        for (const f of p)
          a ? c.push(`${d}: ${f}`) : c.push(f);
      }
      return {
        stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (i) {
      return {
        stdout: "",
        stderr: `strings: ${i instanceof Error ? i.message : i}
`,
        exitCode: 1
      };
    }
  }
};
function ns(n, e) {
  const t = [], s = /[ -~]/;
  let r = "";
  for (let o = 0; o < n.length; o++) {
    const a = n[o];
    s.test(a) ? r += a : (r.length >= e && t.push(r), r = "");
  }
  return r.length >= e && t.push(r), t;
}
const rs = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, e) {
    const { values: t, positional: s } = y(n, ["n"]), r = parseInt(t.n ?? "10", 10);
    try {
      const { content: o } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      );
      return { stdout: o.split(`
`).slice(-r).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `tail: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, os = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["f", "C"]), o = t.c || t.create, a = t.x || t.extract, i = t.t || t.list, c = t.v || t.verbose, l = s.f, u = s.C;
    let d = e.cwd;
    u && (d = e.fs.resolvePath(u, e.cwd));
    const p = [o, a, i].filter(Boolean).length;
    if (p === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (p > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (o) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const f = r;
        if (f.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const h = [];
        async function m(C, b) {
          const v = e.fs.resolvePath(C, d);
          if ((await e.fs.stat(v)).type === "dir") {
            h.push({ path: b + "/", content: "", isDir: !0 });
            const S = await e.fs.readdir(v);
            for (const P of S)
              await m(v + "/" + P.name, b + "/" + P.name);
          } else {
            const S = await e.fs.readFile(v);
            h.push({ path: b, content: S, isDir: !1 });
          }
        }
        for (const C of f)
          await m(C, C);
        const g = ["FLUFFY-TAR-V1"];
        for (const C of h)
          c && (e.stderr || console.error(C.path)), g.push(`FILE:${C.path}`), g.push(`SIZE:${C.content.length}`), g.push(`TYPE:${C.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(C.content), g.push("DATA-END");
        const x = g.join(`
`), w = e.fs.resolvePath(l, e.cwd);
        return await e.fs.writeFile(w, x), {
          stdout: c ? h.map((C) => C.path).join(`
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
        const f = e.fs.resolvePath(l, e.cwd), m = (await e.fs.readFile(f)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let g = 1;
        const x = [];
        for (; g < m.length && m[g].startsWith("FILE:"); ) {
          const w = m[g].slice(5), C = parseInt(m[g + 1].slice(5), 10), b = m[g + 2].slice(5);
          g += 4;
          const v = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            v.push(m[g]), g++;
          const $ = v.join(`
`);
          g++;
          const S = e.fs.resolvePath(w, d);
          if (b === "dir")
            await e.fs.mkdir(S, { recursive: !0 });
          else {
            const P = S.lastIndexOf("/");
            if (P > 0) {
              const E = S.slice(0, P);
              try {
                await e.fs.mkdir(E, { recursive: !0 });
              } catch {
              }
            }
            await e.fs.writeFile(S, $);
          }
          x.push(w), c && (e.stderr || console.error(w));
        }
        return {
          stdout: c ? x.join(`
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
        const f = e.fs.resolvePath(l, e.cwd), m = (await e.fs.readFile(f)).split(`
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
    } catch (f) {
      return {
        stdout: "",
        stderr: `tar: ${f instanceof Error ? f.message : f}
`,
        exitCode: 1
      };
    }
  }
}, is = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.a, o = e.stdin;
    try {
      for (const a of s) {
        const i = e.fs.resolvePath(a, e.cwd);
        if (r) {
          let c = "";
          try {
            c = await e.fs.readFile(i);
          } catch {
          }
          await e.fs.writeFile(i, c + o);
        } else
          await e.fs.writeFile(i, o);
      }
      return { stdout: o, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: o, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, as = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(n, e) {
    const t = n[n.length - 1] === "]" ? n.slice(0, -1) : [...n];
    try {
      return { stdout: "", stderr: "", exitCode: await O(t, e) ? 0 : 1 };
    } catch (s) {
      return { stdout: "", stderr: `test: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
};
async function O(n, e) {
  var r, o;
  if (n.length === 0) return !1;
  if (n.length === 1) return n[0] !== "";
  if (n.length === 2) {
    const [a, i] = n;
    switch (a) {
      // String tests
      case "-z":
        return i === "";
      case "-n":
        return i !== "";
      case "!":
        return i === "";
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
          const c = e.fs.resolvePath(i, e.cwd), l = await e.fs.stat(c);
          return a === "-f" ? l.type === "file" : a === "-d" ? l.type === "dir" : a === "-L" || a === "-h" ? l.type === "symlink" : a === "-S" ? l.type === "socket" : a === "-p" ? l.type === "fifo" : a === "-b" ? l.type === "block" : a === "-c" ? l.type === "char" : !0;
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
          const c = e.fs.resolvePath(i, e.cwd);
          if (await e.fs.stat(c), a === "-s")
            try {
              const l = await ((o = (r = e.fs).readFile) == null ? void 0 : o.call(r, c));
              return l && l.length > 0;
            } catch {
              return !1;
            }
          return a === "-r" || a === "-w";
        } catch {
          return !1;
        }
      // Terminal tests (always false in browser)
      case "-t":
        return !1;
    }
  }
  if (n[0] === "!" && n.length > 1)
    return !await O(n.slice(1), e);
  if (n.length === 3) {
    const [a, i, c] = n;
    switch (i) {
      case "=":
      case "==":
        return a === c;
      case "!=":
        return a !== c;
      case "-eq":
        return parseInt(a) === parseInt(c);
      case "-ne":
        return parseInt(a) !== parseInt(c);
      case "-lt":
        return parseInt(a) < parseInt(c);
      case "-le":
        return parseInt(a) <= parseInt(c);
      case "-gt":
        return parseInt(a) > parseInt(c);
      case "-ge":
        return parseInt(a) >= parseInt(c);
    }
  }
  const t = n.indexOf("-a");
  if (t > 0)
    return await O(n.slice(0, t), e) && await O(n.slice(t + 1), e);
  const s = n.indexOf("-o");
  return s > 0 ? await O(n.slice(0, s), e) || await O(n.slice(s + 1), e) : !1;
}
const cs = {
  name: "time",
  description: "Time a command execution",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
    if (t.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const r = s.v || s.verbose, o = s.p, a = t.join(" "), i = globalThis.performance, c = i ? i.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const d = ((i ? i.now() : Date.now()) - c) / 1e3, p = Math.floor(d / 60), f = d % 60;
    let h;
    return o ? h = `real ${d.toFixed(2)}
user 0.00
sys 0.00
` : r ? h = `        ${d.toFixed(3)} real         0.000 user         0.000 sys
` : h = `
real    ${p}m${f.toFixed(3)}s
user    0m0.000s
sys     0m0.000s
`, {
      stdout: "",
      stderr: `Command: ${a}
${h}`,
      exitCode: 0
    };
  }
}, ls = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(n, e) {
    const { positional: t, flags: s, values: r } = y(n, ["k", "kill-after", "s", "signal"]);
    if (t.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const o = t[0], a = t.slice(1);
    if (a.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let i = ds(o);
    if (i === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${o}'
`,
        exitCode: 1
      };
    r.k || r["kill-after"];
    const c = r.s || r.signal || "TERM", l = s["preserve-status"];
    s.foreground;
    const u = s.v || s.verbose;
    try {
      const d = a.join(" ");
      if (u)
        return {
          stdout: "",
          stderr: `timeout: would run command '${d}' with ${i}s timeout using signal ${c}
`,
          exitCode: 0
        };
      const p = i * 1e3;
      let f = !1;
      if (await new Promise((h) => {
        const m = globalThis.setTimeout(() => {
          f = !0, h(null);
        }, p);
        globalThis.clearTimeout(m), h(null);
      }), f) {
        const h = l ? 143 : 124;
        return {
          stdout: "",
          stderr: `timeout: command '${d}' timed out after ${i}s
`,
          exitCode: h
        };
      }
      return {
        stdout: `Command: ${d}
`,
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `timeout: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
};
function ds(n) {
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
const us = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
    if (t.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    const r = s.c;
    try {
      for (const o of t) {
        const a = e.fs.resolvePath(o, e.cwd);
        let i = !1;
        try {
          await e.fs.stat(a), i = !0;
        } catch {
          i = !1;
        }
        if (i) {
          const c = await e.fs.readFile(a);
          await e.fs.writeFile(a, c);
        } else {
          if (r)
            continue;
          await e.fs.writeFile(a, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `touch: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, fs = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.d, o = t.s, a = _(s[0] ?? ""), i = _(s[1] ?? ""), c = e.stdin;
    let l;
    if (r) {
      const u = new Set(a.split(""));
      l = c.split("").filter((d) => !u.has(d)).join("");
    } else if (a && i) {
      const u = /* @__PURE__ */ new Map();
      for (let d = 0; d < a.length; d++)
        u.set(a[d], i[Math.min(d, i.length - 1)]);
      l = c.split("").map((d) => u.get(d) ?? d).join("");
    } else
      l = c;
    if (o && i) {
      const u = new Set(i.split(""));
      let d = "", p = "";
      for (const f of l)
        u.has(f) && f === p || (d += f, p = f);
      l = d;
    }
    return { stdout: l, stderr: "", exitCode: 0 };
  }
};
function _(n) {
  let e = n;
  e = e.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), e = e.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), e = e.replace(/\[:digit:\]/g, "0123456789"), e = e.replace(/\[:space:\]/g, ` 	
\r`), e = e.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), e = e.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let t = "", s = 0;
  for (; s < e.length; )
    if (s + 2 < e.length && e[s + 1] === "-") {
      const r = e.charCodeAt(s), o = e.charCodeAt(s + 2);
      for (let a = r; a <= o; a++)
        t += String.fromCharCode(a);
      s += 3;
    } else
      t += e[s], s++;
  return t;
}
const ps = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n, ["l", "p"]);
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
      ].map((a, i) => `${i}) SIG${a}`).join(`
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
}, hs = {
  name: "kill",
  description: "Send signal to process",
  async exec(n, e) {
    const { flags: t, values: s, positional: r } = y(n, ["l", "L", "s"]);
    if (t.l || t.L) {
      const a = [
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
        stdout: a.map((i, c) => `${c + 1}) SIG${i}`).join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: a.join(" ") + `
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
}, ms = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, gs = {
  name: "type",
  description: "Display information about command type",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
    if (t.length === 0)
      return { stdout: "", stderr: `type: missing operand
`, exitCode: 1 };
    const r = s.a, o = s.t, a = s.p, i = [];
    let c = 0;
    for (const l of t) {
      const u = (e.env.PATH || "/bin:/usr/bin").split(":");
      let d = !1;
      for (const p of u) {
        const f = p + "/" + l;
        try {
          if (await e.fs.exists(f) && (d = !0, o ? i.push("file") : a ? i.push(f) : i.push(`${l} is ${f}`), !r))
            break;
        } catch {
        }
      }
      d || (!o && !a && i.push(`type: ${l}: not found`), c = 1);
    }
    return {
      stdout: i.join(`
`) + (i.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: c
    };
  }
}, xs = {
  name: "unalias",
  description: "Remove alias definitions",
  async exec(n, e) {
    const { positional: t, flags: s } = y(n);
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
}, ys = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, ["t", "tabs"]), o = t.t || t.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.a || r.all;
    try {
      const { content: c } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), l = c.split(`
`), u = [];
      for (const d of l) {
        let p = "", f = 0, h = 0;
        for (let m = 0; m < d.length; m++) {
          const g = d[m];
          g === " " ? (h++, f++, f % a === 0 && (i || p.trim() === "" ? (h >= a && (p += "	".repeat(Math.floor(h / a)), h = h % a), h > 0 && (p += " ".repeat(h), h = 0)) : (p += " ".repeat(h), h = 0))) : (h > 0 && (p += " ".repeat(h), h = 0), p += g, f++);
        }
        h > 0 && (p += " ".repeat(h)), u.push(p);
      }
      return {
        stdout: u.join(`
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
}, ws = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, e) {
    const { flags: t, positional: s, values: r } = y(n, ["f", "s", "w"]), o = r.f ? parseInt(r.f) : 0, a = r.s ? parseInt(r.s) : 0, i = r.w ? parseInt(r.w) : void 0, c = t.i;
    try {
      const { content: l } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), u = l.split(`
`);
      u.length > 0 && u[u.length - 1] === "" && u.pop();
      const d = [];
      let p = "", f = "", h = 0;
      for (const m of u) {
        const g = vs(m, o, a, i, c);
        g === f ? h++ : (h > 0 && J(p, h, t, d), p = m, f = g, h = 1);
      }
      return h > 0 && J(p, h, t, d), { stdout: d.join(`
`) + (d.length > 0 ? `
` : ""), stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `uniq: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
};
function vs(n, e, t, s, r) {
  let o = n;
  return e > 0 && (o = n.split(/\s+/).slice(e).join(" ")), t > 0 && (o = o.substring(t)), s !== void 0 && (o = o.substring(0, s)), r && (o = o.toLowerCase()), o;
}
function J(n, e, t, s) {
  t.d && e < 2 || t.u && e > 1 || (t.c ? s.push(`${String(e).padStart(7)} ${n}`) : s.push(n));
}
const Cs = {
  name: "uname",
  description: "Print system information",
  async exec(n, e) {
    const { flags: t } = y(n), s = t.a, r = e.env.UNAME_SYSNAME ?? "FluffyOS", o = e.env.HOSTNAME ?? "localhost", a = e.env.UNAME_RELEASE ?? "1.0.0", i = e.env.UNAME_VERSION ?? "#1", c = e.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${r} ${o} ${a} ${i} ${c}
`, stderr: "", exitCode: 0 };
    if (t.s || !t.n && !t.r && !t.v && !t.m)
      return { stdout: r + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return t.s && l.push(r), t.n && l.push(o), t.r && l.push(a), t.v && l.push(i), t.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, $s = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, e) {
    const { flags: t } = y(n), s = t.p || t.pretty, r = t.s || t.since, o = 86400 + 3600 * 5 + 1380, a = Math.floor(o / 86400), i = Math.floor(o % 86400 / 3600), c = Math.floor(o % 3600 / 60), l = /* @__PURE__ */ new Date(), u = new Date(l.getTime() - o * 1e3), d = [];
    if (r)
      d.push(u.toISOString());
    else if (s) {
      const p = [];
      a > 0 && p.push(`${a} day${a !== 1 ? "s" : ""}`), i > 0 && p.push(`${i} hour${i !== 1 ? "s" : ""}`), c > 0 && p.push(`${c} minute${c !== 1 ? "s" : ""}`), d.push(`up ${p.join(", ")}`);
    } else {
      const p = l.toTimeString().split(" ")[0], f = a > 0 ? `${a} day${a !== 1 ? "s" : ""}, ${i}:${String(c).padStart(2, "0")}` : `${i}:${String(c).padStart(2, "0")}`;
      d.push(` ${p} up ${f}, 1 user, load average: 0.50, 0.40, 0.35`);
    }
    return {
      stdout: d.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, bs = {
  name: "watch",
  description: "Execute a program periodically, showing output",
  async exec(n, e) {
    const { values: t, positional: s, flags: r } = y(n, [
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
    const o = parseFloat(t.n || t.interval || "2"), a = s.join(" ");
    return {
      stdout: (r.t || r["no-title"] ? "" : `Every ${o}s: ${a}

`) + `watch: This is a stub implementation.
In a real shell, this would execute '${a}' every ${o} seconds.

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
}, Ss = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.l, o = t.w, a = t.c, i = !r && !o && !a;
    try {
      const { content: c, files: l } = await j(
        s,
        e.stdin,
        e.fs,
        e.cwd,
        e.fs.resolvePath
      ), u = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, p = c.length, f = [];
      return (i || r) && f.push(String(u).padStart(6)), (i || o) && f.push(String(d).padStart(6)), (i || a) && f.push(String(p).padStart(6)), l.length === 1 && f.push(" " + s[0]), { stdout: f.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Ps = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, e) {
    const { flags: t, positional: s } = y(n), r = t.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = s[0], a = e.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = a.split(":"), c = [];
    for (const l of i) {
      const u = `${l}/${o}`;
      try {
        if (await e.fs.exists(u) && (await e.fs.stat(u)).type === "file" && (c.push(u), !r))
          break;
      } catch {
        continue;
      }
    }
    return c.length === 0 ? {
      stdout: "",
      stderr: `which: no ${o} in (${a})
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
}, Es = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, e) {
    return { stdout: (e.env.USER ?? e.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, Is = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, e) {
    const { flags: t, positional: s, values: r } = y(n, ["n", "I", "i", "d", "delimiter"]), o = t.I || t.L || t.l, a = r.I || r.i, i = r.n ? parseInt(r.n) : void 0, c = r.d || r.delimiter || /\s+/, l = t.t || t.verbose, u = t.r, d = s.length > 0 ? s.join(" ") : "echo";
    let p;
    if (typeof c == "string" ? p = e.stdin.split(c).filter(Boolean) : p = e.stdin.trim().split(c).filter(Boolean), p.length === 0) {
      if (u)
        return { stdout: "", stderr: "", exitCode: 0 };
      p = [""];
    }
    const f = [], h = [];
    if (a) {
      const m = typeof a == "string" ? a : "{}";
      for (const g of p) {
        const x = d.replace(new RegExp(Fs(m), "g"), g);
        h.push(x), l && f.push(`+ ${x}`);
      }
    } else if (i)
      for (let m = 0; m < p.length; m += i) {
        const g = p.slice(m, m + i), x = `${d} ${g.map(L).join(" ")}`;
        h.push(x), l && f.push(`+ ${x}`);
      }
    else if (o)
      for (const m of p) {
        const g = `${d} ${L(m)}`;
        h.push(g), l && f.push(`+ ${g}`);
      }
    else {
      const m = d === "echo" ? p.join(" ") : `${d} ${p.map(L).join(" ")}`;
      h.push(m), l && f.push(`+ ${m}`);
    }
    return d === "echo" && !a && !i ? f.push(...p) : f.push(...h), {
      stdout: f.join(`
`) + (f.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function L(n) {
  return /[^a-zA-Z0-9._\-/=]/.test(n) ? `'${n.replace(/'/g, "'\\''")}'` : n;
}
function Fs(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Ts = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, e) {
    const { positional: t } = y(n), s = t.length > 0 ? t.join(" ") : "y", r = [], o = 1e3;
    for (let a = 0; a < o; a++)
      r.push(s);
    return {
      stdout: r.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, js = {
  ".": Qt,
  alias: X,
  array: Q,
  awk: ee,
  base64: te,
  basename: se,
  break: ne,
  case: re,
  cc: ae,
  cat: ie,
  chmod: ce,
  chown: le,
  clear: de,
  column: ue,
  comm: fe,
  continue: pe,
  cp: he,
  curl: me,
  cut: ge,
  date: ye,
  declare: Ce,
  df: Se,
  diff: Pe,
  dirname: Ie,
  do: je,
  done: Ne,
  du: Me,
  echo: Ae,
  elif: Oe,
  else: De,
  env: We,
  esac: oe,
  eval: Ue,
  exit: qe,
  expand: ze,
  expr: He,
  export: Ge,
  false: Be,
  fi: Le,
  file: Ze,
  find: Ke,
  fmt: Xe,
  fold: Qe,
  for: _e,
  free: et,
  function: Ye,
  gcc: Y,
  getopts: tt,
  grep: st,
  head: nt,
  heredoc: rt,
  hexdump: ot,
  hostname: at,
  id: ct,
  if: Re,
  in: Je,
  install: lt,
  join: dt,
  kill: hs,
  less: ut,
  let: ft,
  ln: pt,
  local: ve,
  ls: ht,
  make: yt,
  md5sum: vt,
  mkdir: $t,
  mv: bt,
  nl: St,
  nohup: Et,
  od: It,
  paste: Nt,
  patch: Mt,
  "pkg-config": kt,
  "process-substitution": Lt,
  printenv: Ot,
  printf: Dt,
  pwd: Wt,
  read: Ut,
  readlink: qt,
  readonly: $e,
  realpath: zt,
  return: Ht,
  rm: Gt,
  sed: Bt,
  seq: _t,
  set: Jt,
  sha256sum: Yt,
  shift: Vt,
  sleep: Kt,
  sort: Xt,
  source: V,
  stat: es,
  strings: ss,
  tail: rs,
  tar: os,
  tee: is,
  test: as,
  then: ke,
  time: cs,
  timeout: ls,
  touch: us,
  tr: fs,
  trap: ps,
  true: ms,
  type: gs,
  unalias: xs,
  unexpand: ys,
  uniq: ws,
  unset: be,
  uname: Cs,
  until: Te,
  uptime: $s,
  watch: bs,
  wc: Ss,
  which: Ps,
  while: Fe,
  whoami: Es,
  xargs: Is,
  yes: Ts
}, Ms = Object.values(js);
export {
  X as alias,
  js as allCommands,
  Ns as arithmeticExpansion,
  Q as arrayHelper,
  ee as awk,
  te as base64,
  se as basename,
  ne as break,
  re as case,
  ie as cat,
  ae as cc,
  ce as chmod,
  le as chown,
  de as clear,
  ue as column,
  fe as comm,
  Ms as commandList,
  pe as continue,
  he as cp,
  me as curl,
  ge as cut,
  ye as date,
  Ce as declare,
  Se as df,
  Pe as diff,
  Ie as dirname,
  je as do,
  Ne as done,
  Qt as dot,
  Me as du,
  Ae as echo,
  Oe as elif,
  De as else,
  We as env,
  oe as esac,
  Ue as eval,
  qe as exit,
  ze as expand,
  Ge as exportCmd,
  He as expr,
  Be as false,
  Le as fi,
  Ze as file,
  Ke as find,
  Xe as fmt,
  Qe as fold,
  _e as for,
  et as free,
  Ye as function,
  Y as gcc,
  tt as getopts,
  st as grep,
  nt as head,
  rt as heredoc,
  ot as hexdump,
  at as hostname,
  ct as id,
  Re as if,
  Je as in,
  lt as install,
  dt as join,
  hs as kill,
  ut as less,
  ft as let,
  ft as letCmd,
  pt as ln,
  ve as local,
  ht as ls,
  yt as make,
  vt as md5sum,
  $t as mkdir,
  bt as mv,
  St as nl,
  Et as nohup,
  It as od,
  Nt as paste,
  Mt as patch,
  kt as pkgConfig,
  Ot as printenv,
  Dt as printf,
  Lt as processSubstitution,
  Wt as pwd,
  Ut as read,
  qt as readlink,
  $e as readonly,
  zt as realpath,
  Ht as return,
  Gt as rm,
  Bt as sed,
  _t as seq,
  Jt as set,
  Yt as sha256sum,
  Vt as shift,
  Kt as sleep,
  Xt as sort,
  V as source,
  es as stat,
  ss as strings,
  rs as tail,
  os as tar,
  is as tee,
  as as test,
  ke as then,
  cs as time,
  ls as timeout,
  us as touch,
  fs as tr,
  ps as trap,
  ms as true,
  gs as type,
  xs as unalias,
  Cs as uname,
  ys as unexpand,
  ws as uniq,
  be as unset,
  Te as until,
  $s as uptime,
  bs as watch,
  Ss as wc,
  Ps as which,
  Fe as while,
  Es as whoami,
  Is as xargs,
  Ts as yes
};
