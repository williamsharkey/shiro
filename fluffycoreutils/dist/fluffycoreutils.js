const W = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(s) {
    if (s.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let t = s[0].replace(/\/+$/, "").split("/").pop() || "/";
    return s.length > 1 && t.endsWith(s[1]) && (t = t.slice(0, -s[1].length)), { stdout: t + `
`, stderr: "", exitCode: 0 };
  }
};
function S(s, t = []) {
  const e = {}, r = {}, o = [], n = new Set(t);
  for (let a = 0; a < s.length; a++) {
    const i = s[a];
    if (i === "--") {
      o.push(...s.slice(a + 1));
      break;
    }
    if (i.startsWith("--")) {
      const c = i.slice(2);
      n.has(c) && a + 1 < s.length ? r[c] = s[++a] : e[c] = !0;
    } else if (i.startsWith("-") && i.length > 1 && !/^-\d/.test(i)) {
      const c = i.slice(1);
      if (n.has(c) && a + 1 < s.length)
        r[c] = s[++a];
      else
        for (let l = 0; l < c.length; l++) {
          const f = c[l];
          if (n.has(f)) {
            const d = c.slice(l + 1);
            d ? r[f] = d : a + 1 < s.length && (r[f] = s[++a]);
            break;
          }
          e[f] = !0;
        }
    } else
      o.push(i);
  }
  return { flags: e, values: r, positional: o };
}
async function A(s, t, e, r, o) {
  if (s.length === 0)
    return { content: t, files: [] };
  const n = [], a = [];
  for (const i of s) {
    const c = o(i, r);
    n.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: n };
}
const U = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s);
    try {
      const { content: o } = await A(
        r,
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
}, z = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.R;
    if (r.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const n = r[0], a = r.slice(1), i = parseInt(n, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${n}'
`, exitCode: 1 };
    async function c(l) {
      const f = t.fs.resolvePath(l, t.cwd);
      if (o)
        try {
          if ((await t.fs.stat(f)).type === "dir") {
            const g = await t.fs.readdir(f);
            for (const p of g)
              await c(f + "/" + p.name);
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
}, H = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, _ = {
  name: "cp",
  description: "Copy files and directories",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.r || e.R;
    if (r.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(r[r.length - 1], t.cwd), a = r.slice(0, -1);
    let i = !1;
    try {
      i = (await t.fs.stat(n)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !i)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(f, d) {
      const g = await t.fs.readFile(f);
      await t.fs.writeFile(d, g);
    }
    async function l(f, d) {
      await t.fs.mkdir(d, { recursive: !0 });
      const g = await t.fs.readdir(f);
      for (const p of g) {
        const u = f + "/" + p.name, h = d + "/" + p.name;
        p.type === "dir" ? await l(u, h) : await c(u, h);
      }
    }
    try {
      for (const f of a) {
        const d = t.fs.resolvePath(f, t.cwd), g = await t.fs.stat(d), p = f.split("/").pop(), u = i ? n + "/" + p : n;
        if (g.type === "dir") {
          if (!o)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${f}'
`, exitCode: 1 };
          await l(d, u);
        } else
          await c(d, u);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (f) {
      return { stdout: "", stderr: `cp: ${f instanceof Error ? f.message : f}
`, exitCode: 1 };
    }
  }
}, B = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(s, t) {
    const { flags: e, values: r, positional: o } = S(s, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (o.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const n = o[0], a = r.X || r.request || (r.d || r.data ? "POST" : "GET"), i = r.o || r.output, c = e.s || e.silent, l = e.i || e.include, f = e.I || e.head, d = e.L || e.location, g = {}, p = r.H || r.header;
    if (p) {
      const m = p.split(":");
      m.length >= 2 && (g[m[0].trim()] = m.slice(1).join(":").trim());
    }
    const u = r["user-agent"] || "fluffycoreutils-curl/0.1.0";
    g["User-Agent"] = u;
    let h;
    (r.d || r.data) && (h = r.d || r.data, g["Content-Type"] || (g["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const m = {
        method: f ? "HEAD" : a,
        headers: g,
        redirect: d ? "follow" : "manual"
      };
      h && a !== "GET" && a !== "HEAD" && (m.body = h);
      const y = await fetch(n, m);
      let E = "";
      if ((l || f) && (E += `HTTP/1.1 ${y.status} ${y.statusText}
`, y.headers.forEach(($, P) => {
        E += `${P}: ${$}
`;
      }), E += `
`), !f) {
        const $ = await y.text();
        E += $;
      }
      if (i) {
        const $ = t.fs.resolvePath(i, t.cwd);
        return await t.fs.writeFile($, f ? "" : await y.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${E.length}  100  ${E.length}    0     0   ${E.length}      0 --:--:-- --:--:-- --:--:--  ${E.length}
`,
          exitCode: 0
        };
      }
      return !c && !y.ok ? {
        stdout: E,
        stderr: `curl: (22) The requested URL returned error: ${y.status}
`,
        exitCode: 22
      } : { stdout: E, stderr: "", exitCode: 0 };
    } catch (m) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${m instanceof Error ? m.message : String(m)}
`,
        exitCode: 6
      };
    }
  }
}, Y = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(s, t) {
    const { values: e, positional: r } = S(s, ["d", "f", "c"]), o = e.d ?? "	", n = e.f, a = e.c;
    if (!n && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = V(n ?? a), l = i.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const f = [];
      for (const d of l)
        if (n) {
          const g = d.split(o), p = c.flatMap((u) => g.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(o));
        } else {
          const g = d.split(""), p = c.flatMap((u) => g.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(""));
        }
      return { stdout: f.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `cut: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
};
function V(s) {
  return s.split(",").map((t) => {
    if (t.includes("-")) {
      const [r, o] = t.split("-");
      return {
        start: r ? parseInt(r, 10) : 1,
        end: o ? parseInt(o, 10) : 1 / 0
      };
    }
    const e = parseInt(t, 10);
    return { start: e, end: e };
  });
}
const Z = {
  name: "date",
  description: "Display date and time",
  async exec(s) {
    const t = /* @__PURE__ */ new Date();
    if (s.length > 0 && s[0].startsWith("+")) {
      const e = s[0].slice(1);
      return { stdout: J(t, e) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: t.toString() + `
`, stderr: "", exitCode: 0 };
  }
};
function J(s, t) {
  const e = (r) => String(r).padStart(2, "0");
  return t.replace(/%Y/g, String(s.getFullYear())).replace(/%m/g, e(s.getMonth() + 1)).replace(/%d/g, e(s.getDate())).replace(/%H/g, e(s.getHours())).replace(/%M/g, e(s.getMinutes())).replace(/%S/g, e(s.getSeconds())).replace(/%s/g, String(Math.floor(s.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const G = {
  name: "diff",
  description: "Compare files line by line",
  async exec(s, t) {
    var g, p;
    const { flags: e, positional: r, values: o } = S(s, ["U", "context", "C"]), n = e.u || o.U !== void 0, a = o.U || o.context || o.C || (e.u ? 3 : 0), i = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, l = e.i, f = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (r.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const u = t.fs.resolvePath(r[0], t.cwd), h = t.fs.resolvePath(r[1], t.cwd), m = await t.fs.readFile(u), y = await t.fs.readFile(h);
      if (m === y)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${r[0]} and ${r[1]} differ
`, stderr: "", exitCode: 1 };
      const E = m.split(`
`), $ = y.split(`
`), P = X(E, $, { ignoreCase: l, ignoreWhitespace: f }), x = [];
      if (n) {
        x.push(`--- ${r[0]}`), x.push(`+++ ${r[1]}`);
        let w = 0;
        for (; w < P.length; ) {
          if (P[w].type === "equal") {
            w++;
            continue;
          }
          const v = Math.max(0, w - 1);
          let F = w;
          for (; F < P.length; ) {
            const I = P[F];
            if (I.type !== "equal")
              F++;
            else if (I.lines.length <= i * 2)
              F++;
            else
              break;
          }
          const b = (((g = P[v]) == null ? void 0 : g.line1) ?? 0) + 1, M = (((p = P[v]) == null ? void 0 : p.line2) ?? 0) + 1;
          let k = 0, R = 0;
          for (let I = v; I < F; I++)
            (P[I].type === "equal" || P[I].type === "delete") && (k += P[I].lines.length), (P[I].type === "equal" || P[I].type === "add") && (R += P[I].lines.length);
          x.push(`@@ -${b},${k} +${M},${R} @@`);
          for (let I = v; I < F; I++) {
            const j = P[I];
            j.type === "equal" ? j.lines.forEach((T) => x.push(` ${T}`)) : j.type === "delete" ? j.lines.forEach((T) => x.push(`-${T}`)) : j.type === "add" && j.lines.forEach((T) => x.push(`+${T}`));
          }
          w = F;
        }
      } else if (d)
        for (const C of P)
          C.type === "equal" ? C.lines.forEach((v) => {
            const F = v.substring(0, 40).padEnd(40);
            x.push(`${F} | ${v}`);
          }) : C.type === "delete" ? C.lines.forEach((v) => {
            const F = v.substring(0, 40).padEnd(40);
            x.push(`${F} <`);
          }) : C.type === "add" && C.lines.forEach((v) => {
            x.push(`${" ".repeat(40)} > ${v}`);
          });
      else
        for (const w of P) {
          if (w.type === "equal") continue;
          const C = (w.line1 ?? 0) + 1, v = (w.line2 ?? 0) + 1;
          w.type === "delete" ? (x.push(`${C},${C + w.lines.length - 1}d${v - 1}`), w.lines.forEach((F) => x.push(`< ${F}`))) : w.type === "add" && (x.push(`${C - 1}a${v},${v + w.lines.length - 1}`), w.lines.forEach((F) => x.push(`> ${F}`)));
        }
      return { stdout: x.join(`
`) + (x.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (u) {
      return { stdout: "", stderr: `diff: ${u instanceof Error ? u.message : u}
`, exitCode: 2 };
    }
  }
};
function X(s, t, e = {}) {
  const r = s.length, o = t.length, n = (f) => {
    let d = f;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(r + 1).fill(0).map(() => Array(o + 1).fill(0));
  for (let f = 1; f <= r; f++)
    for (let d = 1; d <= o; d++)
      n(s[f - 1]) === n(t[d - 1]) ? a[f][d] = a[f - 1][d - 1] + 1 : a[f][d] = Math.max(a[f - 1][d], a[f][d - 1]);
  const i = [];
  let c = r, l = o;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && n(s[c - 1]) === n(t[l - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(s[c - 1]) : i.push({ type: "equal", lines: [s[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(t[l - 1]) : i.push({ type: "add", lines: [t[l - 1]], line1: c, line2: l - 1 }), l--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(s[c - 1]) : i.push({ type: "delete", lines: [s[c - 1]], line1: c - 1, line2: l }), c--);
  return i.reverse();
}
const K = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(s) {
    if (s.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const t = s[0].replace(/\/+$/, ""), e = t.lastIndexOf("/");
    return { stdout: (e === -1 ? "." : e === 0 ? "/" : t.slice(0, e)) + `
`, stderr: "", exitCode: 0 };
  }
}, Q = {
  name: "echo",
  description: "Display text",
  async exec(s) {
    const { flags: t } = S(s), e = t.n, r = s.filter((n) => n !== "-n" && n !== "-e").join(" ");
    let o = t.e ? r.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : r;
    return e || (o += `
`), { stdout: o, stderr: "", exitCode: 0 };
  }
}, tt = {
  name: "env",
  description: "Print environment variables",
  async exec(s, t) {
    return { stdout: Object.entries(t.env).map(([r, o]) => `${r}=${o}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, et = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(s, t) {
    if (s.length === 0)
      return { stdout: Object.entries(t.env).map(([n, a]) => `export ${n}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], r = [];
    for (const o of s) {
      const n = o.indexOf("=");
      if (n === -1) {
        const a = o;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          r.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in t.env ? e.push(`export ${a}="${t.env[a]}"`) : e.push(`export ${a}=""`);
      } else {
        const a = o.slice(0, n);
        let i = o.slice(n + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          r.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        (i.startsWith('"') && i.endsWith('"') || i.startsWith("'") && i.endsWith("'")) && (i = i.slice(1, -1)), t.env[a] = i, e.push(`export ${a}="${i}"`);
      }
    }
    return r.length > 0 ? {
      stdout: "",
      stderr: r.join(`
`) + `
`,
      exitCode: 1
    } : { stdout: "", stderr: "", exitCode: 0 };
  }
}, st = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, nt = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(s, t) {
    const { values: e, positional: r, flags: o } = S(s, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), n = r[0] ?? ".", a = e.name, i = e.iname, c = e.path, l = e.type, f = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, g = e.exec, p = o.print !== !1, u = t.fs.resolvePath(n, t.cwd), h = [], m = [];
    let y;
    if (a) {
      const w = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      y = new RegExp(`^${w}$`);
    }
    let E;
    if (i) {
      const w = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      E = new RegExp(`^${w}$`, "i");
    }
    let $;
    if (c) {
      const w = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      $ = new RegExp(w);
    }
    async function P(w, C, v) {
      let F;
      try {
        F = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const b of F) {
        const M = w + "/" + b.name, k = C ? C + "/" + b.name : b.name, R = n === "." ? "./" + k : n + "/" + k, I = v + 1;
        let j = !0;
        if (!(I > f)) {
          if (I < d && (j = !1), y && !y.test(b.name) && (j = !1), E && !E.test(b.name) && (j = !1), $ && !$.test(R) && (j = !1), l === "f" && b.type !== "file" && (j = !1), l === "d" && b.type !== "dir" && (j = !1), j && (p && h.push(R), g)) {
            const T = g.replace(/\{\}/g, R);
            m.push(`Executing: ${T}`);
          }
          b.type === "dir" && I < f && await P(M, k, I);
        }
      }
    }
    0 >= d && (!l || l === "d") && !y && !E && !$ && p && h.push(n === "." ? "." : n), await P(u, "", 0);
    let x = "";
    return h.length > 0 && (x = h.join(`
`) + `
`), m.length > 0 && (x += m.join(`
`) + `
`), { stdout: x, stderr: "", exitCode: 0 };
  }
}, rt = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(s, t) {
    const { flags: e, values: r, positional: o } = S(s, ["e"]), n = !!e.i, a = !!e.v, i = !!e.c, c = !!e.l, l = !!e.n, f = !!(e.r || e.R), d = r.e ?? o.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const g = n ? "i" : "";
    let p;
    try {
      p = new RegExp(d, g);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const u = o.length > 0 ? o : ["-"], h = u.length > 1 || f, m = [];
    let y = !1;
    async function E(x, w) {
      let C;
      try {
        if (x === "-")
          C = t.stdin;
        else {
          const b = t.fs.resolvePath(x, t.cwd);
          C = await t.fs.readFile(b);
        }
      } catch {
        m.push(`grep: ${x}: No such file or directory`);
        return;
      }
      const v = C.split(`
`);
      v.length > 0 && v[v.length - 1] === "" && v.pop();
      let F = 0;
      for (let b = 0; b < v.length; b++)
        if (p.test(v[b]) !== a && (y = !0, F++, !i && !c)) {
          const k = h ? `${w}:` : "", R = l ? `${b + 1}:` : "";
          m.push(`${k}${R}${v[b]}`);
        }
      i && m.push(h ? `${w}:${F}` : String(F)), c && F > 0 && m.push(w);
    }
    async function $(x) {
      const w = t.fs.resolvePath(x, t.cwd);
      let C;
      try {
        C = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const v of C) {
        const F = w + "/" + v.name;
        v.type === "dir" ? await $(F) : await E(F, F);
      }
    }
    for (const x of u)
      if (x === "-")
        await E("-", "(standard input)");
      else if (f) {
        const w = t.fs.resolvePath(x, t.cwd);
        let C;
        try {
          C = await t.fs.stat(w);
        } catch {
          continue;
        }
        C.type === "dir" ? await $(w) : await E(x, x);
      } else
        await E(x, x);
    return { stdout: m.length > 0 ? m.join(`
`) + `
` : "", stderr: "", exitCode: y ? 0 : 1 };
  }
}, ot = {
  name: "head",
  description: "Output the first part of files",
  async exec(s, t) {
    const { values: e, positional: r } = S(s, ["n"]), o = parseInt(e.n ?? "10", 10);
    try {
      const { content: n } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: n.split(`
`).slice(0, o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `head: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, it = {
  name: "hostname",
  description: "Print system hostname",
  async exec(s, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, at = {
  name: "less",
  description: "View file contents with pagination",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s);
    try {
      const { content: o } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), n = o.split(`
`), a = e.N || e.n;
      let i = "";
      return a ? i = n.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
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
}, ct = {
  name: "ln",
  description: "Make links between files",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.s;
    if (r.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(r[0], t.cwd), a = t.fs.resolvePath(r[1], t.cwd);
    try {
      if (o && t.fs.symlink)
        await t.fs.symlink(n, a);
      else {
        const i = await t.fs.readFile(n);
        await t.fs.writeFile(a, i);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `ln: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, lt = {
  name: "ls",
  description: "List directory contents",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = r.length > 0 ? r : ["."], n = e.a, a = e.l, i = e.h, c = [];
    for (const l of o) {
      const f = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(f);
      if (d.type === "file") {
        c.push(a ? q(f.split("/").pop(), d, i) : f.split("/").pop());
        continue;
      }
      o.length > 1 && c.push(`${l}:`);
      const g = await t.fs.readdir(f), p = n ? g : g.filter((u) => !u.name.startsWith("."));
      if (p.sort((u, h) => u.name.localeCompare(h.name)), a) {
        c.push(`total ${p.length}`);
        for (const u of p)
          c.push(q(u.name, u, i));
      } else
        c.push(p.map((u) => u.type === "dir" ? u.name + "/" : u.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function q(s, t, e) {
  const r = t.type === "dir" ? "d" : "-", o = t.mode ?? (t.type === "dir" ? 493 : 420), n = dt(o), a = e ? ut(t.size) : String(t.size).padStart(8), i = new Date(t.mtime), c = ft(i);
  return `${r}${n}  1 user user ${a} ${c} ${s}`;
}
function dt(s) {
  let e = "";
  for (let r = 2; r >= 0; r--) {
    const o = s >> r * 3 & 7;
    for (let n = 2; n >= 0; n--)
      e += o & 1 << n ? "rwx"[2 - n] : "-";
  }
  return e;
}
function ft(s) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][s.getMonth()], r = String(s.getDate()).padStart(2), o = String(s.getHours()).padStart(2, "0"), n = String(s.getMinutes()).padStart(2, "0");
  return `${e} ${r} ${o}:${n}`;
}
function ut(s) {
  return s < 1024 ? String(s).padStart(5) : s < 1024 * 1024 ? (s / 1024).toFixed(1) + "K" : (s / (1024 * 1024)).toFixed(1) + "M";
}
const pt = {
  name: "mkdir",
  description: "Make directories",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.p;
    if (r.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const n of r) {
        const a = t.fs.resolvePath(n, t.cwd);
        await t.fs.mkdir(a, { recursive: o });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `mkdir: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, ht = {
  name: "mv",
  description: "Move or rename files",
  async exec(s, t) {
    const { positional: e } = S(s);
    if (e.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const r = t.fs.resolvePath(e[e.length - 1], t.cwd), o = e.slice(0, -1);
    let n = !1;
    try {
      n = (await t.fs.stat(r)).type === "dir";
    } catch {
    }
    if (o.length > 1 && !n)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const a of o) {
        const i = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), l = n ? r + "/" + c : r;
        await t.fs.rename(i, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, mt = {
  name: "printf",
  description: "Format and print data",
  async exec(s) {
    if (s.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = s[0], e = s.slice(1);
    let r = 0, o = "", n = 0;
    for (; n < t.length; )
      if (t[n] === "\\") {
        switch (n++, t[n]) {
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
            o += "\\" + (t[n] ?? "");
            break;
        }
        n++;
      } else if (t[n] === "%")
        if (n++, t[n] === "%")
          o += "%", n++;
        else {
          let a = "";
          for (; n < t.length && !/[sdf]/.test(t[n]); )
            a += t[n], n++;
          const i = t[n] ?? "s";
          n++;
          const c = e[r++] ?? "";
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
        o += t[n], n++;
    return { stdout: o, stderr: "", exitCode: 0 };
  }
}, gt = {
  name: "pwd",
  description: "Print working directory",
  async exec(s, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, xt = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.f;
    if (r.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(r[0], t.cwd);
    return o ? { stdout: n + `
`, stderr: "", exitCode: 0 } : { stdout: n + `
`, stderr: "", exitCode: 0 };
  }
}, wt = {
  name: "rm",
  description: "Remove files or directories",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.r || e.R, n = e.f;
    if (r.length === 0 && !n)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(i) {
      const c = await t.fs.readdir(i);
      for (const l of c) {
        const f = i + "/" + l.name;
        l.type === "dir" ? await a(f) : await t.fs.unlink(f);
      }
      await t.fs.rmdir(i);
    }
    try {
      for (const i of r) {
        const c = t.fs.resolvePath(i, t.cwd);
        let l;
        try {
          l = await t.fs.stat(c);
        } catch {
          if (n) continue;
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
      return n ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, yt = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.i, n = r.shift();
    if (!n)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = n.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${n}
`, exitCode: 1 };
    const [, , i, c, l] = a, f = l.includes("g"), d = l.includes("i");
    let g;
    try {
      const p = (f ? "g" : "") + (d ? "i" : "");
      g = new RegExp(i, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${i}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: u } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), h = p.split(`
`).map((m) => m.replace(g, c)).join(`
`);
      if (o && u.length > 0) {
        for (const m of u) {
          const y = t.fs.resolvePath(m, t.cwd), $ = (await t.fs.readFile(y)).split(`
`).map((P) => P.replace(g, c)).join(`
`);
          await t.fs.writeFile(y, $);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: h, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, vt = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(s, t) {
    const { flags: e, values: r, positional: o } = S(s, ["separator", "s", "format", "f"]);
    if (o.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let n = 1, a = 1, i;
    if (o.length === 1 ? i = parseFloat(o[0]) : o.length === 2 ? (n = parseFloat(o[0]), i = parseFloat(o[1])) : o.length >= 3 ? (n = parseFloat(o[0]), a = parseFloat(o[1]), i = parseFloat(o[2])) : i = 1, isNaN(n) || isNaN(a) || isNaN(i))
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
    const c = r.s || r.separator || `
`, l = r.f || r.format, f = e.w, d = [];
    if (a > 0)
      for (let u = n; u <= i; u += a)
        d.push(String(u));
    else
      for (let u = n; u >= i; u += a)
        d.push(String(u));
    if (f) {
      const u = Math.max(...d.map((h) => h.length));
      for (let h = 0; h < d.length; h++)
        d[h] = d[h].padStart(u, "0");
    }
    if (l && typeof l == "string")
      for (let u = 0; u < d.length; u++) {
        const h = parseFloat(d[u]);
        l.includes("%g") || l.includes("%d") || l.includes("%i") ? d[u] = l.replace(/%[gdi]/, String(h)) : l.includes("%f") ? d[u] = l.replace(/%f/, h.toFixed(6)) : l.includes("%e") && (d[u] = l.replace(/%e/, h.toExponential()));
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
}, Ct = {
  name: "sort",
  description: "Sort lines of text",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s);
    try {
      const { content: o } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let n = o.split(`
`).filter(Boolean);
      return e.n ? n.sort((a, i) => parseFloat(a) - parseFloat(i)) : n.sort(), e.u && (n = [...new Set(n)]), e.r && n.reverse(), { stdout: n.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `sort: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, $t = {
  name: "tail",
  description: "Output the last part of files",
  async exec(s, t) {
    const { values: e, positional: r } = S(s, ["n"]), o = parseInt(e.n ?? "10", 10);
    try {
      const { content: n } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: n.split(`
`).slice(-o).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `tail: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, St = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(s, t) {
    const { flags: e, values: r, positional: o } = S(s, ["f", "C"]), n = e.c || e.create, a = e.x || e.extract, i = e.t || e.list, c = e.v || e.verbose, l = r.f, f = r.C;
    let d = t.cwd;
    f && (d = t.fs.resolvePath(f, t.cwd));
    const g = [n, a, i].filter(Boolean).length;
    if (g === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (g > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (n) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = o;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const u = [];
        async function h($, P) {
          const x = t.fs.resolvePath($, d);
          if ((await t.fs.stat(x)).type === "dir") {
            u.push({ path: P + "/", content: "", isDir: !0 });
            const C = await t.fs.readdir(x);
            for (const v of C)
              await h(x + "/" + v.name, P + "/" + v.name);
          } else {
            const C = await t.fs.readFile(x);
            u.push({ path: P, content: C, isDir: !1 });
          }
        }
        for (const $ of p)
          await h($, $);
        const m = ["FLUFFY-TAR-V1"];
        for (const $ of u)
          c && (t.stderr || console.error($.path)), m.push(`FILE:${$.path}`), m.push(`SIZE:${$.content.length}`), m.push(`TYPE:${$.isDir ? "dir" : "file"}`), m.push("DATA-START"), m.push($.content), m.push("DATA-END");
        const y = m.join(`
`), E = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(E, y), {
          stdout: c ? u.map(($) => $.path).join(`
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
        const p = t.fs.resolvePath(l, t.cwd), h = (await t.fs.readFile(p)).split(`
`);
        if (h[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let m = 1;
        const y = [];
        for (; m < h.length && h[m].startsWith("FILE:"); ) {
          const E = h[m].slice(5), $ = parseInt(h[m + 1].slice(5), 10), P = h[m + 2].slice(5);
          m += 4;
          const x = [];
          for (; m < h.length && h[m] !== "DATA-END"; )
            x.push(h[m]), m++;
          const w = x.join(`
`);
          m++;
          const C = t.fs.resolvePath(E, d);
          if (P === "dir")
            await t.fs.mkdir(C, { recursive: !0 });
          else {
            const v = C.lastIndexOf("/");
            if (v > 0) {
              const F = C.slice(0, v);
              try {
                await t.fs.mkdir(F, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(C, w);
          }
          y.push(E), c && (t.stderr || console.error(E));
        }
        return {
          stdout: c ? y.join(`
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
        const p = t.fs.resolvePath(l, t.cwd), h = (await t.fs.readFile(p)).split(`
`);
        if (h[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        const m = [];
        for (let y = 1; y < h.length; y++)
          h[y].startsWith("FILE:") && m.push(h[y].slice(5));
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
}, Et = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.a, n = t.stdin;
    try {
      for (const a of r) {
        const i = t.fs.resolvePath(a, t.cwd);
        if (o) {
          let c = "";
          try {
            c = await t.fs.readFile(i);
          } catch {
          }
          await t.fs.writeFile(i, c + n);
        } else
          await t.fs.writeFile(i, n);
      }
      return { stdout: n, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: n, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, Pt = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(s, t) {
    const e = s[s.length - 1] === "]" ? s.slice(0, -1) : [...s];
    try {
      return { stdout: "", stderr: "", exitCode: await D(e, t) ? 0 : 1 };
    } catch (r) {
      return { stdout: "", stderr: `test: ${r instanceof Error ? r.message : r}
`, exitCode: 2 };
    }
  }
};
async function D(s, t) {
  if (s.length === 0) return !1;
  if (s.length === 1) return s[0] !== "";
  if (s.length === 2) {
    const [o, n] = s;
    switch (o) {
      case "-z":
        return n === "";
      case "-n":
        return n !== "";
      case "!":
        return n === "";
      case "-e":
      case "-f":
      case "-d":
        try {
          const a = t.fs.resolvePath(n, t.cwd), i = await t.fs.stat(a);
          return o === "-f" ? i.type === "file" : o === "-d" ? i.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (s[0] === "!" && s.length > 1)
    return !await D(s.slice(1), t);
  if (s.length === 3) {
    const [o, n, a] = s;
    switch (n) {
      case "=":
      case "==":
        return o === a;
      case "!=":
        return o !== a;
      case "-eq":
        return parseInt(o) === parseInt(a);
      case "-ne":
        return parseInt(o) !== parseInt(a);
      case "-lt":
        return parseInt(o) < parseInt(a);
      case "-le":
        return parseInt(o) <= parseInt(a);
      case "-gt":
        return parseInt(o) > parseInt(a);
      case "-ge":
        return parseInt(o) >= parseInt(a);
    }
  }
  const e = s.indexOf("-a");
  if (e > 0)
    return await D(s.slice(0, e), t) && await D(s.slice(e + 1), t);
  const r = s.indexOf("-o");
  return r > 0 ? await D(s.slice(0, r), t) || await D(s.slice(r + 1), t) : !1;
}
const Ft = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(s, t) {
    const { positional: e } = S(s);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const r of e) {
        const o = t.fs.resolvePath(r, t.cwd);
        try {
          await t.fs.stat(o);
          const n = await t.fs.readFile(o);
          await t.fs.writeFile(o, n);
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
}, It = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.d, n = e.s, a = L(r[0] ?? ""), i = L(r[1] ?? ""), c = t.stdin;
    let l;
    if (o) {
      const f = new Set(a.split(""));
      l = c.split("").filter((d) => !f.has(d)).join("");
    } else if (a && i) {
      const f = /* @__PURE__ */ new Map();
      for (let d = 0; d < a.length; d++)
        f.set(a[d], i[Math.min(d, i.length - 1)]);
      l = c.split("").map((d) => f.get(d) ?? d).join("");
    } else
      l = c;
    if (n && i) {
      const f = new Set(i.split(""));
      let d = "", g = "";
      for (const p of l)
        f.has(p) && p === g || (d += p, g = p);
      l = d;
    }
    return { stdout: l, stderr: "", exitCode: 0 };
  }
};
function L(s) {
  let t = s;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let e = "", r = 0;
  for (; r < t.length; )
    if (r + 2 < t.length && t[r + 1] === "-") {
      const o = t.charCodeAt(r), n = t.charCodeAt(r + 2);
      for (let a = o; a <= n; a++)
        e += String.fromCharCode(a);
      r += 3;
    } else
      e += t[r], r++;
  return e;
}
const bt = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, jt = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s);
    try {
      const { content: o } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), n = o.split(`
`);
      n.length > 0 && n[n.length - 1] === "" && n.pop();
      const a = [];
      let i = "", c = 0;
      for (const l of n)
        l === i ? c++ : (c > 0 && O(i, c, e, a), i = l, c = 1);
      return c > 0 && O(i, c, e, a), { stdout: a.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `uniq: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
};
function O(s, t, e, r) {
  e.d && t < 2 || (e.c ? r.push(`${String(t).padStart(7)} ${s}`) : r.push(s));
}
const At = {
  name: "uname",
  description: "Print system information",
  async exec(s, t) {
    const { flags: e } = S(s), r = e.a, o = t.env.UNAME_SYSNAME ?? "FluffyOS", n = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", i = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (r)
      return { stdout: `${o} ${n} ${a} ${i} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: o + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(o), e.n && l.push(n), e.r && l.push(a), e.v && l.push(i), e.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, kt = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.l, n = e.w, a = e.c, i = !o && !n && !a;
    try {
      const { content: c, files: l } = await A(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), f = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, g = c.length, p = [];
      return (i || o) && p.push(String(f).padStart(6)), (i || n) && p.push(String(d).padStart(6)), (i || a) && p.push(String(g).padStart(6)), l.length === 1 && p.push(" " + r[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Rt = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(s, t) {
    const { flags: e, positional: r } = S(s), o = e.a;
    if (r.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const n = r[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = a.split(":"), c = [];
    for (const l of i) {
      const f = `${l}/${n}`;
      try {
        if (await t.fs.exists(f) && (await t.fs.stat(f)).type === "file" && (c.push(f), !o))
          break;
      } catch {
        continue;
      }
    }
    return c.length === 0 ? {
      stdout: "",
      stderr: `which: no ${n} in (${a})
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
}, Tt = {
  name: "whoami",
  description: "Print current user name",
  async exec(s, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, Dt = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(s, t) {
    const { flags: e, positional: r, values: o } = S(s, ["n", "I", "i", "d", "delimiter"]), n = e.I || e.L || e.l, a = o.I || o.i, i = o.n ? parseInt(o.n) : void 0, c = o.d || o.delimiter || /\s+/, l = e.t || e.verbose, f = e.r, d = r.length > 0 ? r.join(" ") : "echo";
    let g;
    if (typeof c == "string" ? g = t.stdin.split(c).filter(Boolean) : g = t.stdin.trim().split(c).filter(Boolean), g.length === 0) {
      if (f)
        return { stdout: "", stderr: "", exitCode: 0 };
      g = [""];
    }
    const p = [], u = [];
    if (a) {
      const h = typeof a == "string" ? a : "{}";
      for (const m of g) {
        const y = d.replace(new RegExp(Mt(h), "g"), m);
        u.push(y), l && p.push(`+ ${y}`);
      }
    } else if (i)
      for (let h = 0; h < g.length; h += i) {
        const m = g.slice(h, h + i), y = `${d} ${m.map(N).join(" ")}`;
        u.push(y), l && p.push(`+ ${y}`);
      }
    else if (n)
      for (const h of g) {
        const m = `${d} ${N(h)}`;
        u.push(m), l && p.push(`+ ${m}`);
      }
    else {
      const h = d === "echo" ? g.join(" ") : `${d} ${g.map(N).join(" ")}`;
      u.push(h), l && p.push(`+ ${h}`);
    }
    return d === "echo" && !a && !i ? p.push(...g) : p.push(...u), {
      stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function N(s) {
  return /[^a-zA-Z0-9._\-/=]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}
function Mt(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Nt = {
  basename: W,
  cat: U,
  chmod: z,
  clear: H,
  cp: _,
  curl: B,
  cut: Y,
  date: Z,
  diff: G,
  dirname: K,
  echo: Q,
  env: tt,
  export: et,
  false: st,
  find: nt,
  grep: rt,
  head: ot,
  hostname: it,
  less: at,
  ln: ct,
  ls: lt,
  mkdir: pt,
  mv: ht,
  printf: mt,
  pwd: gt,
  readlink: xt,
  rm: wt,
  sed: yt,
  seq: vt,
  sort: Ct,
  tail: $t,
  tar: St,
  tee: Et,
  test: Pt,
  touch: Ft,
  tr: It,
  true: bt,
  uniq: jt,
  uname: At,
  wc: kt,
  which: Rt,
  whoami: Tt,
  xargs: Dt
}, qt = Object.values(Nt);
export {
  Nt as allCommands,
  W as basename,
  U as cat,
  z as chmod,
  H as clear,
  qt as commandList,
  _ as cp,
  B as curl,
  Y as cut,
  Z as date,
  G as diff,
  K as dirname,
  Q as echo,
  tt as env,
  et as exportCmd,
  st as false,
  nt as find,
  rt as grep,
  ot as head,
  it as hostname,
  at as less,
  ct as ln,
  lt as ls,
  pt as mkdir,
  ht as mv,
  mt as printf,
  gt as pwd,
  xt as readlink,
  wt as rm,
  yt as sed,
  vt as seq,
  Ct as sort,
  $t as tail,
  St as tar,
  Et as tee,
  Pt as test,
  Ft as touch,
  It as tr,
  bt as true,
  At as uname,
  jt as uniq,
  kt as wc,
  Rt as which,
  Tt as whoami,
  Dt as xargs
};
