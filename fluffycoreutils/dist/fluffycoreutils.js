const N = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(r) {
    if (r.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let t = r[0].replace(/\/+$/, "").split("/").pop() || "/";
    return r.length > 1 && t.endsWith(r[1]) && (t = t.slice(0, -r[1].length)), { stdout: t + `
`, stderr: "", exitCode: 0 };
  }
};
function x(r, t = []) {
  const s = {}, n = {}, o = [], e = new Set(t);
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    if (a === "--") {
      o.push(...r.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const d = a.slice(2);
      e.has(d) && i + 1 < r.length ? n[d] = r[++i] : s[d] = !0;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const d = a.slice(1);
      if (e.has(d) && i + 1 < r.length)
        n[d] = r[++i];
      else
        for (let c = 0; c < d.length; c++) {
          const f = d[c];
          if (e.has(f)) {
            const l = d.slice(c + 1);
            l ? n[f] = l : i + 1 < r.length && (n[f] = r[++i]);
            break;
          }
          s[f] = !0;
        }
    } else
      o.push(a);
  }
  return { flags: s, values: n, positional: o };
}
async function A(r, t, s, n, o) {
  if (r.length === 0)
    return { content: t, files: [] };
  const e = [], i = [];
  for (const a of r) {
    const d = o(a, n);
    e.push(d), i.push(await s.readFile(d));
  }
  return { content: i.join(""), files: e };
}
const D = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r);
    try {
      const { content: o } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return s.n ? { stdout: o.split(`
`).map((a, d) => `${String(d + 1).padStart(6)}	${a}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: o, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `cat: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, L = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.R;
    if (n.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const e = n[0], i = n.slice(1), a = parseInt(e, 8);
    if (isNaN(a))
      return { stdout: "", stderr: `chmod: invalid mode: '${e}'
`, exitCode: 1 };
    async function d(c) {
      const f = t.fs.resolvePath(c, t.cwd);
      if (o)
        try {
          if ((await t.fs.stat(f)).type === "dir") {
            const h = await t.fs.readdir(f);
            for (const p of h)
              await d(f + "/" + p.name);
          }
        } catch {
        }
    }
    try {
      for (const c of i)
        await d(c);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `chmod: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, O = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, q = {
  name: "cp",
  description: "Copy files and directories",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.r || s.R;
    if (n.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const e = t.fs.resolvePath(n[n.length - 1], t.cwd), i = n.slice(0, -1);
    let a = !1;
    try {
      a = (await t.fs.stat(e)).type === "dir";
    } catch {
    }
    if (i.length > 1 && !a)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function d(f, l) {
      const h = await t.fs.readFile(f);
      await t.fs.writeFile(l, h);
    }
    async function c(f, l) {
      await t.fs.mkdir(l, { recursive: !0 });
      const h = await t.fs.readdir(f);
      for (const p of h) {
        const u = f + "/" + p.name, g = l + "/" + p.name;
        p.type === "dir" ? await c(u, g) : await d(u, g);
      }
    }
    try {
      for (const f of i) {
        const l = t.fs.resolvePath(f, t.cwd), h = await t.fs.stat(l), p = f.split("/").pop(), u = a ? e + "/" + p : e;
        if (h.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${f}'
`, exitCode: 1 };
          await c(l, u);
        } else
          await d(l, u);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (f) {
      return { stdout: "", stderr: `cp: ${f instanceof Error ? f.message : f}
`, exitCode: 1 };
    }
  }
}, W = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(r, t) {
    const { flags: s, values: n, positional: o } = x(r, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (o.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const e = o[0], i = n.X || n.request || (n.d || n.data ? "POST" : "GET"), a = n.o || n.output, d = s.s || s.silent, c = s.i || s.include, f = s.I || s.head, l = s.L || s.location, h = {}, p = n.H || n.header;
    if (p) {
      const m = p.split(":");
      m.length >= 2 && (h[m[0].trim()] = m.slice(1).join(":").trim());
    }
    const u = n["user-agent"] || "fluffycoreutils-curl/0.1.0";
    h["User-Agent"] = u;
    let g;
    (n.d || n.data) && (g = n.d || n.data, h["Content-Type"] || (h["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const m = {
        method: f ? "HEAD" : i,
        headers: h,
        redirect: l ? "follow" : "manual"
      };
      g && i !== "GET" && i !== "HEAD" && (m.body = g);
      const y = await fetch(e, m);
      let w = "";
      if ((c || f) && (w += `HTTP/1.1 ${y.status} ${y.statusText}
`, y.headers.forEach((C, F) => {
        w += `${F}: ${C}
`;
      }), w += `
`), !f) {
        const C = await y.text();
        w += C;
      }
      if (a) {
        const C = t.fs.resolvePath(a, t.cwd);
        return await t.fs.writeFile(C, f ? "" : await y.text()), d ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${w.length}  100  ${w.length}    0     0   ${w.length}      0 --:--:-- --:--:-- --:--:--  ${w.length}
`,
          exitCode: 0
        };
      }
      return !d && !y.ok ? {
        stdout: w,
        stderr: `curl: (22) The requested URL returned error: ${y.status}
`,
        exitCode: 22
      } : { stdout: w, stderr: "", exitCode: 0 };
    } catch (m) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${m instanceof Error ? m.message : String(m)}
`,
        exitCode: 6
      };
    }
  }
}, z = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(r, t) {
    const { values: s, positional: n } = x(r, ["d", "f", "c"]), o = s.d ?? "	", e = s.f, i = s.c;
    if (!e && !i)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: a } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), d = H(e ?? i), c = a.split(`
`);
      c.length > 0 && c[c.length - 1] === "" && c.pop();
      const f = [];
      for (const l of c)
        if (e) {
          const h = l.split(o), p = d.flatMap((u) => h.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(o));
        } else {
          const h = l.split(""), p = d.flatMap((u) => h.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(""));
        }
      return { stdout: f.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `cut: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
};
function H(r) {
  return r.split(",").map((t) => {
    if (t.includes("-")) {
      const [n, o] = t.split("-");
      return {
        start: n ? parseInt(n, 10) : 1,
        end: o ? parseInt(o, 10) : 1 / 0
      };
    }
    const s = parseInt(t, 10);
    return { start: s, end: s };
  });
}
const U = {
  name: "date",
  description: "Display date and time",
  async exec(r) {
    const t = /* @__PURE__ */ new Date();
    if (r.length > 0 && r[0].startsWith("+")) {
      const s = r[0].slice(1);
      return { stdout: _(t, s) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: t.toString() + `
`, stderr: "", exitCode: 0 };
  }
};
function _(r, t) {
  const s = (n) => String(n).padStart(2, "0");
  return t.replace(/%Y/g, String(r.getFullYear())).replace(/%m/g, s(r.getMonth() + 1)).replace(/%d/g, s(r.getDate())).replace(/%H/g, s(r.getHours())).replace(/%M/g, s(r.getMinutes())).replace(/%S/g, s(r.getSeconds())).replace(/%s/g, String(Math.floor(r.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const Y = {
  name: "diff",
  description: "Compare files line by line",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.u;
    if (n.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const e = t.fs.resolvePath(n[0], t.cwd), i = t.fs.resolvePath(n[1], t.cwd), a = await t.fs.readFile(e), d = await t.fs.readFile(i);
      if (a === d)
        return { stdout: "", stderr: "", exitCode: 0 };
      const c = a.split(`
`), f = d.split(`
`), l = [];
      if (o) {
        l.push(`--- ${n[0]}`), l.push(`+++ ${n[1]}`);
        const h = Math.max(c.length, f.length);
        l.push(`@@ -1,${c.length} +1,${f.length} @@`);
        let p = 0, u = 0;
        for (; p < c.length || u < f.length; )
          p < c.length && u < f.length && c[p] === f[u] ? (l.push(` ${c[p]}`), p++, u++) : p < c.length && (u >= f.length || c[p] !== f[u]) ? (l.push(`-${c[p]}`), p++) : (l.push(`+${f[u]}`), u++);
      } else
        for (let h = 0; h < Math.max(c.length, f.length); h++)
          h >= c.length ? (l.push(`${h + 1}a${h + 1}`), l.push(`> ${f[h]}`)) : h >= f.length ? (l.push(`${h + 1}d${h + 1}`), l.push(`< ${c[h]}`)) : c[h] !== f[h] && (l.push(`${h + 1}c${h + 1}`), l.push(`< ${c[h]}`), l.push("---"), l.push(`> ${f[h]}`));
      return { stdout: l.join(`
`) + `
`, stderr: "", exitCode: 1 };
    } catch (e) {
      return { stdout: "", stderr: `diff: ${e instanceof Error ? e.message : e}
`, exitCode: 2 };
    }
  }
}, B = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(r) {
    if (r.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const t = r[0].replace(/\/+$/, ""), s = t.lastIndexOf("/");
    return { stdout: (s === -1 ? "." : s === 0 ? "/" : t.slice(0, s)) + `
`, stderr: "", exitCode: 0 };
  }
}, V = {
  name: "echo",
  description: "Display text",
  async exec(r) {
    const { flags: t } = x(r), s = t.n, n = r.filter((e) => e !== "-n" && e !== "-e").join(" ");
    let o = t.e ? n.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : n;
    return s || (o += `
`), { stdout: o, stderr: "", exitCode: 0 };
  }
}, Z = {
  name: "env",
  description: "Print environment variables",
  async exec(r, t) {
    return { stdout: Object.entries(t.env).map(([n, o]) => `${n}=${o}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, J = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(r, t) {
    if (r.length === 0)
      return { stdout: Object.entries(t.env).map(([e, i]) => `export ${e}="${i}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const s = [], n = [];
    for (const o of r) {
      const e = o.indexOf("=");
      if (e === -1) {
        const i = o;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i)) {
          n.push(`export: \`${i}': not a valid identifier`);
          continue;
        }
        i in t.env ? s.push(`export ${i}="${t.env[i]}"`) : s.push(`export ${i}=""`);
      } else {
        const i = o.slice(0, e);
        let a = o.slice(e + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i)) {
          n.push(`export: \`${i}': not a valid identifier`);
          continue;
        }
        (a.startsWith('"') && a.endsWith('"') || a.startsWith("'") && a.endsWith("'")) && (a = a.slice(1, -1)), t.env[i] = a, s.push(`export ${i}="${a}"`);
      }
    }
    return n.length > 0 ? {
      stdout: "",
      stderr: n.join(`
`) + `
`,
      exitCode: 1
    } : { stdout: "", stderr: "", exitCode: 0 };
  }
}, G = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, X = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(r, t) {
    const { values: s, positional: n } = x(r, ["name", "type"]), o = n[0] ?? ".", e = s.name, i = s.type, a = t.fs.resolvePath(o, t.cwd), d = [];
    let c;
    if (e) {
      const l = e.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      c = new RegExp(`^${l}$`);
    }
    async function f(l, h) {
      let p;
      try {
        p = await t.fs.readdir(l);
      } catch {
        return;
      }
      for (const u of p) {
        const g = l + "/" + u.name, m = h ? h + "/" + u.name : u.name, y = o === "." ? "./" + m : o + "/" + m;
        let w = !0;
        c && !c.test(u.name) && (w = !1), i === "f" && u.type !== "file" && (w = !1), i === "d" && u.type !== "dir" && (w = !1), w && d.push(y), u.type === "dir" && await f(g, m);
      }
    }
    return (!i || i === "d") && (c || d.push(o === "." ? "." : o)), await f(a, ""), { stdout: d.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, K = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(r, t) {
    const { flags: s, values: n, positional: o } = x(r, ["e"]), e = !!s.i, i = !!s.v, a = !!s.c, d = !!s.l, c = !!s.n, f = !!(s.r || s.R), l = n.e ?? o.shift();
    if (!l)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const h = e ? "i" : "";
    let p;
    try {
      p = new RegExp(l, h);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${l}
`, exitCode: 2 };
    }
    const u = o.length > 0 ? o : ["-"], g = u.length > 1 || f, m = [];
    let y = !1;
    async function w(v, P) {
      let $;
      try {
        if (v === "-")
          $ = t.stdin;
        else {
          const j = t.fs.resolvePath(v, t.cwd);
          $ = await t.fs.readFile(j);
        }
      } catch {
        m.push(`grep: ${v}: No such file or directory`);
        return;
      }
      const S = $.split(`
`);
      S.length > 0 && S[S.length - 1] === "" && S.pop();
      let E = 0;
      for (let j = 0; j < S.length; j++)
        if (p.test(S[j]) !== i && (y = !0, E++, !a && !d)) {
          const T = g ? `${P}:` : "", M = c ? `${j + 1}:` : "";
          m.push(`${T}${M}${S[j]}`);
        }
      a && m.push(g ? `${P}:${E}` : String(E)), d && E > 0 && m.push(P);
    }
    async function C(v) {
      const P = t.fs.resolvePath(v, t.cwd);
      let $;
      try {
        $ = await t.fs.readdir(P);
      } catch {
        return;
      }
      for (const S of $) {
        const E = P + "/" + S.name;
        S.type === "dir" ? await C(E) : await w(E, E);
      }
    }
    for (const v of u)
      if (v === "-")
        await w("-", "(standard input)");
      else if (f) {
        const P = t.fs.resolvePath(v, t.cwd);
        let $;
        try {
          $ = await t.fs.stat(P);
        } catch {
          continue;
        }
        $.type === "dir" ? await C(P) : await w(v, v);
      } else
        await w(v, v);
    return { stdout: m.length > 0 ? m.join(`
`) + `
` : "", stderr: "", exitCode: y ? 0 : 1 };
  }
}, Q = {
  name: "head",
  description: "Output the first part of files",
  async exec(r, t) {
    const { values: s, positional: n } = x(r, ["n"]), o = parseInt(s.n ?? "10", 10);
    try {
      const { content: e } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: e.split(`
`).slice(0, o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (e) {
      return { stdout: "", stderr: `head: ${e instanceof Error ? e.message : e}
`, exitCode: 1 };
    }
  }
}, tt = {
  name: "hostname",
  description: "Print system hostname",
  async exec(r, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, et = {
  name: "less",
  description: "View file contents with pagination",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r);
    try {
      const { content: o } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), e = o.split(`
`), i = s.N || s.n;
      let a = "";
      return i ? a = e.map((d, c) => `${String(c + 1).padStart(6)}  ${d}`).join(`
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
}, st = {
  name: "ln",
  description: "Make links between files",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.s;
    if (n.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const e = t.fs.resolvePath(n[0], t.cwd), i = t.fs.resolvePath(n[1], t.cwd);
    try {
      if (o && t.fs.symlink)
        await t.fs.symlink(e, i);
      else {
        const a = await t.fs.readFile(e);
        await t.fs.writeFile(i, a);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `ln: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, nt = {
  name: "ls",
  description: "List directory contents",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = n.length > 0 ? n : ["."], e = s.a, i = s.l, a = s.h, d = [];
    for (const c of o) {
      const f = t.fs.resolvePath(c, t.cwd), l = await t.fs.stat(f);
      if (l.type === "file") {
        d.push(i ? b(f.split("/").pop(), l, a) : f.split("/").pop());
        continue;
      }
      o.length > 1 && d.push(`${c}:`);
      const h = await t.fs.readdir(f), p = e ? h : h.filter((u) => !u.name.startsWith("."));
      if (p.sort((u, g) => u.name.localeCompare(g.name)), i) {
        d.push(`total ${p.length}`);
        for (const u of p)
          d.push(b(u.name, u, a));
      } else
        d.push(p.map((u) => u.type === "dir" ? u.name + "/" : u.name).join("  "));
    }
    return { stdout: d.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function b(r, t, s) {
  const n = t.type === "dir" ? "d" : "-", o = t.mode ?? (t.type === "dir" ? 493 : 420), e = rt(o), i = s ? it(t.size) : String(t.size).padStart(8), a = new Date(t.mtime), d = ot(a);
  return `${n}${e}  1 user user ${i} ${d} ${r}`;
}
function rt(r) {
  let s = "";
  for (let n = 2; n >= 0; n--) {
    const o = r >> n * 3 & 7;
    for (let e = 2; e >= 0; e--)
      s += o & 1 << e ? "rwx"[2 - e] : "-";
  }
  return s;
}
function ot(r) {
  const s = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][r.getMonth()], n = String(r.getDate()).padStart(2), o = String(r.getHours()).padStart(2, "0"), e = String(r.getMinutes()).padStart(2, "0");
  return `${s} ${n} ${o}:${e}`;
}
function it(r) {
  return r < 1024 ? String(r).padStart(5) : r < 1024 * 1024 ? (r / 1024).toFixed(1) + "K" : (r / (1024 * 1024)).toFixed(1) + "M";
}
const at = {
  name: "mkdir",
  description: "Make directories",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.p;
    if (n.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const e of n) {
        const i = t.fs.resolvePath(e, t.cwd);
        await t.fs.mkdir(i, { recursive: o });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (e) {
      return { stdout: "", stderr: `mkdir: ${e instanceof Error ? e.message : e}
`, exitCode: 1 };
    }
  }
}, ct = {
  name: "mv",
  description: "Move or rename files",
  async exec(r, t) {
    const { positional: s } = x(r);
    if (s.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(s[s.length - 1], t.cwd), o = s.slice(0, -1);
    let e = !1;
    try {
      e = (await t.fs.stat(n)).type === "dir";
    } catch {
    }
    if (o.length > 1 && !e)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const i of o) {
        const a = t.fs.resolvePath(i, t.cwd), d = i.split("/").pop(), c = e ? n + "/" + d : n;
        await t.fs.rename(a, c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `mv: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, dt = {
  name: "printf",
  description: "Format and print data",
  async exec(r) {
    if (r.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = r[0], s = r.slice(1);
    let n = 0, o = "", e = 0;
    for (; e < t.length; )
      if (t[e] === "\\") {
        switch (e++, t[e]) {
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
            o += "\\" + (t[e] ?? "");
            break;
        }
        e++;
      } else if (t[e] === "%")
        if (e++, t[e] === "%")
          o += "%", e++;
        else {
          let i = "";
          for (; e < t.length && !/[sdf]/.test(t[e]); )
            i += t[e], e++;
          const a = t[e] ?? "s";
          e++;
          const d = s[n++] ?? "";
          switch (a) {
            case "s":
              o += d;
              break;
            case "d":
              o += String(parseInt(d, 10) || 0);
              break;
            case "f": {
              const c = i.includes(".") ? parseInt(i.split(".")[1], 10) : 6;
              o += (parseFloat(d) || 0).toFixed(c);
              break;
            }
          }
        }
      else
        o += t[e], e++;
    return { stdout: o, stderr: "", exitCode: 0 };
  }
}, lt = {
  name: "pwd",
  description: "Print working directory",
  async exec(r, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, ft = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.f;
    if (n.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const e = t.fs.resolvePath(n[0], t.cwd);
    return o ? { stdout: e + `
`, stderr: "", exitCode: 0 } : { stdout: e + `
`, stderr: "", exitCode: 0 };
  }
}, ut = {
  name: "rm",
  description: "Remove files or directories",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.r || s.R, e = s.f;
    if (n.length === 0 && !e)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function i(a) {
      const d = await t.fs.readdir(a);
      for (const c of d) {
        const f = a + "/" + c.name;
        c.type === "dir" ? await i(f) : await t.fs.unlink(f);
      }
      await t.fs.rmdir(a);
    }
    try {
      for (const a of n) {
        const d = t.fs.resolvePath(a, t.cwd);
        let c;
        try {
          c = await t.fs.stat(d);
        } catch {
          if (e) continue;
          return { stdout: "", stderr: `rm: cannot remove '${a}': No such file or directory
`, exitCode: 1 };
        }
        if (c.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `rm: cannot remove '${a}': Is a directory
`, exitCode: 1 };
          await i(d);
        } else
          await t.fs.unlink(d);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return e ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, pt = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.i, e = n.shift();
    if (!e)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const i = e.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!i)
      return { stdout: "", stderr: `sed: unsupported expression: ${e}
`, exitCode: 1 };
    const [, , a, d, c] = i, f = c.includes("g"), l = c.includes("i");
    let h;
    try {
      const p = (f ? "g" : "") + (l ? "i" : "");
      h = new RegExp(a, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${a}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: u } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), g = p.split(`
`).map((m) => m.replace(h, d)).join(`
`);
      if (o && u.length > 0) {
        for (const m of u) {
          const y = t.fs.resolvePath(m, t.cwd), C = (await t.fs.readFile(y)).split(`
`).map((F) => F.replace(h, d)).join(`
`);
          await t.fs.writeFile(y, C);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: g, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, ht = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(r, t) {
    const { flags: s, values: n, positional: o } = x(r, ["separator", "s", "format", "f"]);
    if (o.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let e = 1, i = 1, a;
    if (o.length === 1 ? a = parseFloat(o[0]) : o.length === 2 ? (e = parseFloat(o[0]), a = parseFloat(o[1])) : o.length >= 3 ? (e = parseFloat(o[0]), i = parseFloat(o[1]), a = parseFloat(o[2])) : a = 1, isNaN(e) || isNaN(i) || isNaN(a))
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
    const d = n.s || n.separator || `
`, c = n.f || n.format, f = s.w, l = [];
    if (i > 0)
      for (let u = e; u <= a; u += i)
        l.push(String(u));
    else
      for (let u = e; u >= a; u += i)
        l.push(String(u));
    if (f) {
      const u = Math.max(...l.map((g) => g.length));
      for (let g = 0; g < l.length; g++)
        l[g] = l[g].padStart(u, "0");
    }
    if (c && typeof c == "string")
      for (let u = 0; u < l.length; u++) {
        const g = parseFloat(l[u]);
        c.includes("%g") || c.includes("%d") || c.includes("%i") ? l[u] = c.replace(/%[gdi]/, String(g)) : c.includes("%f") ? l[u] = c.replace(/%f/, g.toFixed(6)) : c.includes("%e") && (l[u] = c.replace(/%e/, g.toExponential()));
      }
    return {
      stdout: l.join(d) + ((typeof d == "string" ? d : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, mt = {
  name: "sort",
  description: "Sort lines of text",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r);
    try {
      const { content: o } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let e = o.split(`
`).filter(Boolean);
      return s.n ? e.sort((i, a) => parseFloat(i) - parseFloat(a)) : e.sort(), s.u && (e = [...new Set(e)]), s.r && e.reverse(), { stdout: e.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `sort: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, gt = {
  name: "tail",
  description: "Output the last part of files",
  async exec(r, t) {
    const { values: s, positional: n } = x(r, ["n"]), o = parseInt(s.n ?? "10", 10);
    try {
      const { content: e } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: e.split(`
`).slice(-o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (e) {
      return { stdout: "", stderr: `tail: ${e instanceof Error ? e.message : e}
`, exitCode: 1 };
    }
  }
}, xt = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(r, t) {
    const { flags: s, values: n, positional: o } = x(r, ["f", "C"]), e = s.c || s.create, i = s.x || s.extract, a = s.t || s.list, d = s.v || s.verbose, c = n.f, f = n.C;
    let l = t.cwd;
    f && (l = t.fs.resolvePath(f, t.cwd));
    const h = [e, i, a].filter(Boolean).length;
    if (h === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (h > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (e) {
        if (!c)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = o;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const u = [];
        async function g(C, F) {
          const v = t.fs.resolvePath(C, l);
          if ((await t.fs.stat(v)).type === "dir") {
            u.push({ path: F + "/", content: "", isDir: !0 });
            const $ = await t.fs.readdir(v);
            for (const S of $)
              await g(v + "/" + S.name, F + "/" + S.name);
          } else {
            const $ = await t.fs.readFile(v);
            u.push({ path: F, content: $, isDir: !1 });
          }
        }
        for (const C of p)
          await g(C, C);
        const m = ["FLUFFY-TAR-V1"];
        for (const C of u)
          d && (t.stderr || console.error(C.path)), m.push(`FILE:${C.path}`), m.push(`SIZE:${C.content.length}`), m.push(`TYPE:${C.isDir ? "dir" : "file"}`), m.push("DATA-START"), m.push(C.content), m.push("DATA-END");
        const y = m.join(`
`), w = t.fs.resolvePath(c, t.cwd);
        return await t.fs.writeFile(w, y), {
          stdout: d ? u.map((C) => C.path).join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (i) {
        if (!c)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(c, t.cwd), g = (await t.fs.readFile(p)).split(`
`);
        if (g[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let m = 1;
        const y = [];
        for (; m < g.length && g[m].startsWith("FILE:"); ) {
          const w = g[m].slice(5), C = parseInt(g[m + 1].slice(5), 10), F = g[m + 2].slice(5);
          m += 4;
          const v = [];
          for (; m < g.length && g[m] !== "DATA-END"; )
            v.push(g[m]), m++;
          const P = v.join(`
`);
          m++;
          const $ = t.fs.resolvePath(w, l);
          if (F === "dir")
            await t.fs.mkdir($, { recursive: !0 });
          else {
            const S = $.lastIndexOf("/");
            if (S > 0) {
              const E = $.slice(0, S);
              try {
                await t.fs.mkdir(E, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile($, P);
          }
          y.push(w), d && (t.stderr || console.error(w));
        }
        return {
          stdout: d ? y.join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (a) {
        if (!c)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(c, t.cwd), g = (await t.fs.readFile(p)).split(`
`);
        if (g[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        const m = [];
        for (let y = 1; y < g.length; y++)
          g[y].startsWith("FILE:") && m.push(g[y].slice(5));
        return { stdout: m.join(`
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
}, wt = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.a, e = t.stdin;
    try {
      for (const i of n) {
        const a = t.fs.resolvePath(i, t.cwd);
        if (o) {
          let d = "";
          try {
            d = await t.fs.readFile(a);
          } catch {
          }
          await t.fs.writeFile(a, d + e);
        } else
          await t.fs.writeFile(a, e);
      }
      return { stdout: e, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: e, stderr: `tee: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, yt = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(r, t) {
    const s = r[r.length - 1] === "]" ? r.slice(0, -1) : [...r];
    try {
      return { stdout: "", stderr: "", exitCode: await I(s, t) ? 0 : 1 };
    } catch (n) {
      return { stdout: "", stderr: `test: ${n instanceof Error ? n.message : n}
`, exitCode: 2 };
    }
  }
};
async function I(r, t) {
  if (r.length === 0) return !1;
  if (r.length === 1) return r[0] !== "";
  if (r.length === 2) {
    const [o, e] = r;
    switch (o) {
      case "-z":
        return e === "";
      case "-n":
        return e !== "";
      case "!":
        return e === "";
      case "-e":
      case "-f":
      case "-d":
        try {
          const i = t.fs.resolvePath(e, t.cwd), a = await t.fs.stat(i);
          return o === "-f" ? a.type === "file" : o === "-d" ? a.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (r[0] === "!" && r.length > 1)
    return !await I(r.slice(1), t);
  if (r.length === 3) {
    const [o, e, i] = r;
    switch (e) {
      case "=":
      case "==":
        return o === i;
      case "!=":
        return o !== i;
      case "-eq":
        return parseInt(o) === parseInt(i);
      case "-ne":
        return parseInt(o) !== parseInt(i);
      case "-lt":
        return parseInt(o) < parseInt(i);
      case "-le":
        return parseInt(o) <= parseInt(i);
      case "-gt":
        return parseInt(o) > parseInt(i);
      case "-ge":
        return parseInt(o) >= parseInt(i);
    }
  }
  const s = r.indexOf("-a");
  if (s > 0)
    return await I(r.slice(0, s), t) && await I(r.slice(s + 1), t);
  const n = r.indexOf("-o");
  return n > 0 ? await I(r.slice(0, n), t) || await I(r.slice(n + 1), t) : !1;
}
const Ct = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(r, t) {
    const { positional: s } = x(r);
    if (s.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const n of s) {
        const o = t.fs.resolvePath(n, t.cwd);
        try {
          await t.fs.stat(o);
          const e = await t.fs.readFile(o);
          await t.fs.writeFile(o, e);
        } catch {
          await t.fs.writeFile(o, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `touch: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, vt = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.d, e = s.s, i = k(n[0] ?? ""), a = k(n[1] ?? ""), d = t.stdin;
    let c;
    if (o) {
      const f = new Set(i.split(""));
      c = d.split("").filter((l) => !f.has(l)).join("");
    } else if (i && a) {
      const f = /* @__PURE__ */ new Map();
      for (let l = 0; l < i.length; l++)
        f.set(i[l], a[Math.min(l, a.length - 1)]);
      c = d.split("").map((l) => f.get(l) ?? l).join("");
    } else
      c = d;
    if (e && a) {
      const f = new Set(a.split(""));
      let l = "", h = "";
      for (const p of c)
        f.has(p) && p === h || (l += p, h = p);
      c = l;
    }
    return { stdout: c, stderr: "", exitCode: 0 };
  }
};
function k(r) {
  let t = r;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let s = "", n = 0;
  for (; n < t.length; )
    if (n + 2 < t.length && t[n + 1] === "-") {
      const o = t.charCodeAt(n), e = t.charCodeAt(n + 2);
      for (let i = o; i <= e; i++)
        s += String.fromCharCode(i);
      n += 3;
    } else
      s += t[n], n++;
  return s;
}
const $t = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, St = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r);
    try {
      const { content: o } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), e = o.split(`
`);
      e.length > 0 && e[e.length - 1] === "" && e.pop();
      const i = [];
      let a = "", d = 0;
      for (const c of e)
        c === a ? d++ : (d > 0 && R(a, d, s, i), a = c, d = 1);
      return d > 0 && R(a, d, s, i), { stdout: i.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `uniq: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
};
function R(r, t, s, n) {
  s.d && t < 2 || (s.c ? n.push(`${String(t).padStart(7)} ${r}`) : n.push(r));
}
const Pt = {
  name: "uname",
  description: "Print system information",
  async exec(r, t) {
    const { flags: s } = x(r), n = s.a, o = t.env.UNAME_SYSNAME ?? "FluffyOS", e = t.env.HOSTNAME ?? "localhost", i = t.env.UNAME_RELEASE ?? "1.0.0", a = t.env.UNAME_VERSION ?? "#1", d = t.env.UNAME_MACHINE ?? "wasm64";
    if (n)
      return { stdout: `${o} ${e} ${i} ${a} ${d}
`, stderr: "", exitCode: 0 };
    if (s.s || !s.n && !s.r && !s.v && !s.m)
      return { stdout: o + `
`, stderr: "", exitCode: 0 };
    const c = [];
    return s.s && c.push(o), s.n && c.push(e), s.r && c.push(i), s.v && c.push(a), s.m && c.push(d), { stdout: c.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Ft = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.l, e = s.w, i = s.c, a = !o && !e && !i;
    try {
      const { content: d, files: c } = await A(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), f = d.split(`
`).length - (d.endsWith(`
`) ? 1 : 0), l = d.split(/\s+/).filter(Boolean).length, h = d.length, p = [];
      return (a || o) && p.push(String(f).padStart(6)), (a || e) && p.push(String(l).padStart(6)), (a || i) && p.push(String(h).padStart(6)), c.length === 1 && p.push(" " + n[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (d) {
      return { stdout: "", stderr: `wc: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
}, Et = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.a;
    if (n.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const e = n[0], i = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", a = i.split(":"), d = [];
    for (const c of a) {
      const f = `${c}/${e}`;
      try {
        if (await t.fs.exists(f) && (await t.fs.stat(f)).type === "file" && (d.push(f), !o))
          break;
      } catch {
        continue;
      }
    }
    return d.length === 0 ? {
      stdout: "",
      stderr: `which: no ${e} in (${i})
`,
      exitCode: 1
    } : {
      stdout: d.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, At = {
  name: "whoami",
  description: "Print current user name",
  async exec(r, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, jt = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(r, t) {
    const { flags: s, positional: n } = x(r), o = s.I || s.L, e = n.length > 0 ? n.join(" ") : "echo", i = t.stdin.trim().split(o ? `
` : /\s+/).filter(Boolean);
    return i.length === 0 ? { stdout: "", stderr: "", exitCode: 0 } : e === "echo" ? { stdout: i.join(" ") + `
`, stderr: "", exitCode: 0 } : { stdout: `${e} ${i.map(It).join(" ")}` + `
`, stderr: "", exitCode: 0 };
  }
};
function It(r) {
  return /[^a-zA-Z0-9._\-/=]/.test(r) ? `'${r.replace(/'/g, "'\\''")}'` : r;
}
const bt = {
  basename: N,
  cat: D,
  chmod: L,
  clear: O,
  cp: q,
  curl: W,
  cut: z,
  date: U,
  diff: Y,
  dirname: B,
  echo: V,
  env: Z,
  export: J,
  false: G,
  find: X,
  grep: K,
  head: Q,
  hostname: tt,
  less: et,
  ln: st,
  ls: nt,
  mkdir: at,
  mv: ct,
  printf: dt,
  pwd: lt,
  readlink: ft,
  rm: ut,
  sed: pt,
  seq: ht,
  sort: mt,
  tail: gt,
  tar: xt,
  tee: wt,
  test: yt,
  touch: Ct,
  tr: vt,
  true: $t,
  uniq: St,
  uname: Pt,
  wc: Ft,
  which: Et,
  whoami: At,
  xargs: jt
}, Rt = Object.values(bt);
export {
  bt as allCommands,
  N as basename,
  D as cat,
  L as chmod,
  O as clear,
  Rt as commandList,
  q as cp,
  W as curl,
  z as cut,
  U as date,
  Y as diff,
  B as dirname,
  V as echo,
  Z as env,
  J as exportCmd,
  G as false,
  X as find,
  K as grep,
  Q as head,
  tt as hostname,
  et as less,
  st as ln,
  nt as ls,
  at as mkdir,
  ct as mv,
  dt as printf,
  lt as pwd,
  ft as readlink,
  ut as rm,
  pt as sed,
  ht as seq,
  mt as sort,
  gt as tail,
  xt as tar,
  wt as tee,
  yt as test,
  Ct as touch,
  vt as tr,
  $t as true,
  Pt as uname,
  St as uniq,
  Ft as wc,
  Et as which,
  At as whoami,
  jt as xargs
};
