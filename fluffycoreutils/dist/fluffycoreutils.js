function y(n, t = []) {
  const e = {}, s = {}, o = [], r = new Set(t);
  for (let a = 0; a < n.length; a++) {
    const i = n[a];
    if (i === "--") {
      o.push(...n.slice(a + 1));
      break;
    }
    if (i.startsWith("--")) {
      const c = i.slice(2);
      r.has(c) && a + 1 < n.length ? s[c] = n[++a] : e[c] = !0;
    } else if (i.startsWith("-") && i.length > 1 && !/^-\d/.test(i)) {
      const c = i.slice(1);
      if (r.has(c) && a + 1 < n.length)
        s[c] = n[++a];
      else
        for (let l = 0; l < c.length; l++) {
          const u = c[l];
          if (r.has(u)) {
            const d = c.slice(l + 1);
            d ? s[u] = d : a + 1 < n.length && (s[u] = n[++a]);
            break;
          }
          e[u] = !0;
        }
    } else
      o.push(i);
  }
  return { flags: e, values: s, positional: o };
}
async function F(n, t, e, s, o) {
  if (n.length === 0)
    return { content: t, files: [] };
  const r = [], a = [];
  for (const i of n) {
    const c = o(i, s);
    r.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: r };
}
const X = {
  name: "alias",
  description: "Define or display aliases",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    const o = [];
    for (const r of e)
      s.p && o.push(`alias ${r}`);
    return {
      stdout: o.join(`
`) + (o.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, Z = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const o = s[0], r = s.slice(1), a = e.F || /\s+/, i = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (e.v) {
      const l = e.v.split("=");
      l.length === 2 && (c[l[0]] = l[1]);
    }
    try {
      const { content: l } = await F(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = l.split(`
`).filter((x) => x !== "" || l.endsWith(`
`)), d = [], p = o.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), f = o.match(/END\s*\{\s*([^}]*)\s*\}/), h = o.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let m = 0, g = 0;
      if (p) {
        const x = D(p[1], [], 0, 0, c);
        x && d.push(x);
      }
      for (const x of u) {
        m++;
        const w = x.split(i).filter((b) => b !== "");
        g = w.length;
        let v = !0;
        if (h) {
          const b = h[1], C = h[2];
          if (b)
            try {
              v = new RegExp(b).test(x);
            } catch {
              v = !1;
            }
          if (v) {
            const $ = D(C, w, m, g, c);
            $ !== null && d.push($);
          }
        } else if (!p && !f) {
          const b = D(o, w, m, g, c);
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
function D(n, t, e, s, o) {
  let r = n.trim();
  if (r.startsWith("print")) {
    const a = r.substring(5).trim();
    if (!a || a === "")
      return t.join(" ");
    let i = a;
    i = i.replace(/\$0/g, t.join(" ")), i = i.replace(/\$NF/g, t[t.length - 1] || "");
    for (let c = 1; c <= t.length; c++)
      i = i.replace(new RegExp(`\\$${c}`, "g"), t[c - 1] || "");
    i = i.replace(/\bNR\b/g, String(e)), i = i.replace(/\bNF\b/g, String(s));
    for (const [c, l] of Object.entries(o))
      i = i.replace(new RegExp(`\\b${c}\\b`, "g"), l);
    return i = i.replace(/^["'](.*)["']$/, "$1"), i = i.replace(/\s+/g, " ").trim(), i;
  }
  return null;
}
const Q = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.d || e.decode, r = e.w ? parseInt(e.w) : 76, a = e.i || e["ignore-garbage"];
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let c;
      if (o) {
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
        if (r > 0) {
          const u = [];
          for (let d = 0; d < l.length; d += r)
            u.push(l.substring(d, d + r));
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
}, tt = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let t = n[0].replace(/\/+$/, "").split("/").pop() || "/";
    return n.length > 1 && t.endsWith(n[1]) && (t = t.slice(0, -n[1].length)), { stdout: t + `
`, stderr: "", exitCode: 0 };
  }
}, et = {
  name: "break",
  description: "Exit from a for, while, or until loop",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? parseInt(e[0]) : 1;
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
}, st = {
  name: "case",
  description: "Pattern matching (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `case: this is a shell language construct that must be interpreted by the shell
Usage: case WORD in PATTERN) COMMANDS ;; esac
`,
      exitCode: 2
    };
  }
}, nt = {
  name: "esac",
  description: "End case statement (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `esac: can only be used to close a case statement
`,
      exitCode: 2
    };
  }
}, rt = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: o } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return e.n ? { stdout: o.split(`
`).map((i, c) => `${String(c + 1).padStart(6)}	${i}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: o, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `cat: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, Y = {
  name: "gcc",
  description: "GNU C Compiler (stub)",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, [
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
    if (e.version || e.v)
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
    const r = o, a = s.o || "a.out";
    for (const p of r) {
      const f = t.fs.resolvePath(p, t.cwd);
      if (!await t.fs.exists(f))
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
    for (const p of r)
      if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp"))
        try {
          const f = t.fs.resolvePath(p, t.cwd), h = await t.fs.readFile(f);
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
    if (e.E)
      return {
        stdout: c.split(`
`).filter((f) => !f.trim().startsWith("#")).join(`
`),
        stderr: "",
        exitCode: 0
      };
    if (e.c) {
      for (const p of r)
        if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp")) {
          const f = p.replace(/\.(c|cc|cpp)$/, ".o"), h = t.fs.resolvePath(f, t.cwd);
          await t.fs.writeFile(h, `# Object file stub for ${p}
`);
        }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }
    if (e.S) {
      for (const p of r)
        if (p.endsWith(".c") || p.endsWith(".cc") || p.endsWith(".cpp")) {
          const f = p.replace(/\.(c|cc|cpp)$/, ".s"), h = t.fs.resolvePath(f, t.cwd);
          await t.fs.writeFile(h, `# Assembly stub for ${p}
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
    if (!i && !e.shared && !e.c)
      return {
        stdout: "",
        stderr: `gcc: error: undefined reference to 'main'
collect2: error: ld returned 1 exit status
`,
        exitCode: 1
      };
    const l = t.fs.resolvePath(a, t.cwd), u = /printf\s*\(\s*["'].*[Hh]ello.*["']/.test(c) || /puts\s*\(\s*["'].*[Hh]ello.*["']/.test(c);
    let d = `#!/bin/sh
`;
    return u ? d += `echo 'Hello, World!'
` : d += `# Compiled binary stub
`, await t.fs.writeFile(l, d), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, ot = {
  name: "cc",
  description: "C Compiler (alias for gcc)",
  async exec(n, t) {
    return Y.exec(n, t);
  }
}, it = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const r = s[0], a = s.slice(1), i = parseInt(r, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${r}'
`, exitCode: 1 };
    async function c(l) {
      const u = t.fs.resolvePath(l, t.cwd);
      if (o)
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const p = await t.fs.readdir(u);
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
}, at = {
  name: "chown",
  description: "Change file owner and group",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length < 2)
      return { stdout: "", stderr: `chown: missing operand
`, exitCode: 1 };
    const o = s[0], r = s.slice(1);
    e.R;
    const a = e.v, i = o.split(":");
    i[0], i[1];
    const c = [];
    try {
      for (const l of r)
        a && c.push(`ownership of '${l}' retained as ${o}`);
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
}, ct = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, lt = {
  name: "column",
  description: "Format input into columns",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["t", "s", "c", "x", "n"]);
    try {
      const { content: r } = await F(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), a = r.split(`
`);
      if (a.length > 0 && a[a.length - 1] === "" && a.pop(), e.t) {
        const p = s.s || "	", f = new RegExp(p), h = a.map((w) => w.split(f)), m = Math.max(...h.map((w) => w.length)), g = new Array(m).fill(0);
        for (const w of h)
          for (let v = 0; v < w.length; v++)
            g[v] = Math.max(g[v] || 0, w[v].length);
        const x = h.map((w) => w.map((v, b) => {
          const C = g[b];
          return v.padEnd(C);
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
      if (e.x) {
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
    } catch (r) {
      return {
        stdout: "",
        stderr: `column: ${r.message}
`,
        exitCode: 1
      };
    }
  }
}, dt = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `comm: missing operand
`,
        exitCode: 1
      };
    const o = e[1], r = e[2], a = e[3];
    try {
      const i = t.fs.resolvePath(s[0], t.cwd), c = t.fs.resolvePath(s[1], t.cwd), l = await t.fs.readFile(i), u = await t.fs.readFile(c), d = l.split(`
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
          if (!r) {
            const w = o ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else if (x === null)
          o || f.push(g), h++;
        else if (g < x)
          o || f.push(g), h++;
        else if (g > x) {
          if (!r) {
            const w = o ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else {
          if (!a) {
            let w = "";
            o || (w += "	"), r || (w += "	"), f.push(w + g);
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
}, ut = {
  name: "continue",
  description: "Continue to next iteration of a for, while, or until loop",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? parseInt(e[0]) : 1;
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
}, ft = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.r || e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const r = t.fs.resolvePath(s[s.length - 1], t.cwd), a = s.slice(0, -1);
    let i = !1;
    try {
      i = (await t.fs.stat(r)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !i)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(u, d) {
      const p = await t.fs.readFile(u);
      await t.fs.writeFile(d, p);
    }
    async function l(u, d) {
      await t.fs.mkdir(d, { recursive: !0 });
      const p = await t.fs.readdir(u);
      for (const f of p) {
        const h = u + "/" + f.name, m = d + "/" + f.name;
        f.type === "dir" ? await l(h, m) : await c(h, m);
      }
    }
    try {
      for (const u of a) {
        const d = t.fs.resolvePath(u, t.cwd), p = await t.fs.stat(d), f = u.split("/").pop(), h = i ? r + "/" + f : r;
        if (p.type === "dir") {
          if (!o)
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
}, pt = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (o.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const r = o[0], a = s.X || s.request || (s.d || s.data ? "POST" : "GET"), i = s.o || s.output, c = e.s || e.silent, l = e.i || e.include, u = e.I || e.head, d = e.L || e.location, p = {}, f = s.H || s.header;
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
      const x = await fetch(r, g);
      let w = "";
      if ((l || u) && (w += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((v, b) => {
        w += `${b}: ${v}
`;
      }), w += `
`), !u) {
        const v = await x.text();
        w += v;
      }
      if (i) {
        const v = t.fs.resolvePath(i, t.cwd);
        return await t.fs.writeFile(v, u ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
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
}, ht = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["d", "f", "c"]), o = e.d ?? "	", r = e.f, a = e.c;
    if (!r && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = mt(r ?? a), l = i.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const u = [];
      for (const d of l)
        if (r) {
          const p = d.split(o), f = c.flatMap((h) => p.slice(h.start - 1, h.end)).filter((h) => h !== void 0);
          u.push(f.join(o));
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
function mt(n) {
  return n.split(",").map((t) => {
    if (t.includes("-")) {
      const [s, o] = t.split("-");
      return {
        start: s ? parseInt(s, 10) : 1,
        end: o ? parseInt(o, 10) : 1 / 0
      };
    }
    const e = parseInt(t, 10);
    return { start: e, end: e };
  });
}
const gt = {
  name: "date",
  description: "Display date and time",
  async exec(n, t) {
    const { flags: e, positional: s, values: o } = y(n, ["d", "date", "r", "reference", "u"]);
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
    const a = e.u || e.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const c = s[0].slice(1);
      return { stdout: xt(r, c, a) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (a ? r.toUTCString() : r.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function xt(n, t, e = !1) {
  const s = (w) => String(w).padStart(2, "0"), o = (w) => String(w).padStart(3, "0"), r = (w) => e ? n[`getUTC${w}`]() : n[`get${w}`](), a = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], c = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], u = r("FullYear"), d = r("Month"), p = r("Date"), f = r("Hours"), h = r("Minutes"), m = r("Seconds"), g = r("Milliseconds"), x = r("Day");
  return t.replace(/%Y/g, String(u)).replace(/%y/g, String(u).slice(-2)).replace(/%m/g, s(d + 1)).replace(/%d/g, s(p)).replace(/%e/g, String(p).padStart(2, " ")).replace(/%H/g, s(f)).replace(/%I/g, s(f % 12 || 12)).replace(/%M/g, s(h)).replace(/%S/g, s(m)).replace(/%N/g, o(g) + "000000").replace(/%p/g, f >= 12 ? "PM" : "AM").replace(/%P/g, f >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, a[x]).replace(/%a/g, i[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, c[d]).replace(/%b/g, l[d]).replace(/%h/g, l[d]).replace(/%F/g, `${u}-${s(d + 1)}-${s(p)}`).replace(/%T/g, `${s(f)}:${s(h)}:${s(m)}`).replace(/%R/g, `${s(f)}:${s(h)}`).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const yt = {
  name: "local",
  description: "Declare local variables in shell functions",
  async exec(n, t) {
    const { positional: e } = y(n, ["r", "a", "i", "x"]);
    return e.length === 0 ? {
      stdout: "",
      stderr: `local: usage: local [-r] [-a] [-i] [-x] [name[=value] ...]
`,
      exitCode: 1
    } : (e.map((s) => {
      const [o, r] = s.split("=", 2);
      return r !== void 0 ? `${o}=${r}` : o;
    }), {
      stdout: "",
      stderr: "",
      exitCode: 0
    });
  }
}, wt = {
  name: "declare",
  description: "Declare variables and give them attributes",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n, ["r", "a", "A", "i", "x", "p", "f", "g"]);
    if (e.p)
      return s.length === 0 ? {
        stdout: `# Shell variables would be listed here
`,
        stderr: "",
        exitCode: 0
      } : {
        stdout: s.map((r) => {
          const a = t.env[r];
          return a !== void 0 ? `declare -- ${r}="${a}"
` : "";
        }).join(""),
        stderr: "",
        exitCode: 0
      };
    for (const o of s) {
      const [r, a] = o.split("=", 2);
      a !== void 0 && t.env && (t.env[r] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, Ct = {
  name: "readonly",
  description: "Mark variables as readonly",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n, ["p", "f"]);
    if (e.p)
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
      const [r, a] = o.split("=", 2);
      a !== void 0 && t.env && (t.env[r] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, vt = {
  name: "unset",
  description: "Unset variables or functions",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n, ["v", "f"]);
    if (s.length === 0)
      return {
        stdout: "",
        stderr: `unset: usage: unset [-v] [-f] [name ...]
`,
        exitCode: 1
      };
    if (!e.f && t.env)
      for (const o of s)
        delete t.env[o];
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, $t = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.h, o = e.i, r = [];
    return o ? (r.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on"), r.push("virtual             0      0       0    0% /")) : s ? (r.push("Filesystem      Size  Used Avail Use% Mounted on"), r.push("virtual         100G   10G   90G  10% /")) : (r.push("Filesystem     1K-blocks    Used Available Use% Mounted on"), r.push("virtual        104857600 10485760  94371840  10% /")), {
      stdout: r.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, bt = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, t) {
    var p, f;
    const { flags: e, positional: s, values: o } = y(n, ["U", "context", "C"]), r = e.u || o.U !== void 0, a = o.U || o.context || o.C || (e.u ? 3 : 0), i = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, l = e.i, u = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (s.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const h = t.fs.resolvePath(s[0], t.cwd), m = t.fs.resolvePath(s[1], t.cwd), g = await t.fs.readFile(h), x = await t.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${s[0]} and ${s[1]} differ
`, stderr: "", exitCode: 1 };
      const w = g.split(`
`), v = x.split(`
`), b = St(w, v, { ignoreCase: l, ignoreWhitespace: u }), C = [];
      if (r) {
        C.push(`--- ${s[0]}`), C.push(`+++ ${s[1]}`);
        let $ = 0;
        for (; $ < b.length; ) {
          if (b[$].type === "equal") {
            $++;
            continue;
          }
          const P = Math.max(0, $ - 1);
          let I = $;
          for (; I < b.length; ) {
            const E = b[I];
            if (E.type !== "equal")
              I++;
            else if (E.lines.length <= i * 2)
              I++;
            else
              break;
          }
          const j = (((p = b[P]) == null ? void 0 : p.line1) ?? 0) + 1, R = (((f = b[P]) == null ? void 0 : f.line2) ?? 0) + 1;
          let T = 0, M = 0;
          for (let E = P; E < I; E++)
            (b[E].type === "equal" || b[E].type === "delete") && (T += b[E].lines.length), (b[E].type === "equal" || b[E].type === "add") && (M += b[E].lines.length);
          C.push(`@@ -${j},${T} +${R},${M} @@`);
          for (let E = P; E < I; E++) {
            const N = b[E];
            N.type === "equal" ? N.lines.forEach((k) => C.push(` ${k}`)) : N.type === "delete" ? N.lines.forEach((k) => C.push(`-${k}`)) : N.type === "add" && N.lines.forEach((k) => C.push(`+${k}`));
          }
          $ = I;
        }
      } else if (d)
        for (const S of b)
          S.type === "equal" ? S.lines.forEach((P) => {
            const I = P.substring(0, 40).padEnd(40);
            C.push(`${I} | ${P}`);
          }) : S.type === "delete" ? S.lines.forEach((P) => {
            const I = P.substring(0, 40).padEnd(40);
            C.push(`${I} <`);
          }) : S.type === "add" && S.lines.forEach((P) => {
            C.push(`${" ".repeat(40)} > ${P}`);
          });
      else
        for (const $ of b) {
          if ($.type === "equal") continue;
          const S = ($.line1 ?? 0) + 1, P = ($.line2 ?? 0) + 1;
          $.type === "delete" ? (C.push(`${S},${S + $.lines.length - 1}d${P - 1}`), $.lines.forEach((I) => C.push(`< ${I}`))) : $.type === "add" && (C.push(`${S - 1}a${P},${P + $.lines.length - 1}`), $.lines.forEach((I) => C.push(`> ${I}`)));
        }
      return { stdout: C.join(`
`) + (C.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (h) {
      return { stdout: "", stderr: `diff: ${h instanceof Error ? h.message : h}
`, exitCode: 2 };
    }
  }
};
function St(n, t, e = {}) {
  const s = n.length, o = t.length, r = (u) => {
    let d = u;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(s + 1).fill(0).map(() => Array(o + 1).fill(0));
  for (let u = 1; u <= s; u++)
    for (let d = 1; d <= o; d++)
      r(n[u - 1]) === r(t[d - 1]) ? a[u][d] = a[u - 1][d - 1] + 1 : a[u][d] = Math.max(a[u - 1][d], a[u][d - 1]);
  const i = [];
  let c = s, l = o;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && r(n[c - 1]) === r(t[l - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(t[l - 1]) : i.push({ type: "add", lines: [t[l - 1]], line1: c, line2: l - 1 }), l--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: l }), c--);
  return i.reverse();
}
const Pt = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const t = n[0].replace(/\/+$/, ""), e = t.lastIndexOf("/");
    return { stdout: (e === -1 ? "." : e === 0 ? "/" : t.slice(0, e)) + `
`, stderr: "", exitCode: 0 };
  }
}, It = {
  name: "while",
  description: "Loop while condition is true (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `while: this is a shell language construct that must be interpreted by the shell
Usage: while CONDITION; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, Et = {
  name: "until",
  description: "Loop until condition is true (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `until: this is a shell language construct that must be interpreted by the shell
Usage: until CONDITION; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, jt = {
  name: "do",
  description: "Start loop body (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `do: can only be used as part of a for/while/until loop
`,
      exitCode: 2
    };
  }
}, Nt = {
  name: "done",
  description: "End loop (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `done: can only be used to close a for/while/until loop
`,
      exitCode: 2
    };
  }
}, Ft = {
  name: "du",
  description: "Estimate file space usage",
  async exec(n, t) {
    const { flags: e, positional: s, values: o } = y(n, ["max-depth", "d"]), r = s.length > 0 ? s : ["."], a = e.s, i = e.a, c = e.h, l = o["max-depth"] || o.d, u = l ? parseInt(l) : 1 / 0, d = [];
    try {
      for (const p of r) {
        const f = t.fs.resolvePath(p, t.cwd), h = await _(f, t.fs, 0, u, i, !a, d, c), m = c ? W(h) : String(Math.ceil(h / 1024));
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
async function _(n, t, e, s, o, r, a, i) {
  try {
    const c = await t.stat(n);
    if (c.type === "file")
      return c.size;
    if (c.type === "dir" && e < s) {
      const l = await t.readdir(n);
      let u = 0;
      for (const d of l) {
        const p = n + "/" + d.name, f = await _(p, t, e + 1, s, o, r, a, i);
        if (u += f, o && d.type === "file") {
          const h = i ? W(f) : String(Math.ceil(f / 1024));
          a.push(`${h}	${p}`);
        }
        if (r && d.type === "dir" && e + 1 < s) {
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
  const t = ["", "K", "M", "G", "T"];
  let e = n, s = 0;
  for (; e >= 1024 && s < t.length - 1; )
    e /= 1024, s++;
  return Math.ceil(e) + t[s];
}
const Tt = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: t } = y(n), e = t.n, s = n.filter((r) => r !== "-n" && r !== "-e").join(" ");
    let o = t.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return e || (o += `
`), { stdout: o, stderr: "", exitCode: 0 };
  }
}, Mt = {
  name: "if",
  description: "Conditional execution (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `if: this is a shell language construct that must be interpreted by the shell
Usage: if CONDITION; then COMMANDS; [elif CONDITION; then COMMANDS;] [else COMMANDS;] fi
`,
      exitCode: 2
    };
  }
}, At = {
  name: "then",
  description: "Part of if/elif statement (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `then: can only be used as part of an if/elif statement
`,
      exitCode: 2
    };
  }
}, kt = {
  name: "elif",
  description: "Else-if branch (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `elif: can only be used as part of an if statement
`,
      exitCode: 2
    };
  }
}, Rt = {
  name: "else",
  description: "Else branch (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `else: can only be used as part of an if statement
`,
      exitCode: 2
    };
  }
}, Ot = {
  name: "fi",
  description: "End if statement (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `fi: can only be used to close an if statement
`,
      exitCode: 2
    };
  }
}, Dt = {
  name: "env",
  description: "Print environment variables",
  async exec(n, t) {
    return { stdout: Object.entries(t.env).map(([s, o]) => `${s}=${o}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, Lt = {
  name: "eval",
  description: "Evaluate and execute arguments as a shell command",
  async exec(n, t) {
    const { positional: e } = y(n);
    return e.join(" "), {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, Wt = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? parseInt(e[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, Ut = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["t", "tabs"]), r = e.t || e.tabs || "8", a = parseInt(r, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${r}'
`,
        exitCode: 1
      };
    const i = o.i || o.initial;
    try {
      const { content: c } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, qt = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(n, t) {
    const { positional: e } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `expr: missing operand
`, exitCode: 1 };
    try {
      const s = A(e);
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
  for (let t = 0; t < n.length; t++)
    if (n[t] === "|") {
      const e = A(n.slice(0, t)), s = A(n.slice(t + 1));
      return e && e !== "0" && e !== "" ? e : s;
    }
  for (let t = 0; t < n.length; t++)
    if (n[t] === "&") {
      const e = A(n.slice(0, t)), s = A(n.slice(t + 1));
      return e && e !== "0" && e !== "" && s && s !== "0" && s !== "" ? e : 0;
    }
  for (let t = 0; t < n.length; t++) {
    const e = n[t];
    if (["=", "!=", "<", ">", "<=", ">="].includes(e)) {
      const s = String(A(n.slice(0, t))), o = String(A(n.slice(t + 1))), r = parseFloat(s), a = parseFloat(o), i = !isNaN(r) && !isNaN(a);
      let c = !1;
      if (i)
        switch (e) {
          case "=":
            c = r === a;
            break;
          case "!=":
            c = r !== a;
            break;
          case "<":
            c = r < a;
            break;
          case ">":
            c = r > a;
            break;
          case "<=":
            c = r <= a;
            break;
          case ">=":
            c = r >= a;
            break;
        }
      else
        switch (e) {
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
  for (let t = n.length - 1; t >= 0; t--)
    if (n[t] === "+" || n[t] === "-") {
      const e = Number(A(n.slice(0, t))), s = Number(A(n.slice(t + 1)));
      return n[t] === "+" ? e + s : e - s;
    }
  for (let t = n.length - 1; t >= 0; t--)
    if (["*", "/", "%"].includes(n[t])) {
      const e = Number(A(n.slice(0, t))), s = Number(A(n.slice(t + 1)));
      if (n[t] === "*") return e * s;
      if (n[t] === "/") {
        if (s === 0) throw new Error("division by zero");
        return Math.floor(e / s);
      }
      if (n[t] === "%") {
        if (s === 0) throw new Error("division by zero");
        return e % s;
      }
    }
  if (n.length === 3) {
    if (n[1] === ":") {
      const t = n[0], e = n[2];
      try {
        const s = new RegExp("^" + e), o = t.match(s);
        return o ? o[0].length : 0;
      } catch {
        throw new Error("invalid regular expression");
      }
    }
    if (n[0] === "length")
      return String(n[1]).length;
    if (n[0] === "index") {
      const t = n[1], e = n[2];
      for (let s = 0; s < t.length; s++)
        if (e.includes(t[s]))
          return s + 1;
      return 0;
    }
  }
  if (n.length === 4 && n[0] === "substr") {
    const t = n[1], e = Number(n[2]) - 1, s = Number(n[3]);
    return t.substring(e, e + s);
  }
  if (n.length === 1) {
    const t = parseFloat(n[0]);
    return isNaN(t) ? n[0] : t;
  }
  throw new Error("syntax error");
}
const zt = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(n, t) {
    if (n.length === 0)
      return { stdout: Object.entries(t.env).map(([r, a]) => `export ${r}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], s = [];
    for (const o of n) {
      const r = o.indexOf("=");
      if (r === -1) {
        const a = o;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          s.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in t.env ? e.push(`export ${a}="${t.env[a]}"`) : e.push(`export ${a}=""`);
      } else {
        const a = o.slice(0, r);
        let i = o.slice(r + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          s.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        (i.startsWith('"') && i.endsWith('"') || i.startsWith("'") && i.endsWith("'")) && (i = i.slice(1, -1)), t.env[a] = i, e.push(`export ${a}="${i}"`);
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
}, Gt = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, Ht = {
  name: "for",
  description: "Iterate over list (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `for: this is a shell language construct that must be interpreted by the shell
Usage: for VAR in LIST; do COMMANDS; done
`,
      exitCode: 2
    };
  }
}, Bt = {
  name: "in",
  description: "Part of for loop (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `in: can only be used as part of a for loop or case statement
`,
      exitCode: 2
    };
  }
}, Jt = {
  name: "function",
  description: "Define shell function (shell language construct)",
  async exec(n, t) {
    return {
      stdout: "",
      stderr: `function: this is a shell language construct that must be interpreted by the shell
Usage: function NAME { COMMANDS; } or NAME() { COMMANDS; }
`,
      exitCode: 2
    };
  }
}, Yt = {
  name: "file",
  description: "Determine file type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `file: missing operand
`, exitCode: 1 };
    const o = s.b, r = s.i || s.mime, a = s["mime-type"], i = s["mime-encoding"], c = [];
    try {
      for (const l of e) {
        const u = t.fs.resolvePath(l, t.cwd);
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const m = o ? "directory" : `${l}: directory`;
            c.push(m);
            continue;
          }
          const p = await t.fs.readFile(u), f = _t(p, l);
          let h;
          a ? h = o ? f.mimeType : `${l}: ${f.mimeType}` : i ? h = o ? f.encoding : `${l}: ${f.encoding}` : r ? h = o ? `${f.mimeType}; charset=${f.encoding}` : `${l}: ${f.mimeType}; charset=${f.encoding}` : h = o ? f.description : `${l}: ${f.description}`, c.push(h);
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
function _t(n, t) {
  var a;
  let e = "text/plain", s = "us-ascii", o = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", o = "UTF-8 Unicode text"), n.length === 0)
    return e = "application/x-empty", o = "empty", { mimeType: e, encoding: s, description: o };
  const r = (a = t.split(".").pop()) == null ? void 0 : a.toLowerCase();
  if (r)
    switch (r) {
      case "js":
      case "mjs":
        e = "text/javascript", o = "JavaScript source";
        break;
      case "ts":
        e = "text/x-typescript", o = "TypeScript source";
        break;
      case "json":
        e = "application/json", o = "JSON data";
        break;
      case "html":
      case "htm":
        e = "text/html", o = "HTML document";
        break;
      case "css":
        e = "text/css", o = "CSS stylesheet";
        break;
      case "xml":
        e = "text/xml", o = "XML document";
        break;
      case "md":
        e = "text/markdown", o = "Markdown text";
        break;
      case "sh":
        e = "text/x-shellscript", o = "shell script";
        break;
      case "py":
        e = "text/x-python", o = "Python script";
        break;
      case "txt":
        e = "text/plain", o = "ASCII text";
        break;
    }
  if (n.startsWith("#!/bin/sh") || n.startsWith("#!/bin/bash"))
    e = "text/x-shellscript", o = "Bourne-Again shell script";
  else if (n.startsWith("#!/usr/bin/env node"))
    e = "text/javascript", o = "Node.js script";
  else if (n.startsWith("#!/usr/bin/env python"))
    e = "text/x-python", o = "Python script";
  else if (n.startsWith("{") && n.trim().endsWith("}"))
    try {
      JSON.parse(n), e = "application/json", o = "JSON data";
    } catch {
    }
  else n.startsWith("<?xml") ? (e = "text/xml", o = "XML document") : (n.startsWith("<!DOCTYPE html") || n.startsWith("<html")) && (e = "text/html", o = "HTML document");
  return { mimeType: e, encoding: s, description: o };
}
const Kt = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), r = s[0] ?? ".", a = e.name, i = e.iname, c = e.path, l = e.type, u = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, p = e.exec, f = o.print !== !1, h = t.fs.resolvePath(r, t.cwd), m = [], g = [];
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
    let v;
    if (c) {
      const $ = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      v = new RegExp($);
    }
    async function b($, S, P) {
      let I;
      try {
        I = await t.fs.readdir($);
      } catch {
        return;
      }
      for (const j of I) {
        const R = $ + "/" + j.name, T = S ? S + "/" + j.name : j.name, M = r === "." ? "./" + T : r + "/" + T, E = P + 1;
        let N = !0;
        if (!(E > u)) {
          if (E < d && (N = !1), x && !x.test(j.name) && (N = !1), w && !w.test(j.name) && (N = !1), v && !v.test(M) && (N = !1), l === "f" && j.type !== "file" && (N = !1), l === "d" && j.type !== "dir" && (N = !1), N && (f && m.push(M), p)) {
            const k = p.replace(/\{\}/g, M);
            g.push(`Executing: ${k}`);
          }
          j.type === "dir" && E < u && await b(R, T, E);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !w && !v && f && m.push(r === "." ? "." : r), await b(h, "", 0);
    let C = "";
    return m.length > 0 && (C = m.join(`
`) + `
`), g.length > 0 && (C += g.join(`
`) + `
`), { stdout: C, stderr: "", exitCode: 0 };
  }
}, Vt = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["w", "width"]), r = parseInt(e.w || e.width || "75", 10);
    o.u;
    const a = o.s;
    if (isNaN(r) || r <= 0)
      return {
        stdout: "",
        stderr: `fmt: invalid width: '${e.w || e.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = i.split(`
`), l = [];
      let u = [];
      const d = () => {
        if (u.length !== 0) {
          if (a)
            for (const p of u)
              l.push(...U(p, r));
          else {
            const p = u.join(" ").trim();
            p && l.push(...U(p, r));
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
function U(n, t) {
  const e = [], s = n.split(/\s+/);
  let o = "";
  for (const r of s)
    o.length === 0 ? o = r : o.length + 1 + r.length <= t ? o += " " + r : (e.push(o), o = r);
  return o.length > 0 && e.push(o), e;
}
const Xt = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["w", "width"]), r = parseInt(e.w || e.width || "80", 10);
    o.b;
    const a = o.s;
    if (isNaN(r) || r <= 0)
      return {
        stdout: "",
        stderr: `fold: invalid width: '${e.w || e.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = i.split(`
`), l = [];
      for (const u of c) {
        if (u.length <= r) {
          l.push(u);
          continue;
        }
        let d = u;
        for (; d.length > r; ) {
          let p = r;
          if (a) {
            const f = d.substring(0, r).lastIndexOf(" ");
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
}, Zt = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.h, o = e.b, r = e.m, a = e.g, i = [], c = 8388608, l = 4194304, u = 4194304, d = 524288, p = 1048576, f = 5242880;
    return s ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), i.push("Swap:           2.0G          0B        2.0G")) : o ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:    ${c * 1024} ${l * 1024} ${u * 1024} ${d * 1024} ${p * 1024} ${f * 1024}`), i.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : r ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:           ${Math.floor(c / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(u / 1024)}         ${Math.floor(d / 1024)}        ${Math.floor(p / 1024)}        ${Math.floor(f / 1024)}`), i.push("Swap:          2048           0        2048")) : a ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:               8           4           4           0           1           5"), i.push("Swap:              2           0           2")) : (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:        ${c}     ${l}     ${u}      ${d}     ${p}     ${f}`), i.push("Swap:       2097152           0     2097152")), {
      stdout: i.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Qt = {
  name: "getopts",
  description: "Parse option arguments (shell built-in)",
  async exec(n, t) {
    var f, h;
    if (n.length < 2)
      return {
        stdout: "",
        stderr: `getopts: usage: getopts OPTSTRING NAME [args...]
`,
        exitCode: 1
      };
    const e = n[0], s = n[1], o = n.slice(2);
    let r = parseInt(((f = t.env) == null ? void 0 : f.OPTIND) || "1");
    const a = e.startsWith(":"), i = a ? e.slice(1) : e, c = /* @__PURE__ */ new Map();
    for (let m = 0; m < i.length; m++) {
      const g = i[m];
      if (g === ":") continue;
      const x = i[m + 1] === ":";
      c.set(g, x);
    }
    const l = o.length > 0 ? o : (h = t.env) != null && h.$1 ? [t.env.$1, t.env.$2, t.env.$3].filter(Boolean) : [];
    if (l.length === 0 || r > l.length)
      return t.env && (t.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const u = l[r - 1];
    if (!u || !u.startsWith("-") || u === "-" || u === "--")
      return t.env && (t.env.OPTIND = "1"), {
        stdout: "",
        stderr: "",
        exitCode: 1
      };
    const d = u[1];
    if (!c.has(d))
      return t.env && (t.env[s] = "?", t.env.OPTARG = d, t.env.OPTIND = String(r + 1)), a ? {
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
      else if (r < l.length)
        m = l[r], t.env && (t.env.OPTIND = String(r + 2));
      else
        return t.env && (t.env[s] = "?", t.env.OPTARG = d, t.env.OPTIND = String(r + 1)), a ? {
          stdout: "",
          stderr: "",
          exitCode: 0
        } : {
          stdout: "",
          stderr: `getopts: option requires an argument -- ${d}
`,
          exitCode: 0
        };
      t.env && (t.env[s] = d, t.env.OPTARG = m, t.env.OPTIND || (t.env.OPTIND = String(r + 1)));
    } else
      t.env && (t.env[s] = d, t.env.OPTIND = String(r + 1), delete t.env.OPTARG);
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, te = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["e"]), r = !!e.i, a = !!e.v, i = !!e.c, c = !!e.l, l = !!e.n, u = !!(e.r || e.R), d = s.e ?? o.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const p = r ? "i" : "";
    let f;
    try {
      f = new RegExp(d, p);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const h = o.length > 0 ? o : ["-"], m = h.length > 1 || u, g = [];
    let x = !1;
    async function w(C, $) {
      let S;
      try {
        if (C === "-")
          S = t.stdin;
        else {
          const j = t.fs.resolvePath(C, t.cwd);
          S = await t.fs.readFile(j);
        }
      } catch {
        g.push(`grep: ${C}: No such file or directory`);
        return;
      }
      const P = S.split(`
`);
      P.length > 0 && P[P.length - 1] === "" && P.pop();
      let I = 0;
      for (let j = 0; j < P.length; j++)
        if (f.test(P[j]) !== a && (x = !0, I++, !i && !c)) {
          const T = m ? `${$}:` : "", M = l ? `${j + 1}:` : "";
          g.push(`${T}${M}${P[j]}`);
        }
      i && g.push(m ? `${$}:${I}` : String(I)), c && I > 0 && g.push($);
    }
    async function v(C) {
      const $ = t.fs.resolvePath(C, t.cwd);
      let S;
      try {
        S = await t.fs.readdir($);
      } catch {
        return;
      }
      for (const P of S) {
        const I = $ + "/" + P.name;
        P.type === "dir" ? await v(I) : await w(I, I);
      }
    }
    for (const C of h)
      if (C === "-")
        await w("-", "(standard input)");
      else if (u) {
        const $ = t.fs.resolvePath(C, t.cwd);
        let S;
        try {
          S = await t.fs.stat($);
        } catch {
          continue;
        }
        S.type === "dir" ? await v($) : await w(C, C);
      } else
        await w(C, C);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, ee = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), o = parseInt(e.n ?? "10", 10);
    try {
      const { content: r } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, se = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["n", "s", "C"]), r = o.C, a = e.n ? parseInt(e.n) : void 0, i = e.s ? parseInt(e.s) : 0;
    try {
      const { content: c } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let l = c.substring(i, a ? i + a : void 0);
      const u = [];
      if (r) {
        for (let p = 0; p < l.length; p += 16) {
          const f = l.substring(p, p + 16), h = (i + p).toString(16).padStart(8, "0"), m = q(f.substring(0, 8)), g = q(f.substring(8, 16)), x = ne(f);
          u.push(`${h}  ${m}  ${g}  |${x}|`);
        }
        const d = (i + l.length).toString(16).padStart(8, "0");
        u.push(d);
      } else {
        for (let p = 0; p < l.length; p += 16) {
          const f = l.substring(p, p + 16), h = (i + p).toString(16).padStart(7, "0"), m = [];
          for (let g = 0; g < f.length; g += 2) {
            const x = f.charCodeAt(g), w = g + 1 < f.length ? f.charCodeAt(g + 1) : 0, v = (x << 8 | w).toString(16).padStart(4, "0");
            m.push(v);
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
function q(n) {
  const t = [];
  for (let e = 0; e < 8; e++)
    e < n.length ? t.push(n.charCodeAt(e).toString(16).padStart(2, "0")) : t.push("  ");
  return t.join(" ");
}
function ne(n) {
  let t = "";
  for (let e = 0; e < 16; e++)
    if (e < n.length) {
      const s = n.charCodeAt(e);
      t += s >= 32 && s < 127 ? n[e] : ".";
    } else
      t += " ";
  return t;
}
const re = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, oe = {
  name: "id",
  description: "Print user identity",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), o = e[0] || t.env.USER || "user", r = s.u || s.user, a = s.g || s.group, i = s.G || s.groups, c = s.n || s.name;
    s.r || s.real;
    const l = 1e3, u = 1e3, d = [1e3], p = o, f = "users", h = [];
    if (r)
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
}, ie = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    e.m || e.mode;
    const r = e.t || e["target-directory"], a = o.d || o.directory, i = o.v || o.verbose;
    if (s.length === 0)
      return { stdout: "", stderr: `install: missing operand
`, exitCode: 1 };
    const c = [];
    try {
      if (a)
        for (const l of s) {
          const u = t.fs.resolvePath(l, t.cwd);
          await t.fs.mkdir(u, { recursive: !0 }), i && c.push(`install: creating directory '${l}'`);
        }
      else if (r) {
        const l = t.fs.resolvePath(r, t.cwd);
        for (const u of s) {
          const d = t.fs.resolvePath(u, t.cwd), p = u.split("/").pop() || u, f = l + "/" + p, h = await t.fs.readFile(d);
          await t.fs.writeFile(f, h), i && c.push(`'${u}' -> '${r}/${p}'`);
        }
      } else {
        if (s.length < 2)
          return { stdout: "", stderr: `install: missing destination
`, exitCode: 1 };
        const l = s[s.length - 1], u = s.slice(0, -1), d = t.fs.resolvePath(l, t.cwd);
        let p = !1;
        try {
          p = (await t.fs.stat(d)).type === "dir";
        } catch {
          p = u.length > 1;
        }
        if (p && u.length > 1)
          for (const f of u) {
            const h = t.fs.resolvePath(f, t.cwd), m = f.split("/").pop() || f, g = d + "/" + m, x = await t.fs.readFile(h);
            await t.fs.writeFile(g, x), i && c.push(`'${f}' -> '${l}/${m}'`);
          }
        else {
          const f = t.fs.resolvePath(u[0], t.cwd), h = await t.fs.readFile(f);
          await t.fs.writeFile(d, h), i && c.push(`'${u[0]}' -> '${l}'`);
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
}, ae = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const r = e[1] ? parseInt(e[1]) - 1 : 0, a = e[2] ? parseInt(e[2]) - 1 : 0, i = e.t || /\s+/, c = e.o, l = o.i;
    try {
      const u = t.fs.resolvePath(s[0], t.cwd), d = t.fs.resolvePath(s[1], t.cwd), p = await t.fs.readFile(u), f = await t.fs.readFile(d), h = p.split(`
`).filter((C) => C.trim() !== ""), m = f.split(`
`).filter((C) => C.trim() !== ""), g = (C) => C.map(($) => $.split(i)), x = g(h), w = g(m), v = /* @__PURE__ */ new Map();
      for (const C of w) {
        const $ = (C[a] || "").trim(), S = l ? $.toLowerCase() : $;
        v.has(S) || v.set(S, []), v.get(S).push(C);
      }
      const b = [];
      for (const C of x) {
        const $ = (C[r] || "").trim(), S = l ? $.toLowerCase() : $, P = v.get(S) || [];
        for (const I of P) {
          let j;
          if (c)
            j = c.split(",").map((T) => {
              const [M, E] = T.split(".").map((k) => parseInt(k));
              return (M === 1 ? C : I)[E - 1] || "";
            }).join(" ");
          else {
            const R = C[r] || "", T = C.filter((E, N) => N !== r), M = I.filter((E, N) => N !== a);
            j = [R, ...T, ...M].join(" ");
          }
          b.push(j);
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
}, ce = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: o } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), r = o.split(`
`), a = e.N || e.n;
      let i = "";
      return a ? i = r.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : i = o, i && !i.endsWith(`
`) && (i += `
`), { stdout: i, stderr: "", exitCode: 0 };
    } catch (o) {
      return {
        stdout: "",
        stderr: `less: ${o instanceof Error ? o.message : o}
`,
        exitCode: 1
      };
    }
  }
}, le = {
  name: "ln",
  description: "Make links between files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.s, r = e.f, a = e.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const i = t.fs.resolvePath(s[0], t.cwd), c = t.fs.resolvePath(s[1], t.cwd), l = [];
    try {
      if (await t.fs.exists(c))
        if (r)
          try {
            await t.fs.unlink(c);
          } catch {
          }
        else
          return {
            stdout: "",
            stderr: `ln: ${c}: File exists
`,
            exitCode: 1
          };
      if (o && t.fs.symlink)
        await t.fs.symlink(i, c), a && l.push(`'${c}' -> '${i}'`);
      else {
        const u = await t.fs.readFile(i);
        await t.fs.writeFile(c, u), a && l.push(`'${c}' => '${i}'`);
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
}, de = {
  name: "ls",
  description: "List directory contents",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = s.length > 0 ? s : ["."], r = e.a, a = e.l, i = e.h, c = [];
    for (const l of o) {
      const u = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(u);
      if (d.type === "file") {
        c.push(a ? z(u.split("/").pop(), d, i) : u.split("/").pop());
        continue;
      }
      o.length > 1 && c.push(`${l}:`);
      const p = await t.fs.readdir(u), f = r ? p : p.filter((h) => !h.name.startsWith("."));
      if (f.sort((h, m) => h.name.localeCompare(m.name)), a) {
        c.push(`total ${f.length}`);
        for (const h of f)
          c.push(z(h.name, h, i));
      } else
        c.push(f.map((h) => h.type === "dir" ? h.name + "/" : h.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function z(n, t, e) {
  const s = t.type === "dir" ? "d" : "-", o = t.mode ?? (t.type === "dir" ? 493 : 420), r = ue(o), a = e ? pe(t.size) : String(t.size).padStart(8), i = new Date(t.mtime), c = fe(i);
  return `${s}${r}  1 user user ${a} ${c} ${n}`;
}
function ue(n) {
  let e = "";
  for (let s = 2; s >= 0; s--) {
    const o = n >> s * 3 & 7;
    for (let r = 2; r >= 0; r--)
      e += o & 1 << r ? "rwx"[2 - r] : "-";
  }
  return e;
}
function fe(n) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), o = String(n.getHours()).padStart(2, "0"), r = String(n.getMinutes()).padStart(2, "0");
  return `${e} ${s} ${o}:${r}`;
}
function pe(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const he = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["f", "file", "C", "j"]), r = e.f || e.file || "Makefile", a = e.C;
    e.j;
    const i = o.n || o["dry-run"], c = o.p || o.print, l = s.length > 0 ? s : ["all"];
    try {
      const u = a ? t.fs.resolvePath(a, t.cwd) : t.cwd, d = t.fs.resolvePath(r, u);
      let p;
      try {
        p = await t.fs.readFile(d);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${r}: No such file or directory
`,
          exitCode: 2
        };
      }
      const f = me(p), h = [];
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
            for (const v of w.commands)
              c || i ? h.push(v) : h.push(`# ${v}`);
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
function me(n) {
  const t = /* @__PURE__ */ new Map(), e = n.split(`
`);
  let s = null;
  for (let o = 0; o < e.length; o++) {
    const r = e[o];
    if (!(r.trim().startsWith("#") || r.trim() === ""))
      if (r.includes(":") && !r.startsWith("	")) {
        const a = r.indexOf(":"), i = r.substring(0, a).trim(), c = r.substring(a + 1).trim(), l = c ? c.split(/\s+/) : [];
        s = { target: i, prerequisites: l, commands: [] }, t.set(i, s);
      } else r.startsWith("	") && s && s.commands.push(r.substring(1));
  }
  return t;
}
const ge = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.c || e.check, r = e.b || e.binary;
    if (o)
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
          l = t.stdin;
        else {
          const p = t.fs.resolvePath(c, t.cwd);
          l = await t.fs.readFile(p);
        }
        const u = await xe(l), d = r ? "*" : " ";
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
async function xe(n) {
  let t = 0;
  for (let s = 0; s < n.length; s++) {
    const o = n.charCodeAt(s);
    t = (t << 5) - t + o, t = t & t;
  }
  return Math.abs(t).toString(16).padStart(32, "0");
}
const ye = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const r of s) {
        const a = t.fs.resolvePath(r, t.cwd);
        await t.fs.mkdir(a, { recursive: o });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `mkdir: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, we = {
  name: "mv",
  description: "Move or rename files",
  async exec(n, t) {
    const { positional: e } = y(n);
    if (e.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const s = t.fs.resolvePath(e[e.length - 1], t.cwd), o = e.slice(0, -1);
    let r = !1;
    try {
      r = (await t.fs.stat(s)).type === "dir";
    } catch {
    }
    if (o.length > 1 && !r)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const a of o) {
        const i = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), l = r ? s + "/" + c : s;
        await t.fs.rename(i, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, Ce = {
  name: "nl",
  description: "Number lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["b", "s", "w", "n", "v"]), r = e.b || "t", a = e.s || "	", i = parseInt(e.w || "6", 10), c = e.n || "rn", l = parseInt(e.v || "1", 10);
    o.p;
    const u = o.ba;
    try {
      const { content: d } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), p = d.split(`
`), f = [];
      let h = l;
      for (const m of p) {
        let g = !1;
        const x = u ? "a" : r;
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
          const w = ve(h, i, c);
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
function ve(n, t, e) {
  const s = String(n);
  switch (e) {
    case "ln":
      return s.padEnd(t, " ");
    case "rn":
      return s.padStart(t, " ");
    case "rz":
      return s.padStart(t, "0");
    default:
      return s.padStart(t, " ");
  }
}
const $e = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["t", "N", "j", "w", "A"]), r = e.t || "o2", a = e.N ? parseInt(e.N) : void 0, i = e.j ? parseInt(e.j) : 0, c = e.w ? parseInt(e.w) : 16, l = e.A || "o", u = o.b || o.c || o.d || o.o || o.s || o.x;
    try {
      const { content: d } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let p = d.substring(i, a ? i + a : void 0);
      const f = [];
      let h = "o", m = 2;
      u ? o.b ? (h = "o", m = 1) : o.c ? (h = "c", m = 1) : o.d || o.s ? (h = "d", m = 2) : o.o ? (h = "o", m = 2) : o.x && (h = "x", m = 2) : r && (h = r[0] || "o", m = parseInt(r.substring(1)) || 2);
      let g = i;
      for (let x = 0; x < p.length; x += c) {
        const w = p.substring(x, x + c), v = G(g, l), b = be(w, h, m);
        f.push(`${v} ${b}`), g += w.length;
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
function G(n, t) {
  switch (t) {
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
function be(n, t, e) {
  const s = [];
  for (let o = 0; o < n.length; o += e) {
    const r = n.substring(o, o + e);
    let a = 0;
    for (let i = 0; i < r.length; i++)
      a = a << 8 | r.charCodeAt(i);
    switch (t) {
      case "o":
        s.push(a.toString(8).padStart(e * 3, "0"));
        break;
      case "x":
        s.push(a.toString(16).padStart(e * 2, "0"));
        break;
      case "d":
        s.push(a.toString(10).padStart(e * 3, " "));
        break;
      case "c":
        s.push(Se(r.charCodeAt(0)));
        break;
      case "a":
        s.push(Pe(r.charCodeAt(0)));
        break;
      default:
        s.push(a.toString(8).padStart(e * 3, "0"));
    }
  }
  return s.join(" ");
}
function Se(n) {
  return n >= 32 && n < 127 ? `  ${String.fromCharCode(n)}` : n === 0 ? " \\0" : n === 7 ? " \\a" : n === 8 ? " \\b" : n === 9 ? " \\t" : n === 10 ? " \\n" : n === 11 ? " \\v" : n === 12 ? " \\f" : n === 13 ? " \\r" : n.toString(8).padStart(3, "0");
}
function Pe(n) {
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
const Ie = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["d", "delimiters"]), r = e.d || e.delimiters || "	", a = o.s;
    s.length === 0 && s.push("-");
    try {
      const i = [];
      for (const l of s) {
        let u;
        if (l === "-")
          u = t.stdin;
        else {
          const d = t.fs.resolvePath(l, t.cwd);
          u = await t.fs.readFile(d);
        }
        i.push(u.split(`
`).filter((d, p, f) => p < f.length - 1 || d !== ""));
      }
      const c = [];
      if (a)
        for (const l of i) {
          const u = r.split(""), d = [];
          for (let p = 0; p < l.length; p++)
            d.push(l[p]), p < l.length - 1 && d.push(u[p % u.length]);
          c.push(d.join(""));
        }
      else {
        const l = Math.max(...i.map((d) => d.length)), u = r.split("");
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
}, Ee = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["p", "i", "input", "o", "output"]), r = e.p ? parseInt(e.p) : 0, a = e.i || e.input, i = e.o || e.output, c = o.R || o.reverse, l = o["dry-run"];
    try {
      let u;
      if (a) {
        const f = t.fs.resolvePath(a, t.cwd);
        u = await t.fs.readFile(f);
      } else if (s.length > 0) {
        const f = t.fs.resolvePath(s[0], t.cwd);
        u = await t.fs.readFile(f);
      } else
        u = t.stdin;
      const d = je(u), p = [];
      for (const f of d) {
        const h = H(f.newFile, r), m = H(f.oldFile, r);
        if (p.push(`patching file ${h}`), !l) {
          let g;
          try {
            const w = t.fs.resolvePath(h, t.cwd);
            g = await t.fs.readFile(w);
          } catch {
            g = "";
          }
          const x = Ne(g, f.hunks, c);
          if (i) {
            const w = t.fs.resolvePath(i, t.cwd);
            await t.fs.writeFile(w, x);
          } else {
            const w = t.fs.resolvePath(h, t.cwd);
            await t.fs.writeFile(w, x);
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
function je(n) {
  const t = [], e = n.split(`
`);
  let s = null, o = null;
  for (const r of e)
    if (r.startsWith("--- "))
      s = { oldFile: r.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (r.startsWith("+++ ") && s)
      s.newFile = r.substring(4).split("	")[0], t.push(s);
    else if (r.startsWith("@@ ") && s) {
      const a = r.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      a && (o = {
        oldStart: parseInt(a[1]),
        oldLines: parseInt(a[2]),
        newStart: parseInt(a[3]),
        newLines: parseInt(a[4]),
        lines: []
      }, s.hunks.push(o));
    } else o && (r.startsWith(" ") || r.startsWith("+") || r.startsWith("-")) && o.lines.push(r);
  return t;
}
function H(n, t) {
  return n.split("/").slice(t).join("/");
}
function Ne(n, t, e) {
  const s = n.split(`
`);
  for (const o of t) {
    const r = o.oldStart - 1, a = o.oldLines, i = [];
    for (const c of o.lines) {
      const l = c[0], u = c.substring(1);
      if (e) {
        if (l === "+")
          continue;
        i.push(u);
      } else
        (l === "+" || l === " ") && i.push(u);
    }
    s.splice(r, a, ...i);
  }
  return s.join(`
`);
}
const Fe = {
  name: "pkg-config",
  description: "Return metainformation about installed libraries",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n, [
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
    if (e.version)
      return {
        stdout: `0.29.2
`,
        stderr: "",
        exitCode: 0
      };
    if (e["list-all"])
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
    if (e.exists)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    if (e.modversion)
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
    if (e.cflags) {
      const a = {
        zlib: "-I/usr/include",
        openssl: "-I/usr/include/openssl",
        libcurl: "-I/usr/include/curl",
        sqlite3: "-I/usr/include",
        "glib-2.0": "-I/usr/include/glib-2.0 -I/usr/lib/glib-2.0/include"
      }[o] || "";
      return {
        stdout: a ? a + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    if (e.libs) {
      const a = {
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
        stdout: a ? a + `
` : `
`,
        stderr: "",
        exitCode: 0
      };
    }
    return e["print-provides"] ? {
      stdout: `${o} = 1.0.0
`,
      stderr: "",
      exitCode: 0
    } : e["print-requires"] ? {
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
}, Te = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), o = s[0] || s.null;
    if (e.length === 0) {
      const r = [];
      for (const [i, c] of Object.entries(t.env))
        r.push(`${i}=${c}`);
      const a = o ? "\0" : `
`;
      return {
        stdout: r.join(a) + (r.length > 0 ? a : ""),
        stderr: "",
        exitCode: 0
      };
    } else {
      const r = [];
      for (const i of e)
        if (i in t.env)
          r.push(t.env[i]);
        else
          return {
            stdout: "",
            stderr: "",
            exitCode: 1
          };
      const a = o ? "\0" : `
`;
      return {
        stdout: r.join(a) + (r.length > 0 ? a : ""),
        stderr: "",
        exitCode: 0
      };
    }
  }
}, Me = {
  name: "printf",
  description: "Format and print data",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = n[0], e = n.slice(1);
    let s = 0, o = "", r = 0;
    for (; r < t.length; )
      if (t[r] === "\\") {
        switch (r++, t[r]) {
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
            o += "\\" + (t[r] ?? "");
            break;
        }
        r++;
      } else if (t[r] === "%")
        if (r++, t[r] === "%")
          o += "%", r++;
        else {
          let a = "";
          for (; r < t.length && !/[sdf]/.test(t[r]); )
            a += t[r], r++;
          const i = t[r] ?? "s";
          r++;
          const c = e[s++] ?? "";
          switch (i) {
            case "s":
              o += c;
              break;
            case "d":
              o += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              o += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        o += t[r], r++;
    return { stdout: o, stderr: "", exitCode: 0 };
  }
}, Ae = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, ke = {
  name: "read",
  description: "Read a line from stdin into variables",
  async exec(n, t) {
    var l;
    const { positional: e, flags: s, values: o } = y(n, ["r", "p", "n", "t", "d", "a", "s"]);
    let r = t.stdin || "";
    o.p;
    const a = o.d || `
`, i = o.n ? parseInt(o.n) : void 0;
    let c;
    if (i !== void 0)
      c = r.slice(0, i);
    else {
      const u = r.indexOf(a);
      u >= 0 ? c = r.slice(0, u) : c = r;
    }
    if (s.r || (c = c.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\")), e.length === 0)
      t.env && (t.env.REPLY = c);
    else if (e.length === 1)
      t.env && (t.env[e[0]] = c);
    else {
      const u = ((l = t.env) == null ? void 0 : l.IFS) || ` 	
`, d = new RegExp(`[${u.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&")}]+`), p = c.split(d).filter((f) => f);
      for (let f = 0; f < e.length; f++) {
        const h = e[f];
        f < e.length - 1 ? t.env && (t.env[h] = p[f] || "") : t.env && (t.env[h] = p.slice(f).join(" "));
      }
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, Re = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const r = t.fs.resolvePath(s[0], t.cwd);
    return o ? { stdout: r + `
`, stderr: "", exitCode: 0 } : { stdout: r + `
`, stderr: "", exitCode: 0 };
  }
}, Oe = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const o = e.q || e.quiet, r = !e.s;
    e.s;
    const a = [], i = [];
    for (const u of s)
      try {
        let d = t.fs.resolvePath(u, t.cwd);
        if (r) {
          const p = d.split("/").filter((h) => h !== "" && h !== "."), f = [];
          for (const h of p)
            h === ".." ? f.length > 0 && f.pop() : f.push(h);
          d = "/" + f.join("/");
        }
        await t.fs.exists(d) ? a.push(d) : o || i.push(`realpath: ${u}: No such file or directory`);
      } catch (d) {
        o || i.push(`realpath: ${u}: ${d instanceof Error ? d.message : d}`);
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
}, De = {
  name: "return",
  description: "Return from a shell function",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? parseInt(e[0]) : 0;
    return {
      stdout: "",
      stderr: "",
      exitCode: isNaN(s) ? 2 : s
    };
  }
}, Le = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.r || e.R, r = e.f;
    if (s.length === 0 && !r)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(i) {
      const c = await t.fs.readdir(i);
      for (const l of c) {
        const u = i + "/" + l.name;
        l.type === "dir" ? await a(u) : await t.fs.unlink(u);
      }
      await t.fs.rmdir(i);
    }
    try {
      for (const i of s) {
        const c = t.fs.resolvePath(i, t.cwd);
        let l;
        try {
          l = await t.fs.stat(c);
        } catch {
          if (r) continue;
          return { stdout: "", stderr: `rm: cannot remove '${i}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `rm: cannot remove '${i}': Is a directory
`, exitCode: 1 };
          await a(c);
        } else
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return r ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, We = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.i, r = s.shift();
    if (!r)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = r.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${r}
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
      const { content: f, files: h } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), m = f.split(`
`).map((g) => g.replace(p, c)).join(`
`);
      if (o && h.length > 0) {
        for (const g of h) {
          const x = t.fs.resolvePath(g, t.cwd), v = (await t.fs.readFile(x)).split(`
`).map((b) => b.replace(p, c)).join(`
`);
          await t.fs.writeFile(x, v);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (f) {
      return { stdout: "", stderr: `sed: ${f instanceof Error ? f.message : f}
`, exitCode: 1 };
    }
  }
}, Ue = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["separator", "s", "format", "f"]);
    if (o.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let r = 1, a = 1, i;
    if (o.length === 1 ? i = parseFloat(o[0]) : o.length === 2 ? (r = parseFloat(o[0]), i = parseFloat(o[1])) : o.length >= 3 ? (r = parseFloat(o[0]), a = parseFloat(o[1]), i = parseFloat(o[2])) : i = 1, isNaN(r) || isNaN(a) || isNaN(i))
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
`, l = s.f || s.format, u = e.w, d = [];
    if (a > 0)
      for (let h = r; h <= i; h += a)
        d.push(String(h));
    else
      for (let h = r; h >= i; h += a)
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
}, qe = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["e", "u", "x", "v", "n", "o"]);
    if (n.length === 0) {
      const r = Object.entries(t.env || {}).map(([a, i]) => `${a}=${i}`).join(`
`);
      return {
        stdout: r ? r + `
` : "",
        stderr: "",
        exitCode: 0
      };
    }
    if (e.o || s.o) {
      const r = s.o || o[0], a = [
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
      return r ? a.includes(r) ? {
        stdout: "",
        stderr: "",
        exitCode: 0
      } : {
        stdout: "",
        stderr: `set: ${r}: invalid option name
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
    return e.e, e.u, e.x, e.v, e.n, {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, ze = {
  name: "sha256sum",
  description: "Compute SHA256 message digest",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.c || e.check, r = e.b || e.binary;
    if (o)
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
          l = t.stdin;
        else {
          const p = t.fs.resolvePath(c, t.cwd);
          l = await t.fs.readFile(p);
        }
        const u = await Ge(l), d = r ? "*" : " ";
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
async function Ge(n) {
  const t = globalThis;
  if (typeof t.crypto < "u" && t.crypto.subtle) {
    const o = new t.TextEncoder().encode(n), r = await t.crypto.subtle.digest("SHA-256", o);
    return Array.from(new t.Uint8Array(r)).map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  let e = 0;
  for (let s = 0; s < n.length; s++) {
    const o = n.charCodeAt(s);
    e = (e << 5) - e + o, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(64, "0");
}
const He = {
  name: "shift",
  description: "Shift positional parameters",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? parseInt(e[0]) : 1;
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
}, Be = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(n, t) {
    const { positional: e } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `sleep: missing operand
`, exitCode: 1 };
    const s = e[0];
    let o = 0;
    const r = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
    if (!r)
      return {
        stdout: "",
        stderr: `sleep: invalid time interval '${s}'
`,
        exitCode: 1
      };
    const a = parseFloat(r[1]);
    switch (r[2] || "s") {
      case "s":
        o = a;
        break;
      case "m":
        o = a * 60;
        break;
      case "h":
        o = a * 3600;
        break;
      case "d":
        o = a * 86400;
        break;
    }
    return await new Promise((c) => globalThis.setTimeout(c, o * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, Je = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: o } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let r = o.split(`
`).filter(Boolean);
      return e.n ? r.sort((a, i) => parseFloat(a) - parseFloat(i)) : r.sort(), e.u && (r = [...new Set(r)]), e.r && r.reverse(), { stdout: r.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `sort: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, K = {
  name: "source",
  description: "Execute commands from a file in the current shell",
  async exec(n, t) {
    const { positional: e } = y(n);
    if (e.length === 0)
      return {
        stdout: "",
        stderr: `source: filename argument required
`,
        exitCode: 1
      };
    const s = e[0];
    try {
      const o = t.fs.resolvePath(s, t.cwd), r = await t.fs.readFile(o);
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
}, Ye = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(n, t) {
    return K.exec(n, t);
  }
}, _e = {
  name: "stat",
  description: "Display file status",
  async exec(n, t) {
    const { positional: e, flags: s, values: o } = y(n, ["c", "format"]);
    if (e.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const r = o.c || o.format, a = s.t;
    s.f;
    const i = [];
    try {
      for (const c of e) {
        const l = t.fs.resolvePath(c, t.cwd);
        try {
          const u = await t.fs.stat(l);
          if (r) {
            const d = Ke(c, u, r);
            i.push(d);
          } else if (a)
            i.push(`${c} ${u.size} 0 ${u.mode} 0 0 0 0 0 0 ${u.mtime}`);
          else {
            const d = u.type === "dir" ? "directory" : "regular file", p = V(u.mode), f = new Date(u.mtime).toISOString();
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
function V(n) {
  const t = [
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
  return `0${n.toString(8)}/${t}`;
}
function Ke(n, t, e) {
  return e.replace(/%n/g, n).replace(/%N/g, `'${n}'`).replace(/%s/g, String(t.size)).replace(/%b/g, "0").replace(/%f/g, t.mode.toString(16)).replace(/%a/g, t.mode.toString(8)).replace(/%A/g, V(t.mode).split("/")[1]).replace(/%F/g, t.type === "dir" ? "directory" : "regular file").replace(/%u/g, "0").replace(/%g/g, "0").replace(/%U/g, "root").replace(/%G/g, "root").replace(/%i/g, "0").replace(/%h/g, "1").replace(/%W/g, String(Math.floor(t.mtime / 1e3))).replace(/%X/g, String(Math.floor(t.mtime / 1e3))).replace(/%Y/g, String(Math.floor(t.mtime / 1e3))).replace(/%y/g, new Date(t.mtime).toISOString()).replace(/%%/g, "%");
}
const Ve = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["n", "bytes"]), r = parseInt(e.n || e.bytes || "4", 10), a = o.f;
    o.a;
    try {
      const i = s.length > 0 ? s : ["-"], c = [];
      for (const l of i) {
        let u, d = l;
        if (l === "-")
          u = t.stdin, d = "(standard input)";
        else {
          const f = t.fs.resolvePath(l, t.cwd);
          u = await t.fs.readFile(f);
        }
        const p = Xe(u, r);
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
function Xe(n, t) {
  const e = [], s = /[ -~]/;
  let o = "";
  for (let r = 0; r < n.length; r++) {
    const a = n[r];
    s.test(a) ? o += a : (o.length >= t && e.push(o), o = "");
  }
  return o.length >= t && e.push(o), e;
}
const Ze = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), o = parseInt(e.n ?? "10", 10);
    try {
      const { content: r } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, Qe = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["f", "C"]), r = e.c || e.create, a = e.x || e.extract, i = e.t || e.list, c = e.v || e.verbose, l = s.f, u = s.C;
    let d = t.cwd;
    u && (d = t.fs.resolvePath(u, t.cwd));
    const p = [r, a, i].filter(Boolean).length;
    if (p === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (p > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (r) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const f = o;
        if (f.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const h = [];
        async function m(v, b) {
          const C = t.fs.resolvePath(v, d);
          if ((await t.fs.stat(C)).type === "dir") {
            h.push({ path: b + "/", content: "", isDir: !0 });
            const S = await t.fs.readdir(C);
            for (const P of S)
              await m(C + "/" + P.name, b + "/" + P.name);
          } else {
            const S = await t.fs.readFile(C);
            h.push({ path: b, content: S, isDir: !1 });
          }
        }
        for (const v of f)
          await m(v, v);
        const g = ["FLUFFY-TAR-V1"];
        for (const v of h)
          c && (t.stderr || console.error(v.path)), g.push(`FILE:${v.path}`), g.push(`SIZE:${v.content.length}`), g.push(`TYPE:${v.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(v.content), g.push("DATA-END");
        const x = g.join(`
`), w = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(w, x), {
          stdout: c ? h.map((v) => v.path).join(`
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
        const f = t.fs.resolvePath(l, t.cwd), m = (await t.fs.readFile(f)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let g = 1;
        const x = [];
        for (; g < m.length && m[g].startsWith("FILE:"); ) {
          const w = m[g].slice(5), v = parseInt(m[g + 1].slice(5), 10), b = m[g + 2].slice(5);
          g += 4;
          const C = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            C.push(m[g]), g++;
          const $ = C.join(`
`);
          g++;
          const S = t.fs.resolvePath(w, d);
          if (b === "dir")
            await t.fs.mkdir(S, { recursive: !0 });
          else {
            const P = S.lastIndexOf("/");
            if (P > 0) {
              const I = S.slice(0, P);
              try {
                await t.fs.mkdir(I, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(S, $);
          }
          x.push(w), c && (t.stderr || console.error(w));
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
        const f = t.fs.resolvePath(l, t.cwd), m = (await t.fs.readFile(f)).split(`
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
}, ts = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.a, r = t.stdin;
    try {
      for (const a of s) {
        const i = t.fs.resolvePath(a, t.cwd);
        if (o) {
          let c = "";
          try {
            c = await t.fs.readFile(i);
          } catch {
          }
          await t.fs.writeFile(i, c + r);
        } else
          await t.fs.writeFile(i, r);
      }
      return { stdout: r, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: r, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, es = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(n, t) {
    const e = n[n.length - 1] === "]" ? n.slice(0, -1) : [...n];
    try {
      return { stdout: "", stderr: "", exitCode: await O(e, t) ? 0 : 1 };
    } catch (s) {
      return { stdout: "", stderr: `test: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
};
async function O(n, t) {
  var o, r;
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
          const c = t.fs.resolvePath(i, t.cwd), l = await t.fs.stat(c);
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
          const c = t.fs.resolvePath(i, t.cwd);
          if (await t.fs.stat(c), a === "-s")
            try {
              const l = await ((r = (o = t.fs).readFile) == null ? void 0 : r.call(o, c));
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
    return !await O(n.slice(1), t);
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
  const e = n.indexOf("-a");
  if (e > 0)
    return await O(n.slice(0, e), t) && await O(n.slice(e + 1), t);
  const s = n.indexOf("-o");
  return s > 0 ? await O(n.slice(0, s), t) || await O(n.slice(s + 1), t) : !1;
}
const ss = {
  name: "time",
  description: "Time a command execution",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const o = s.v || s.verbose, r = s.p, a = e.join(" "), i = globalThis.performance, c = i ? i.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const d = ((i ? i.now() : Date.now()) - c) / 1e3, p = Math.floor(d / 60), f = d % 60;
    let h;
    return r ? h = `real ${d.toFixed(2)}
user 0.00
sys 0.00
` : o ? h = `        ${d.toFixed(3)} real         0.000 user         0.000 sys
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
}, ns = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(n, t) {
    const { positional: e, flags: s, values: o } = y(n, ["k", "kill-after", "s", "signal"]);
    if (e.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const r = e[0], a = e.slice(1);
    if (a.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let i = rs(r);
    if (i === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${r}'
`,
        exitCode: 1
      };
    o.k || o["kill-after"];
    const c = o.s || o.signal || "TERM", l = s["preserve-status"];
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
function rs(n) {
  const t = n.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!t) return null;
  const e = parseFloat(t[1]);
  switch (t[2] || "s") {
    case "s":
      return e;
    case "m":
      return e * 60;
    case "h":
      return e * 3600;
    case "d":
      return e * 86400;
    default:
      return null;
  }
}
const os = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    const o = s.c;
    try {
      for (const r of e) {
        const a = t.fs.resolvePath(r, t.cwd);
        let i = !1;
        try {
          await t.fs.stat(a), i = !0;
        } catch {
          i = !1;
        }
        if (i) {
          const c = await t.fs.readFile(a);
          await t.fs.writeFile(a, c);
        } else {
          if (o)
            continue;
          await t.fs.writeFile(a, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `touch: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, is = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.d, r = e.s, a = B(s[0] ?? ""), i = B(s[1] ?? ""), c = t.stdin;
    let l;
    if (o) {
      const u = new Set(a.split(""));
      l = c.split("").filter((d) => !u.has(d)).join("");
    } else if (a && i) {
      const u = /* @__PURE__ */ new Map();
      for (let d = 0; d < a.length; d++)
        u.set(a[d], i[Math.min(d, i.length - 1)]);
      l = c.split("").map((d) => u.get(d) ?? d).join("");
    } else
      l = c;
    if (r && i) {
      const u = new Set(i.split(""));
      let d = "", p = "";
      for (const f of l)
        u.has(f) && f === p || (d += f, p = f);
      l = d;
    }
    return { stdout: l, stderr: "", exitCode: 0 };
  }
};
function B(n) {
  let t = n;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let e = "", s = 0;
  for (; s < t.length; )
    if (s + 2 < t.length && t[s + 1] === "-") {
      const o = t.charCodeAt(s), r = t.charCodeAt(s + 2);
      for (let a = o; a <= r; a++)
        e += String.fromCharCode(a);
      s += 3;
    } else
      e += t[s], s++;
  return e;
}
const as = {
  name: "trap",
  description: "Trap signals and execute commands",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n, ["l", "p"]);
    return e.l ? {
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
    } : e.p ? s.length === 0 ? {
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
}, cs = {
  name: "kill",
  description: "Send signal to process",
  async exec(n, t) {
    const { flags: e, values: s, positional: o } = y(n, ["l", "L", "s"]);
    if (e.l || e.L) {
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
      return e.L ? {
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
}, ls = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, ds = {
  name: "type",
  description: "Display information about command type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `type: missing operand
`, exitCode: 1 };
    const o = s.a, r = s.t, a = s.p, i = [];
    let c = 0;
    for (const l of e) {
      const u = (t.env.PATH || "/bin:/usr/bin").split(":");
      let d = !1;
      for (const p of u) {
        const f = p + "/" + l;
        try {
          if (await t.fs.exists(f) && (d = !0, r ? i.push("file") : a ? i.push(f) : i.push(`${l} is ${f}`), !o))
            break;
        } catch {
        }
      }
      d || (!r && !a && i.push(`type: ${l}: not found`), c = 1);
    }
    return {
      stdout: i.join(`
`) + (i.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: c
    };
  }
}, us = {
  name: "unalias",
  description: "Remove alias definitions",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    return e.length === 0 && !s.a ? {
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
}, fs = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, t) {
    const { values: e, positional: s, flags: o } = y(n, ["t", "tabs"]), r = e.t || e.tabs || "8", a = parseInt(r, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${r}'
`,
        exitCode: 1
      };
    const i = o.a || o.all;
    try {
      const { content: c } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, ps = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, t) {
    const { flags: e, positional: s, values: o } = y(n, ["f", "s", "w"]), r = o.f ? parseInt(o.f) : 0, a = o.s ? parseInt(o.s) : 0, i = o.w ? parseInt(o.w) : void 0, c = e.i;
    try {
      const { content: l } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = l.split(`
`);
      u.length > 0 && u[u.length - 1] === "" && u.pop();
      const d = [];
      let p = "", f = "", h = 0;
      for (const m of u) {
        const g = hs(m, r, a, i, c);
        g === f ? h++ : (h > 0 && J(p, h, e, d), p = m, f = g, h = 1);
      }
      return h > 0 && J(p, h, e, d), { stdout: d.join(`
`) + (d.length > 0 ? `
` : ""), stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `uniq: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
};
function hs(n, t, e, s, o) {
  let r = n;
  return t > 0 && (r = n.split(/\s+/).slice(t).join(" ")), e > 0 && (r = r.substring(e)), s !== void 0 && (r = r.substring(0, s)), o && (r = r.toLowerCase()), r;
}
function J(n, t, e, s) {
  e.d && t < 2 || e.u && t > 1 || (e.c ? s.push(`${String(t).padStart(7)} ${n}`) : s.push(n));
}
const ms = {
  name: "uname",
  description: "Print system information",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.a, o = t.env.UNAME_SYSNAME ?? "FluffyOS", r = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", i = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${o} ${r} ${a} ${i} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: o + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(o), e.n && l.push(r), e.r && l.push(a), e.v && l.push(i), e.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, gs = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.p || e.pretty, o = e.s || e.since, r = 86400 + 3600 * 5 + 1380, a = Math.floor(r / 86400), i = Math.floor(r % 86400 / 3600), c = Math.floor(r % 3600 / 60), l = /* @__PURE__ */ new Date(), u = new Date(l.getTime() - r * 1e3), d = [];
    if (o)
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
}, xs = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.l, r = e.w, a = e.c, i = !o && !r && !a;
    try {
      const { content: c, files: l } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, p = c.length, f = [];
      return (i || o) && f.push(String(u).padStart(6)), (i || r) && f.push(String(d).padStart(6)), (i || a) && f.push(String(p).padStart(6)), l.length === 1 && f.push(" " + s[0]), { stdout: f.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, ys = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), o = e.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const r = s[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = a.split(":"), c = [];
    for (const l of i) {
      const u = `${l}/${r}`;
      try {
        if (await t.fs.exists(u) && (await t.fs.stat(u)).type === "file" && (c.push(u), !o))
          break;
      } catch {
        continue;
      }
    }
    return c.length === 0 ? {
      stdout: "",
      stderr: `which: no ${r} in (${a})
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
}, ws = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, Cs = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, t) {
    const { flags: e, positional: s, values: o } = y(n, ["n", "I", "i", "d", "delimiter"]), r = e.I || e.L || e.l, a = o.I || o.i, i = o.n ? parseInt(o.n) : void 0, c = o.d || o.delimiter || /\s+/, l = e.t || e.verbose, u = e.r, d = s.length > 0 ? s.join(" ") : "echo";
    let p;
    if (typeof c == "string" ? p = t.stdin.split(c).filter(Boolean) : p = t.stdin.trim().split(c).filter(Boolean), p.length === 0) {
      if (u)
        return { stdout: "", stderr: "", exitCode: 0 };
      p = [""];
    }
    const f = [], h = [];
    if (a) {
      const m = typeof a == "string" ? a : "{}";
      for (const g of p) {
        const x = d.replace(new RegExp(vs(m), "g"), g);
        h.push(x), l && f.push(`+ ${x}`);
      }
    } else if (i)
      for (let m = 0; m < p.length; m += i) {
        const g = p.slice(m, m + i), x = `${d} ${g.map(L).join(" ")}`;
        h.push(x), l && f.push(`+ ${x}`);
      }
    else if (r)
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
function vs(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const $s = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? e.join(" ") : "y", o = [], r = 1e3;
    for (let a = 0; a < r; a++)
      o.push(s);
    return {
      stdout: o.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, bs = {
  ".": Ye,
  alias: X,
  awk: Z,
  base64: Q,
  basename: tt,
  break: et,
  case: st,
  cc: ot,
  cat: rt,
  chmod: it,
  chown: at,
  clear: ct,
  column: lt,
  comm: dt,
  continue: ut,
  cp: ft,
  curl: pt,
  cut: ht,
  date: gt,
  declare: wt,
  df: $t,
  diff: bt,
  dirname: Pt,
  do: jt,
  done: Nt,
  du: Ft,
  echo: Tt,
  elif: kt,
  else: Rt,
  env: Dt,
  esac: nt,
  eval: Lt,
  exit: Wt,
  expand: Ut,
  expr: qt,
  export: zt,
  false: Gt,
  fi: Ot,
  file: Yt,
  find: Kt,
  fmt: Vt,
  fold: Xt,
  for: Ht,
  free: Zt,
  function: Jt,
  gcc: Y,
  getopts: Qt,
  grep: te,
  head: ee,
  hexdump: se,
  hostname: re,
  id: oe,
  if: Mt,
  in: Bt,
  install: ie,
  join: ae,
  kill: cs,
  less: ce,
  ln: le,
  local: yt,
  ls: de,
  make: he,
  md5sum: ge,
  mkdir: ye,
  mv: we,
  nl: Ce,
  od: $e,
  paste: Ie,
  patch: Ee,
  "pkg-config": Fe,
  printenv: Te,
  printf: Me,
  pwd: Ae,
  read: ke,
  readlink: Re,
  readonly: Ct,
  realpath: Oe,
  return: De,
  rm: Le,
  sed: We,
  seq: Ue,
  set: qe,
  sha256sum: ze,
  shift: He,
  sleep: Be,
  sort: Je,
  source: K,
  stat: _e,
  strings: Ve,
  tail: Ze,
  tar: Qe,
  tee: ts,
  test: es,
  then: At,
  time: ss,
  timeout: ns,
  touch: os,
  tr: is,
  trap: as,
  true: ls,
  type: ds,
  unalias: us,
  unexpand: fs,
  uniq: ps,
  unset: vt,
  uname: ms,
  until: Et,
  uptime: gs,
  wc: xs,
  which: ys,
  while: It,
  whoami: ws,
  xargs: Cs,
  yes: $s
}, Ss = Object.values(bs);
export {
  X as alias,
  bs as allCommands,
  Z as awk,
  Q as base64,
  tt as basename,
  et as break,
  st as case,
  rt as cat,
  ot as cc,
  it as chmod,
  at as chown,
  ct as clear,
  lt as column,
  dt as comm,
  Ss as commandList,
  ut as continue,
  ft as cp,
  pt as curl,
  ht as cut,
  gt as date,
  wt as declare,
  $t as df,
  bt as diff,
  Pt as dirname,
  jt as do,
  Nt as done,
  Ye as dot,
  Ft as du,
  Tt as echo,
  kt as elif,
  Rt as else,
  Dt as env,
  nt as esac,
  Lt as eval,
  Wt as exit,
  Ut as expand,
  zt as exportCmd,
  qt as expr,
  Gt as false,
  Ot as fi,
  Yt as file,
  Kt as find,
  Vt as fmt,
  Xt as fold,
  Ht as for,
  Zt as free,
  Jt as function,
  Y as gcc,
  Qt as getopts,
  te as grep,
  ee as head,
  se as hexdump,
  re as hostname,
  oe as id,
  Mt as if,
  Bt as in,
  ie as install,
  ae as join,
  cs as kill,
  ce as less,
  le as ln,
  yt as local,
  de as ls,
  he as make,
  ge as md5sum,
  ye as mkdir,
  we as mv,
  Ce as nl,
  $e as od,
  Ie as paste,
  Ee as patch,
  Fe as pkgConfig,
  Te as printenv,
  Me as printf,
  Ae as pwd,
  ke as read,
  Re as readlink,
  Ct as readonly,
  Oe as realpath,
  De as return,
  Le as rm,
  We as sed,
  Ue as seq,
  qe as set,
  ze as sha256sum,
  He as shift,
  Be as sleep,
  Je as sort,
  K as source,
  _e as stat,
  Ve as strings,
  Ze as tail,
  Qe as tar,
  ts as tee,
  es as test,
  At as then,
  ss as time,
  ns as timeout,
  os as touch,
  is as tr,
  as as trap,
  ls as true,
  ds as type,
  us as unalias,
  ms as uname,
  fs as unexpand,
  ps as uniq,
  vt as unset,
  Et as until,
  gs as uptime,
  xs as wc,
  ys as which,
  It as while,
  ws as whoami,
  Cs as xargs,
  $s as yes
};
