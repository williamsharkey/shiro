const D = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(e) {
    if (e.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let t = e[0].replace(/\/+$/, "").split("/").pop() || "/";
    return e.length > 1 && t.endsWith(e[1]) && (t = t.slice(0, -e[1].length)), { stdout: t + `
`, stderr: "", exitCode: 0 };
  }
};
function m(e, t = []) {
  const n = {}, r = {}, o = [], s = new Set(t);
  for (let i = 0; i < e.length; i++) {
    const a = e[i];
    if (a === "--") {
      o.push(...e.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const c = a.slice(2);
      s.has(c) && i + 1 < e.length ? r[c] = e[++i] : n[c] = !0;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const c = a.slice(1);
      if (s.has(c) && i + 1 < e.length)
        r[c] = e[++i];
      else
        for (let d = 0; d < c.length; d++) {
          const l = c[d];
          if (s.has(l)) {
            const f = c.slice(d + 1);
            f ? r[l] = f : i + 1 < e.length && (r[l] = e[++i]);
            break;
          }
          n[l] = !0;
        }
    } else
      o.push(a);
  }
  return { flags: n, values: r, positional: o };
}
async function P(e, t, n, r, o) {
  if (e.length === 0)
    return { content: t, files: [] };
  const s = [], i = [];
  for (const a of e) {
    const c = o(a, r);
    s.push(c), i.push(await n.readFile(c));
  }
  return { content: i.join(""), files: s };
}
const O = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e);
    try {
      const { content: o } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return n.n ? { stdout: o.split(`
`).map((a, c) => `${String(c + 1).padStart(6)}	${a}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: o, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `cat: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, z = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.R;
    if (r.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const s = r[0], i = r.slice(1), a = parseInt(s, 8);
    if (isNaN(a))
      return { stdout: "", stderr: `chmod: invalid mode: '${s}'
`, exitCode: 1 };
    async function c(d) {
      const l = t.fs.resolvePath(d, t.cwd);
      if (o)
        try {
          if ((await t.fs.stat(l)).type === "dir") {
            const h = await t.fs.readdir(l);
            for (const u of h)
              await c(l + "/" + u.name);
          }
        } catch {
        }
    }
    try {
      for (const d of i)
        await c(d);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (d) {
      return { stdout: "", stderr: `chmod: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
}, L = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, W = {
  name: "cp",
  description: "Copy files and directories",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.r || n.R;
    if (r.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const s = t.fs.resolvePath(r[r.length - 1], t.cwd), i = r.slice(0, -1);
    let a = !1;
    try {
      a = (await t.fs.stat(s)).type === "dir";
    } catch {
    }
    if (i.length > 1 && !a)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(l, f) {
      const h = await t.fs.readFile(l);
      await t.fs.writeFile(f, h);
    }
    async function d(l, f) {
      await t.fs.mkdir(f, { recursive: !0 });
      const h = await t.fs.readdir(l);
      for (const u of h) {
        const p = l + "/" + u.name, w = f + "/" + u.name;
        u.type === "dir" ? await d(p, w) : await c(p, w);
      }
    }
    try {
      for (const l of i) {
        const f = t.fs.resolvePath(l, t.cwd), h = await t.fs.stat(f), u = l.split("/").pop(), p = a ? s + "/" + u : s;
        if (h.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${l}'
`, exitCode: 1 };
          await d(f, p);
        } else
          await c(f, p);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `cp: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
}, q = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(e, t) {
    const { values: n, positional: r } = m(e, ["d", "f", "c"]), o = n.d ?? "	", s = n.f, i = n.c;
    if (!s && !i)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: a } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = H(s ?? i), d = a.split(`
`);
      d.length > 0 && d[d.length - 1] === "" && d.pop();
      const l = [];
      for (const f of d)
        if (s) {
          const h = f.split(o), u = c.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
          l.push(u.join(o));
        } else {
          const h = f.split(""), u = c.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
          l.push(u.join(""));
        }
      return { stdout: l.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `cut: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
};
function H(e) {
  return e.split(",").map((t) => {
    if (t.includes("-")) {
      const [r, o] = t.split("-");
      return {
        start: r ? parseInt(r, 10) : 1,
        end: o ? parseInt(o, 10) : 1 / 0
      };
    }
    const n = parseInt(t, 10);
    return { start: n, end: n };
  });
}
const B = {
  name: "date",
  description: "Display date and time",
  async exec(e) {
    const t = /* @__PURE__ */ new Date();
    if (e.length > 0 && e[0].startsWith("+")) {
      const n = e[0].slice(1);
      return { stdout: U(t, n) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: t.toString() + `
`, stderr: "", exitCode: 0 };
  }
};
function U(e, t) {
  const n = (r) => String(r).padStart(2, "0");
  return t.replace(/%Y/g, String(e.getFullYear())).replace(/%m/g, n(e.getMonth() + 1)).replace(/%d/g, n(e.getDate())).replace(/%H/g, n(e.getHours())).replace(/%M/g, n(e.getMinutes())).replace(/%S/g, n(e.getSeconds())).replace(/%s/g, String(Math.floor(e.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const _ = {
  name: "diff",
  description: "Compare files line by line",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.u;
    if (r.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const s = t.fs.resolvePath(r[0], t.cwd), i = t.fs.resolvePath(r[1], t.cwd), a = await t.fs.readFile(s), c = await t.fs.readFile(i);
      if (a === c)
        return { stdout: "", stderr: "", exitCode: 0 };
      const d = a.split(`
`), l = c.split(`
`), f = [];
      if (o) {
        f.push(`--- ${r[0]}`), f.push(`+++ ${r[1]}`);
        const h = Math.max(d.length, l.length);
        f.push(`@@ -1,${d.length} +1,${l.length} @@`);
        let u = 0, p = 0;
        for (; u < d.length || p < l.length; )
          u < d.length && p < l.length && d[u] === l[p] ? (f.push(` ${d[u]}`), u++, p++) : u < d.length && (p >= l.length || d[u] !== l[p]) ? (f.push(`-${d[u]}`), u++) : (f.push(`+${l[p]}`), p++);
      } else
        for (let h = 0; h < Math.max(d.length, l.length); h++)
          h >= d.length ? (f.push(`${h + 1}a${h + 1}`), f.push(`> ${l[h]}`)) : h >= l.length ? (f.push(`${h + 1}d${h + 1}`), f.push(`< ${d[h]}`)) : d[h] !== l[h] && (f.push(`${h + 1}c${h + 1}`), f.push(`< ${d[h]}`), f.push("---"), f.push(`> ${l[h]}`));
      return { stdout: f.join(`
`) + `
`, stderr: "", exitCode: 1 };
    } catch (s) {
      return { stdout: "", stderr: `diff: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
}, J = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(e) {
    if (e.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const t = e[0].replace(/\/+$/, ""), n = t.lastIndexOf("/");
    return { stdout: (n === -1 ? "." : n === 0 ? "/" : t.slice(0, n)) + `
`, stderr: "", exitCode: 0 };
  }
}, T = {
  name: "echo",
  description: "Display text",
  async exec(e) {
    const { flags: t } = m(e), n = t.n, r = e.filter((s) => s !== "-n" && s !== "-e").join(" ");
    let o = t.e ? r.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : r;
    return n || (o += `
`), { stdout: o, stderr: "", exitCode: 0 };
  }
}, Y = {
  name: "env",
  description: "Print environment variables",
  async exec(e, t) {
    return { stdout: Object.entries(t.env).map(([r, o]) => `${r}=${o}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, K = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, V = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(e, t) {
    const { values: n, positional: r } = m(e, ["name", "type"]), o = r[0] ?? ".", s = n.name, i = n.type, a = t.fs.resolvePath(o, t.cwd), c = [];
    let d;
    if (s) {
      const f = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      d = new RegExp(`^${f}$`);
    }
    async function l(f, h) {
      let u;
      try {
        u = await t.fs.readdir(f);
      } catch {
        return;
      }
      for (const p of u) {
        const w = f + "/" + p.name, g = h ? h + "/" + p.name : p.name, E = o === "." ? "./" + g : o + "/" + g;
        let y = !0;
        d && !d.test(p.name) && (y = !1), i === "f" && p.type !== "file" && (y = !1), i === "d" && p.type !== "dir" && (y = !1), y && c.push(E), p.type === "dir" && await l(w, g);
      }
    }
    return (!i || i === "d") && (d || c.push(o === "." ? "." : o)), await l(a, ""), { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, Z = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(e, t) {
    const { flags: n, values: r, positional: o } = m(e, ["e"]), s = !!n.i, i = !!n.v, a = !!n.c, c = !!n.l, d = !!n.n, l = !!(n.r || n.R), f = r.e ?? o.shift();
    if (!f)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const h = s ? "i" : "";
    let u;
    try {
      u = new RegExp(f, h);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${f}
`, exitCode: 2 };
    }
    const p = o.length > 0 ? o : ["-"], w = p.length > 1 || l, g = [];
    let E = !1;
    async function y(x, v) {
      let $;
      try {
        if (x === "-")
          $ = t.stdin;
        else {
          const F = t.fs.resolvePath(x, t.cwd);
          $ = await t.fs.readFile(F);
        }
      } catch {
        g.push(`grep: ${x}: No such file or directory`);
        return;
      }
      const C = $.split(`
`);
      C.length > 0 && C[C.length - 1] === "" && C.pop();
      let S = 0;
      for (let F = 0; F < C.length; F++)
        if (u.test(C[F]) !== i && (E = !0, S++, !a && !c)) {
          const A = w ? `${v}:` : "", N = d ? `${F + 1}:` : "";
          g.push(`${A}${N}${C[F]}`);
        }
      a && g.push(w ? `${v}:${S}` : String(S)), c && S > 0 && g.push(v);
    }
    async function j(x) {
      const v = t.fs.resolvePath(x, t.cwd);
      let $;
      try {
        $ = await t.fs.readdir(v);
      } catch {
        return;
      }
      for (const C of $) {
        const S = v + "/" + C.name;
        C.type === "dir" ? await j(S) : await y(S, S);
      }
    }
    for (const x of p)
      if (x === "-")
        await y("-", "(standard input)");
      else if (l) {
        const v = t.fs.resolvePath(x, t.cwd);
        let $;
        try {
          $ = await t.fs.stat(v);
        } catch {
          continue;
        }
        $.type === "dir" ? await j(v) : await y(x, x);
      } else
        await y(x, x);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: E ? 0 : 1 };
  }
}, G = {
  name: "head",
  description: "Output the first part of files",
  async exec(e, t) {
    const { values: n, positional: r } = m(e, ["n"]), o = parseInt(n.n ?? "10", 10);
    try {
      const { content: s } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: s.split(`
`).slice(0, o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `head: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, Q = {
  name: "hostname",
  description: "Print system hostname",
  async exec(e, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, X = {
  name: "ln",
  description: "Make links between files",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.s;
    if (r.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const s = t.fs.resolvePath(r[0], t.cwd), i = t.fs.resolvePath(r[1], t.cwd);
    try {
      if (o && t.fs.symlink)
        await t.fs.symlink(s, i);
      else {
        const a = await t.fs.readFile(s);
        await t.fs.writeFile(i, a);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `ln: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, tt = {
  name: "ls",
  description: "List directory contents",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = r.length > 0 ? r : ["."], s = n.a, i = n.l, a = n.h, c = [];
    for (const d of o) {
      const l = t.fs.resolvePath(d, t.cwd), f = await t.fs.stat(l);
      if (f.type === "file") {
        c.push(i ? M(l.split("/").pop(), f, a) : l.split("/").pop());
        continue;
      }
      o.length > 1 && c.push(`${d}:`);
      const h = await t.fs.readdir(l), u = s ? h : h.filter((p) => !p.name.startsWith("."));
      if (u.sort((p, w) => p.name.localeCompare(w.name)), i) {
        c.push(`total ${u.length}`);
        for (const p of u)
          c.push(M(p.name, p, a));
      } else
        c.push(u.map((p) => p.type === "dir" ? p.name + "/" : p.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function M(e, t, n) {
  const r = t.type === "dir" ? "d" : "-", o = t.mode ?? (t.type === "dir" ? 493 : 420), s = et(o), i = n ? nt(t.size) : String(t.size).padStart(8), a = new Date(t.mtime), c = st(a);
  return `${r}${s}  1 user user ${i} ${c} ${e}`;
}
function et(e) {
  let n = "";
  for (let r = 2; r >= 0; r--) {
    const o = e >> r * 3 & 7;
    for (let s = 2; s >= 0; s--)
      n += o & 1 << s ? "rwx"[2 - s] : "-";
  }
  return n;
}
function st(e) {
  const n = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][e.getMonth()], r = String(e.getDate()).padStart(2), o = String(e.getHours()).padStart(2, "0"), s = String(e.getMinutes()).padStart(2, "0");
  return `${n} ${r} ${o}:${s}`;
}
function nt(e) {
  return e < 1024 ? String(e).padStart(5) : e < 1024 * 1024 ? (e / 1024).toFixed(1) + "K" : (e / (1024 * 1024)).toFixed(1) + "M";
}
const rt = {
  name: "mkdir",
  description: "Make directories",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.p;
    if (r.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const s of r) {
        const i = t.fs.resolvePath(s, t.cwd);
        await t.fs.mkdir(i, { recursive: o });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `mkdir: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, ot = {
  name: "mv",
  description: "Move or rename files",
  async exec(e, t) {
    const { positional: n } = m(e);
    if (n.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const r = t.fs.resolvePath(n[n.length - 1], t.cwd), o = n.slice(0, -1);
    let s = !1;
    try {
      s = (await t.fs.stat(r)).type === "dir";
    } catch {
    }
    if (o.length > 1 && !s)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const i of o) {
        const a = t.fs.resolvePath(i, t.cwd), c = i.split("/").pop(), d = s ? r + "/" + c : r;
        await t.fs.rename(a, d);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `mv: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, it = {
  name: "printf",
  description: "Format and print data",
  async exec(e) {
    if (e.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = e[0], n = e.slice(1);
    let r = 0, o = "", s = 0;
    for (; s < t.length; )
      if (t[s] === "\\") {
        switch (s++, t[s]) {
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
            o += "\\" + (t[s] ?? "");
            break;
        }
        s++;
      } else if (t[s] === "%")
        if (s++, t[s] === "%")
          o += "%", s++;
        else {
          let i = "";
          for (; s < t.length && !/[sdf]/.test(t[s]); )
            i += t[s], s++;
          const a = t[s] ?? "s";
          s++;
          const c = n[r++] ?? "";
          switch (a) {
            case "s":
              o += c;
              break;
            case "d":
              o += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const d = i.includes(".") ? parseInt(i.split(".")[1], 10) : 6;
              o += (parseFloat(c) || 0).toFixed(d);
              break;
            }
          }
        }
      else
        o += t[s], s++;
    return { stdout: o, stderr: "", exitCode: 0 };
  }
}, at = {
  name: "pwd",
  description: "Print working directory",
  async exec(e, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, ct = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.f;
    if (r.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const s = t.fs.resolvePath(r[0], t.cwd);
    return o ? { stdout: s + `
`, stderr: "", exitCode: 0 } : { stdout: s + `
`, stderr: "", exitCode: 0 };
  }
}, dt = {
  name: "rm",
  description: "Remove files or directories",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.r || n.R, s = n.f;
    if (r.length === 0 && !s)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function i(a) {
      const c = await t.fs.readdir(a);
      for (const d of c) {
        const l = a + "/" + d.name;
        d.type === "dir" ? await i(l) : await t.fs.unlink(l);
      }
      await t.fs.rmdir(a);
    }
    try {
      for (const a of r) {
        const c = t.fs.resolvePath(a, t.cwd);
        let d;
        try {
          d = await t.fs.stat(c);
        } catch {
          if (s) continue;
          return { stdout: "", stderr: `rm: cannot remove '${a}': No such file or directory
`, exitCode: 1 };
        }
        if (d.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `rm: cannot remove '${a}': Is a directory
`, exitCode: 1 };
          await i(c);
        } else
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return s ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, lt = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.i, s = r.shift();
    if (!s)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const i = s.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!i)
      return { stdout: "", stderr: `sed: unsupported expression: ${s}
`, exitCode: 1 };
    const [, , a, c, d] = i, l = d.includes("g"), f = d.includes("i");
    let h;
    try {
      const u = (l ? "g" : "") + (f ? "i" : "");
      h = new RegExp(a, u);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${a}
`, exitCode: 2 };
    }
    try {
      const { content: u, files: p } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), w = u.split(`
`).map((g) => g.replace(h, c)).join(`
`);
      if (o && p.length > 0) {
        for (const g of p) {
          const E = t.fs.resolvePath(g, t.cwd), j = (await t.fs.readFile(E)).split(`
`).map((k) => k.replace(h, c)).join(`
`);
          await t.fs.writeFile(E, j);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: w, stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `sed: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, ft = {
  name: "sort",
  description: "Sort lines of text",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e);
    try {
      const { content: o } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let s = o.split(`
`).filter(Boolean);
      return n.n ? s.sort((i, a) => parseFloat(i) - parseFloat(a)) : s.sort(), n.u && (s = [...new Set(s)]), n.r && s.reverse(), { stdout: s.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `sort: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, ut = {
  name: "tail",
  description: "Output the last part of files",
  async exec(e, t) {
    const { values: n, positional: r } = m(e, ["n"]), o = parseInt(n.n ?? "10", 10);
    try {
      const { content: s } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: s.split(`
`).slice(-o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `tail: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, pt = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.a, s = t.stdin;
    try {
      for (const i of r) {
        const a = t.fs.resolvePath(i, t.cwd);
        if (o) {
          let c = "";
          try {
            c = await t.fs.readFile(a);
          } catch {
          }
          await t.fs.writeFile(a, c + s);
        } else
          await t.fs.writeFile(a, s);
      }
      return { stdout: s, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: s, stderr: `tee: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, ht = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(e, t) {
    const n = e[e.length - 1] === "]" ? e.slice(0, -1) : [...e];
    try {
      return { stdout: "", stderr: "", exitCode: await I(n, t) ? 0 : 1 };
    } catch (r) {
      return { stdout: "", stderr: `test: ${r instanceof Error ? r.message : r}
`, exitCode: 2 };
    }
  }
};
async function I(e, t) {
  if (e.length === 0) return !1;
  if (e.length === 1) return e[0] !== "";
  if (e.length === 2) {
    const [o, s] = e;
    switch (o) {
      case "-z":
        return s === "";
      case "-n":
        return s !== "";
      case "!":
        return s === "";
      case "-e":
      case "-f":
      case "-d":
        try {
          const i = t.fs.resolvePath(s, t.cwd), a = await t.fs.stat(i);
          return o === "-f" ? a.type === "file" : o === "-d" ? a.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (e[0] === "!" && e.length > 1)
    return !await I(e.slice(1), t);
  if (e.length === 3) {
    const [o, s, i] = e;
    switch (s) {
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
  const n = e.indexOf("-a");
  if (n > 0)
    return await I(e.slice(0, n), t) && await I(e.slice(n + 1), t);
  const r = e.indexOf("-o");
  return r > 0 ? await I(e.slice(0, r), t) || await I(e.slice(r + 1), t) : !1;
}
const mt = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(e, t) {
    const { positional: n } = m(e);
    if (n.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const r of n) {
        const o = t.fs.resolvePath(r, t.cwd);
        try {
          await t.fs.stat(o);
          const s = await t.fs.readFile(o);
          await t.fs.writeFile(o, s);
        } catch {
          await t.fs.writeFile(o, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `touch: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, gt = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.d, s = n.s, i = b(r[0] ?? ""), a = b(r[1] ?? ""), c = t.stdin;
    let d;
    if (o) {
      const l = new Set(i.split(""));
      d = c.split("").filter((f) => !l.has(f)).join("");
    } else if (i && a) {
      const l = /* @__PURE__ */ new Map();
      for (let f = 0; f < i.length; f++)
        l.set(i[f], a[Math.min(f, a.length - 1)]);
      d = c.split("").map((f) => l.get(f) ?? f).join("");
    } else
      d = c;
    if (s && a) {
      const l = new Set(a.split(""));
      let f = "", h = "";
      for (const u of d)
        l.has(u) && u === h || (f += u, h = u);
      d = f;
    }
    return { stdout: d, stderr: "", exitCode: 0 };
  }
};
function b(e) {
  let t = e;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let n = "", r = 0;
  for (; r < t.length; )
    if (r + 2 < t.length && t[r + 1] === "-") {
      const o = t.charCodeAt(r), s = t.charCodeAt(r + 2);
      for (let i = o; i <= s; i++)
        n += String.fromCharCode(i);
      r += 3;
    } else
      n += t[r], r++;
  return n;
}
const xt = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, wt = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e);
    try {
      const { content: o } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), s = o.split(`
`);
      s.length > 0 && s[s.length - 1] === "" && s.pop();
      const i = [];
      let a = "", c = 0;
      for (const d of s)
        d === a ? c++ : (c > 0 && R(a, c, n, i), a = d, c = 1);
      return c > 0 && R(a, c, n, i), { stdout: i.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `uniq: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
};
function R(e, t, n, r) {
  n.d && t < 2 || (n.c ? r.push(`${String(t).padStart(7)} ${e}`) : r.push(e));
}
const yt = {
  name: "uname",
  description: "Print system information",
  async exec(e, t) {
    const { flags: n } = m(e), r = n.a, o = t.env.UNAME_SYSNAME ?? "FluffyOS", s = t.env.HOSTNAME ?? "localhost", i = t.env.UNAME_RELEASE ?? "1.0.0", a = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (r)
      return { stdout: `${o} ${s} ${i} ${a} ${c}
`, stderr: "", exitCode: 0 };
    if (n.s || !n.n && !n.r && !n.v && !n.m)
      return { stdout: o + `
`, stderr: "", exitCode: 0 };
    const d = [];
    return n.s && d.push(o), n.n && d.push(s), n.r && d.push(i), n.v && d.push(a), n.m && d.push(c), { stdout: d.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Ct = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.l, s = n.w, i = n.c, a = !o && !s && !i;
    try {
      const { content: c, files: d } = await P(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), l = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), f = c.split(/\s+/).filter(Boolean).length, h = c.length, u = [];
      return (a || o) && u.push(String(l).padStart(6)), (a || s) && u.push(String(f).padStart(6)), (a || i) && u.push(String(h).padStart(6)), d.length === 1 && u.push(" " + r[0]), { stdout: u.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, vt = {
  name: "whoami",
  description: "Print current user name",
  async exec(e, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, $t = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(e, t) {
    const { flags: n, positional: r } = m(e), o = n.I || n.L, s = r.length > 0 ? r.join(" ") : "echo", i = t.stdin.trim().split(o ? `
` : /\s+/).filter(Boolean);
    return i.length === 0 ? { stdout: "", stderr: "", exitCode: 0 } : s === "echo" ? { stdout: i.join(" ") + `
`, stderr: "", exitCode: 0 } : { stdout: `${s} ${i.map(St).join(" ")}` + `
`, stderr: "", exitCode: 0 };
  }
};
function St(e) {
  return /[^a-zA-Z0-9._\-/=]/.test(e) ? `'${e.replace(/'/g, "'\\''")}'` : e;
}
const Pt = {
  basename: D,
  cat: O,
  chmod: z,
  clear: L,
  cp: W,
  cut: q,
  date: B,
  diff: _,
  dirname: J,
  echo: T,
  env: Y,
  false: K,
  find: V,
  grep: Z,
  head: G,
  hostname: Q,
  ln: X,
  ls: tt,
  mkdir: rt,
  mv: ot,
  printf: it,
  pwd: at,
  readlink: ct,
  rm: dt,
  sed: lt,
  sort: ft,
  tail: ut,
  tee: pt,
  test: ht,
  touch: mt,
  tr: gt,
  true: xt,
  uniq: wt,
  uname: yt,
  wc: Ct,
  whoami: vt,
  xargs: $t
}, Ft = Object.values(Pt);
export {
  Pt as allCommands,
  D as basename,
  O as cat,
  z as chmod,
  L as clear,
  Ft as commandList,
  W as cp,
  q as cut,
  B as date,
  _ as diff,
  J as dirname,
  T as echo,
  Y as env,
  K as false,
  V as find,
  Z as grep,
  G as head,
  Q as hostname,
  X as ln,
  tt as ls,
  rt as mkdir,
  ot as mv,
  it as printf,
  at as pwd,
  ct as readlink,
  dt as rm,
  lt as sed,
  ft as sort,
  ut as tail,
  pt as tee,
  ht as test,
  mt as touch,
  gt as tr,
  xt as true,
  yt as uname,
  wt as uniq,
  Ct as wc,
  vt as whoami,
  $t as xargs
};
