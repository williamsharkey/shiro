function C(i, t = []) {
  const e = {}, o = {}, s = [], n = new Set(t);
  for (let a = 0; a < i.length; a++) {
    const r = i[a];
    if (r === "--") {
      s.push(...i.slice(a + 1));
      break;
    }
    if (r.startsWith("--")) {
      const c = r.slice(2);
      n.has(c) && a + 1 < i.length ? o[c] = i[++a] : e[c] = !0;
    } else if (r.startsWith("-") && r.length > 1 && !/^-\d/.test(r)) {
      const c = r.slice(1);
      if (n.has(c) && a + 1 < i.length)
        o[c] = i[++a];
      else
        for (let l = 0; l < c.length; l++) {
          const u = c[l];
          if (n.has(u)) {
            const d = c.slice(l + 1);
            d ? o[u] = d : a + 1 < i.length && (o[u] = i[++a]);
            break;
          }
          e[u] = !0;
        }
    } else
      s.push(r);
  }
  return { flags: e, values: o, positional: s };
}
async function k(i, t, e, o, s) {
  if (i.length === 0)
    return { content: t, files: [] };
  const n = [], a = [];
  for (const r of i) {
    const c = s(r, o);
    n.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: n };
}
const z = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(i, t) {
    const { values: e, positional: o } = C(i, ["F", "v"]);
    if (o.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const s = o[0], n = o.slice(1), a = e.F || /\s+/, r = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (e.v) {
      const l = e.v.split("=");
      l.length === 2 && (c[l[0]] = l[1]);
    }
    try {
      const { content: l } = await k(
        n,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = l.split(`
`).filter((x) => x !== "" || l.endsWith(`
`)), d = [], h = s.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), p = s.match(/END\s*\{\s*([^}]*)\s*\}/), f = s.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let m = 0, g = 0;
      if (h) {
        const x = D(h[1], [], 0, 0, c);
        x && d.push(x);
      }
      for (const x of u) {
        m++;
        const b = x.split(r).filter((v) => v !== "");
        g = b.length;
        let $ = !0;
        if (f) {
          const v = f[1], y = f[2];
          if (v)
            try {
              $ = new RegExp(v).test(x);
            } catch {
              $ = !1;
            }
          if ($) {
            const w = D(y, b, m, g, c);
            w !== null && d.push(w);
          }
        } else if (!h && !p) {
          const v = D(s, b, m, g, c);
          v !== null && d.push(v);
        }
      }
      if (p) {
        const x = D(p[1], [], m, 0, c);
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
function D(i, t, e, o, s) {
  let n = i.trim();
  if (n.startsWith("print")) {
    const a = n.substring(5).trim();
    if (!a || a === "")
      return t.join(" ");
    let r = a;
    r = r.replace(/\$0/g, t.join(" ")), r = r.replace(/\$NF/g, t[t.length - 1] || "");
    for (let c = 1; c <= t.length; c++)
      r = r.replace(new RegExp(`\\$${c}`, "g"), t[c - 1] || "");
    r = r.replace(/\bNR\b/g, String(e)), r = r.replace(/\bNF\b/g, String(o));
    for (const [c, l] of Object.entries(s))
      r = r.replace(new RegExp(`\\b${c}\\b`, "g"), l);
    return r = r.replace(/^["'](.*)["']$/, "$1"), r = r.replace(/\s+/g, " ").trim(), r;
  }
  return null;
}
const U = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(i) {
    if (i.length === 0)
      return { stdout: "", stderr: `basename: missing operand
`, exitCode: 1 };
    let t = i[0].replace(/\/+$/, "").split("/").pop() || "/";
    return i.length > 1 && t.endsWith(i[1]) && (t = t.slice(0, -i[1].length)), { stdout: t + `
`, stderr: "", exitCode: 0 };
  }
}, H = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i);
    try {
      const { content: s } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return e.n ? { stdout: s.split(`
`).map((r, c) => `${String(c + 1).padStart(6)}	${r}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: s, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `cat: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, B = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.R;
    if (o.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const n = o[0], a = o.slice(1), r = parseInt(n, 8);
    if (isNaN(r))
      return { stdout: "", stderr: `chmod: invalid mode: '${n}'
`, exitCode: 1 };
    async function c(l) {
      const u = t.fs.resolvePath(l, t.cwd);
      if (s)
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const h = await t.fs.readdir(u);
            for (const p of h)
              await c(u + "/" + p.name);
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
}, _ = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, Y = {
  name: "cp",
  description: "Copy files and directories",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.r || e.R;
    if (o.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(o[o.length - 1], t.cwd), a = o.slice(0, -1);
    let r = !1;
    try {
      r = (await t.fs.stat(n)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !r)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(u, d) {
      const h = await t.fs.readFile(u);
      await t.fs.writeFile(d, h);
    }
    async function l(u, d) {
      await t.fs.mkdir(d, { recursive: !0 });
      const h = await t.fs.readdir(u);
      for (const p of h) {
        const f = u + "/" + p.name, m = d + "/" + p.name;
        p.type === "dir" ? await l(f, m) : await c(f, m);
      }
    }
    try {
      for (const u of a) {
        const d = t.fs.resolvePath(u, t.cwd), h = await t.fs.stat(d), p = u.split("/").pop(), f = r ? n + "/" + p : n;
        if (h.type === "dir") {
          if (!s)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${u}'
`, exitCode: 1 };
          await l(d, f);
        } else
          await c(d, f);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `cp: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, V = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(i, t) {
    const { flags: e, values: o, positional: s } = C(i, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (s.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const n = s[0], a = o.X || o.request || (o.d || o.data ? "POST" : "GET"), r = o.o || o.output, c = e.s || e.silent, l = e.i || e.include, u = e.I || e.head, d = e.L || e.location, h = {}, p = o.H || o.header;
    if (p) {
      const g = p.split(":");
      g.length >= 2 && (h[g[0].trim()] = g.slice(1).join(":").trim());
    }
    const f = o["user-agent"] || "fluffycoreutils-curl/0.1.0";
    h["User-Agent"] = f;
    let m;
    (o.d || o.data) && (m = o.d || o.data, h["Content-Type"] || (h["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const g = {
        method: u ? "HEAD" : a,
        headers: h,
        redirect: d ? "follow" : "manual"
      };
      m && a !== "GET" && a !== "HEAD" && (g.body = m);
      const x = await fetch(n, g);
      let b = "";
      if ((l || u) && (b += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach(($, v) => {
        b += `${v}: ${$}
`;
      }), b += `
`), !u) {
        const $ = await x.text();
        b += $;
      }
      if (r) {
        const $ = t.fs.resolvePath(r, t.cwd);
        return await t.fs.writeFile($, u ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${b.length}  100  ${b.length}    0     0   ${b.length}      0 --:--:-- --:--:-- --:--:--  ${b.length}
`,
          exitCode: 0
        };
      }
      return !c && !x.ok ? {
        stdout: b,
        stderr: `curl: (22) The requested URL returned error: ${x.status}
`,
        exitCode: 22
      } : { stdout: b, stderr: "", exitCode: 0 };
    } catch (g) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${g instanceof Error ? g.message : String(g)}
`,
        exitCode: 6
      };
    }
  }
}, Z = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(i, t) {
    const { values: e, positional: o } = C(i, ["d", "f", "c"]), s = e.d ?? "	", n = e.f, a = e.c;
    if (!n && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: r } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = G(n ?? a), l = r.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const u = [];
      for (const d of l)
        if (n) {
          const h = d.split(s), p = c.flatMap((f) => h.slice(f.start - 1, f.end)).filter((f) => f !== void 0);
          u.push(p.join(s));
        } else {
          const h = d.split(""), p = c.flatMap((f) => h.slice(f.start - 1, f.end)).filter((f) => f !== void 0);
          u.push(p.join(""));
        }
      return { stdout: u.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `cut: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
};
function G(i) {
  return i.split(",").map((t) => {
    if (t.includes("-")) {
      const [o, s] = t.split("-");
      return {
        start: o ? parseInt(o, 10) : 1,
        end: s ? parseInt(s, 10) : 1 / 0
      };
    }
    const e = parseInt(t, 10);
    return { start: e, end: e };
  });
}
const J = {
  name: "date",
  description: "Display date and time",
  async exec(i) {
    const t = /* @__PURE__ */ new Date();
    if (i.length > 0 && i[0].startsWith("+")) {
      const e = i[0].slice(1);
      return { stdout: X(t, e) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: t.toString() + `
`, stderr: "", exitCode: 0 };
  }
};
function X(i, t) {
  const e = (o) => String(o).padStart(2, "0");
  return t.replace(/%Y/g, String(i.getFullYear())).replace(/%m/g, e(i.getMonth() + 1)).replace(/%d/g, e(i.getDate())).replace(/%H/g, e(i.getHours())).replace(/%M/g, e(i.getMinutes())).replace(/%S/g, e(i.getSeconds())).replace(/%s/g, String(Math.floor(i.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const K = {
  name: "diff",
  description: "Compare files line by line",
  async exec(i, t) {
    var h, p;
    const { flags: e, positional: o, values: s } = C(i, ["U", "context", "C"]), n = e.u || s.U !== void 0, a = s.U || s.context || s.C || (e.u ? 3 : 0), r = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, l = e.i, u = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (o.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const f = t.fs.resolvePath(o[0], t.cwd), m = t.fs.resolvePath(o[1], t.cwd), g = await t.fs.readFile(f), x = await t.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${o[0]} and ${o[1]} differ
`, stderr: "", exitCode: 1 };
      const b = g.split(`
`), $ = x.split(`
`), v = Q(b, $, { ignoreCase: l, ignoreWhitespace: u }), y = [];
      if (n) {
        y.push(`--- ${o[0]}`), y.push(`+++ ${o[1]}`);
        let w = 0;
        for (; w < v.length; ) {
          if (v[w].type === "equal") {
            w++;
            continue;
          }
          const S = Math.max(0, w - 1);
          let F = w;
          for (; F < v.length; ) {
            const P = v[F];
            if (P.type !== "equal")
              F++;
            else if (P.lines.length <= r * 2)
              F++;
            else
              break;
          }
          const j = (((h = v[S]) == null ? void 0 : h.line1) ?? 0) + 1, M = (((p = v[S]) == null ? void 0 : p.line2) ?? 0) + 1;
          let R = 0, A = 0;
          for (let P = S; P < F; P++)
            (v[P].type === "equal" || v[P].type === "delete") && (R += v[P].lines.length), (v[P].type === "equal" || v[P].type === "add") && (A += v[P].lines.length);
          y.push(`@@ -${j},${R} +${M},${A} @@`);
          for (let P = S; P < F; P++) {
            const I = v[P];
            I.type === "equal" ? I.lines.forEach((T) => y.push(` ${T}`)) : I.type === "delete" ? I.lines.forEach((T) => y.push(`-${T}`)) : I.type === "add" && I.lines.forEach((T) => y.push(`+${T}`));
          }
          w = F;
        }
      } else if (d)
        for (const E of v)
          E.type === "equal" ? E.lines.forEach((S) => {
            const F = S.substring(0, 40).padEnd(40);
            y.push(`${F} | ${S}`);
          }) : E.type === "delete" ? E.lines.forEach((S) => {
            const F = S.substring(0, 40).padEnd(40);
            y.push(`${F} <`);
          }) : E.type === "add" && E.lines.forEach((S) => {
            y.push(`${" ".repeat(40)} > ${S}`);
          });
      else
        for (const w of v) {
          if (w.type === "equal") continue;
          const E = (w.line1 ?? 0) + 1, S = (w.line2 ?? 0) + 1;
          w.type === "delete" ? (y.push(`${E},${E + w.lines.length - 1}d${S - 1}`), w.lines.forEach((F) => y.push(`< ${F}`))) : w.type === "add" && (y.push(`${E - 1}a${S},${S + w.lines.length - 1}`), w.lines.forEach((F) => y.push(`> ${F}`)));
        }
      return { stdout: y.join(`
`) + (y.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (f) {
      return { stdout: "", stderr: `diff: ${f instanceof Error ? f.message : f}
`, exitCode: 2 };
    }
  }
};
function Q(i, t, e = {}) {
  const o = i.length, s = t.length, n = (u) => {
    let d = u;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(o + 1).fill(0).map(() => Array(s + 1).fill(0));
  for (let u = 1; u <= o; u++)
    for (let d = 1; d <= s; d++)
      n(i[u - 1]) === n(t[d - 1]) ? a[u][d] = a[u - 1][d - 1] + 1 : a[u][d] = Math.max(a[u - 1][d], a[u][d - 1]);
  const r = [];
  let c = o, l = s;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && n(i[c - 1]) === n(t[l - 1]) ? (r.length > 0 && r[r.length - 1].type === "equal" ? r[r.length - 1].lines.unshift(i[c - 1]) : r.push({ type: "equal", lines: [i[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (r.length > 0 && r[r.length - 1].type === "add" ? r[r.length - 1].lines.unshift(t[l - 1]) : r.push({ type: "add", lines: [t[l - 1]], line1: c, line2: l - 1 }), l--) : (r.length > 0 && r[r.length - 1].type === "delete" ? r[r.length - 1].lines.unshift(i[c - 1]) : r.push({ type: "delete", lines: [i[c - 1]], line1: c - 1, line2: l }), c--);
  return r.reverse();
}
const tt = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(i) {
    if (i.length === 0)
      return { stdout: "", stderr: `dirname: missing operand
`, exitCode: 1 };
    const t = i[0].replace(/\/+$/, ""), e = t.lastIndexOf("/");
    return { stdout: (e === -1 ? "." : e === 0 ? "/" : t.slice(0, e)) + `
`, stderr: "", exitCode: 0 };
  }
}, et = {
  name: "echo",
  description: "Display text",
  async exec(i) {
    const { flags: t } = C(i), e = t.n, o = i.filter((n) => n !== "-n" && n !== "-e").join(" ");
    let s = t.e ? o.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : o;
    return e || (s += `
`), { stdout: s, stderr: "", exitCode: 0 };
  }
}, st = {
  name: "env",
  description: "Print environment variables",
  async exec(i, t) {
    return { stdout: Object.entries(t.env).map(([o, s]) => `${o}=${s}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, nt = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(i, t) {
    const { values: e, positional: o, flags: s } = C(i, ["t", "tabs"]), n = e.t || e.tabs || "8", a = parseInt(n, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${n}'
`,
        exitCode: 1
      };
    const r = s.i || s.initial;
    try {
      const { content: c } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), l = c.split(`
`), u = [];
      for (const d of l) {
        let h = "", p = 0;
        for (let f = 0; f < d.length; f++) {
          const m = d[f];
          if (m === "	")
            if (!r || r && h.trim() === "") {
              const g = a - p % a;
              h += " ".repeat(g), p += g;
            } else
              h += m, p++;
          else
            h += m, p++;
        }
        u.push(h);
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
}, rt = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(i, t) {
    if (i.length === 0)
      return { stdout: Object.entries(t.env).map(([n, a]) => `export ${n}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], o = [];
    for (const s of i) {
      const n = s.indexOf("=");
      if (n === -1) {
        const a = s;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          o.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in t.env ? e.push(`export ${a}="${t.env[a]}"`) : e.push(`export ${a}=""`);
      } else {
        const a = s.slice(0, n);
        let r = s.slice(n + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          o.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        (r.startsWith('"') && r.endsWith('"') || r.startsWith("'") && r.endsWith("'")) && (r = r.slice(1, -1)), t.env[a] = r, e.push(`export ${a}="${r}"`);
      }
    }
    return o.length > 0 ? {
      stdout: "",
      stderr: o.join(`
`) + `
`,
      exitCode: 1
    } : { stdout: "", stderr: "", exitCode: 0 };
  }
}, ot = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, it = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(i, t) {
    const { values: e, positional: o, flags: s } = C(i, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), n = o[0] ?? ".", a = e.name, r = e.iname, c = e.path, l = e.type, u = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, h = e.exec, p = s.print !== !1, f = t.fs.resolvePath(n, t.cwd), m = [], g = [];
    let x;
    if (a) {
      const w = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${w}$`);
    }
    let b;
    if (r) {
      const w = r.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      b = new RegExp(`^${w}$`, "i");
    }
    let $;
    if (c) {
      const w = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      $ = new RegExp(w);
    }
    async function v(w, E, S) {
      let F;
      try {
        F = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const j of F) {
        const M = w + "/" + j.name, R = E ? E + "/" + j.name : j.name, A = n === "." ? "./" + R : n + "/" + R, P = S + 1;
        let I = !0;
        if (!(P > u)) {
          if (P < d && (I = !1), x && !x.test(j.name) && (I = !1), b && !b.test(j.name) && (I = !1), $ && !$.test(A) && (I = !1), l === "f" && j.type !== "file" && (I = !1), l === "d" && j.type !== "dir" && (I = !1), I && (p && m.push(A), h)) {
            const T = h.replace(/\{\}/g, A);
            g.push(`Executing: ${T}`);
          }
          j.type === "dir" && P < u && await v(M, R, P);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !b && !$ && p && m.push(n === "." ? "." : n), await v(f, "", 0);
    let y = "";
    return m.length > 0 && (y = m.join(`
`) + `
`), g.length > 0 && (y += g.join(`
`) + `
`), { stdout: y, stderr: "", exitCode: 0 };
  }
}, at = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(i, t) {
    const { flags: e, values: o, positional: s } = C(i, ["e"]), n = !!e.i, a = !!e.v, r = !!e.c, c = !!e.l, l = !!e.n, u = !!(e.r || e.R), d = o.e ?? s.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const h = n ? "i" : "";
    let p;
    try {
      p = new RegExp(d, h);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const f = s.length > 0 ? s : ["-"], m = f.length > 1 || u, g = [];
    let x = !1;
    async function b(y, w) {
      let E;
      try {
        if (y === "-")
          E = t.stdin;
        else {
          const j = t.fs.resolvePath(y, t.cwd);
          E = await t.fs.readFile(j);
        }
      } catch {
        g.push(`grep: ${y}: No such file or directory`);
        return;
      }
      const S = E.split(`
`);
      S.length > 0 && S[S.length - 1] === "" && S.pop();
      let F = 0;
      for (let j = 0; j < S.length; j++)
        if (p.test(S[j]) !== a && (x = !0, F++, !r && !c)) {
          const R = m ? `${w}:` : "", A = l ? `${j + 1}:` : "";
          g.push(`${R}${A}${S[j]}`);
        }
      r && g.push(m ? `${w}:${F}` : String(F)), c && F > 0 && g.push(w);
    }
    async function $(y) {
      const w = t.fs.resolvePath(y, t.cwd);
      let E;
      try {
        E = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const S of E) {
        const F = w + "/" + S.name;
        S.type === "dir" ? await $(F) : await b(F, F);
      }
    }
    for (const y of f)
      if (y === "-")
        await b("-", "(standard input)");
      else if (u) {
        const w = t.fs.resolvePath(y, t.cwd);
        let E;
        try {
          E = await t.fs.stat(w);
        } catch {
          continue;
        }
        E.type === "dir" ? await $(w) : await b(y, y);
      } else
        await b(y, y);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, ct = {
  name: "head",
  description: "Output the first part of files",
  async exec(i, t) {
    const { values: e, positional: o } = C(i, ["n"]), s = parseInt(e.n ?? "10", 10);
    try {
      const { content: n } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: n.split(`
`).slice(0, s).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `head: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, lt = {
  name: "hostname",
  description: "Print system hostname",
  async exec(i, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, dt = {
  name: "less",
  description: "View file contents with pagination",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i);
    try {
      const { content: s } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), n = s.split(`
`), a = e.N || e.n;
      let r = "";
      return a ? r = n.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : r = s, r && !r.endsWith(`
`) && (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
    } catch (s) {
      return {
        stdout: "",
        stderr: `less: ${s instanceof Error ? s.message : s}
`,
        exitCode: 1
      };
    }
  }
}, ft = {
  name: "ln",
  description: "Make links between files",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.s;
    if (o.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(o[0], t.cwd), a = t.fs.resolvePath(o[1], t.cwd);
    try {
      if (s && t.fs.symlink)
        await t.fs.symlink(n, a);
      else {
        const r = await t.fs.readFile(n);
        await t.fs.writeFile(a, r);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `ln: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, ut = {
  name: "ls",
  description: "List directory contents",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = o.length > 0 ? o : ["."], n = e.a, a = e.l, r = e.h, c = [];
    for (const l of s) {
      const u = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(u);
      if (d.type === "file") {
        c.push(a ? L(u.split("/").pop(), d, r) : u.split("/").pop());
        continue;
      }
      s.length > 1 && c.push(`${l}:`);
      const h = await t.fs.readdir(u), p = n ? h : h.filter((f) => !f.name.startsWith("."));
      if (p.sort((f, m) => f.name.localeCompare(m.name)), a) {
        c.push(`total ${p.length}`);
        for (const f of p)
          c.push(L(f.name, f, r));
      } else
        c.push(p.map((f) => f.type === "dir" ? f.name + "/" : f.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function L(i, t, e) {
  const o = t.type === "dir" ? "d" : "-", s = t.mode ?? (t.type === "dir" ? 493 : 420), n = pt(s), a = e ? mt(t.size) : String(t.size).padStart(8), r = new Date(t.mtime), c = ht(r);
  return `${o}${n}  1 user user ${a} ${c} ${i}`;
}
function pt(i) {
  let e = "";
  for (let o = 2; o >= 0; o--) {
    const s = i >> o * 3 & 7;
    for (let n = 2; n >= 0; n--)
      e += s & 1 << n ? "rwx"[2 - n] : "-";
  }
  return e;
}
function ht(i) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i.getMonth()], o = String(i.getDate()).padStart(2), s = String(i.getHours()).padStart(2, "0"), n = String(i.getMinutes()).padStart(2, "0");
  return `${e} ${o} ${s}:${n}`;
}
function mt(i) {
  return i < 1024 ? String(i).padStart(5) : i < 1024 * 1024 ? (i / 1024).toFixed(1) + "K" : (i / (1024 * 1024)).toFixed(1) + "M";
}
const gt = {
  name: "mkdir",
  description: "Make directories",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.p;
    if (o.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const n of o) {
        const a = t.fs.resolvePath(n, t.cwd);
        await t.fs.mkdir(a, { recursive: s });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `mkdir: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, xt = {
  name: "mv",
  description: "Move or rename files",
  async exec(i, t) {
    const { positional: e } = C(i);
    if (e.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(e[e.length - 1], t.cwd), s = e.slice(0, -1);
    let n = !1;
    try {
      n = (await t.fs.stat(o)).type === "dir";
    } catch {
    }
    if (s.length > 1 && !n)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const a of s) {
        const r = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), l = n ? o + "/" + c : o;
        await t.fs.rename(r, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, wt = {
  name: "printf",
  description: "Format and print data",
  async exec(i) {
    if (i.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = i[0], e = i.slice(1);
    let o = 0, s = "", n = 0;
    for (; n < t.length; )
      if (t[n] === "\\") {
        switch (n++, t[n]) {
          case "n":
            s += `
`;
            break;
          case "t":
            s += "	";
            break;
          case "\\":
            s += "\\";
            break;
          case '"':
            s += '"';
            break;
          default:
            s += "\\" + (t[n] ?? "");
            break;
        }
        n++;
      } else if (t[n] === "%")
        if (n++, t[n] === "%")
          s += "%", n++;
        else {
          let a = "";
          for (; n < t.length && !/[sdf]/.test(t[n]); )
            a += t[n], n++;
          const r = t[n] ?? "s";
          n++;
          const c = e[o++] ?? "";
          switch (r) {
            case "s":
              s += c;
              break;
            case "d":
              s += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              s += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        s += t[n], n++;
    return { stdout: s, stderr: "", exitCode: 0 };
  }
}, yt = {
  name: "pwd",
  description: "Print working directory",
  async exec(i, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, vt = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.f;
    if (o.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const n = t.fs.resolvePath(o[0], t.cwd);
    return s ? { stdout: n + `
`, stderr: "", exitCode: 0 } : { stdout: n + `
`, stderr: "", exitCode: 0 };
  }
}, Ct = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i);
    if (o.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const s = e.q || e.quiet, n = !e.s;
    e.s;
    const a = [], r = [];
    for (const u of o)
      try {
        let d = t.fs.resolvePath(u, t.cwd);
        if (n) {
          const h = d.split("/").filter((f) => f !== "" && f !== "."), p = [];
          for (const f of h)
            f === ".." ? p.length > 0 && p.pop() : p.push(f);
          d = "/" + p.join("/");
        }
        await t.fs.exists(d) ? a.push(d) : s || r.push(`realpath: ${u}: No such file or directory`);
      } catch (d) {
        s || r.push(`realpath: ${u}: ${d instanceof Error ? d.message : d}`);
      }
    const c = r.length > 0 ? r.join(`
`) + `
` : "", l = r.length > 0 ? 1 : 0;
    return {
      stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
      stderr: c,
      exitCode: l
    };
  }
}, $t = {
  name: "rm",
  description: "Remove files or directories",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.r || e.R, n = e.f;
    if (o.length === 0 && !n)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(r) {
      const c = await t.fs.readdir(r);
      for (const l of c) {
        const u = r + "/" + l.name;
        l.type === "dir" ? await a(u) : await t.fs.unlink(u);
      }
      await t.fs.rmdir(r);
    }
    try {
      for (const r of o) {
        const c = t.fs.resolvePath(r, t.cwd);
        let l;
        try {
          l = await t.fs.stat(c);
        } catch {
          if (n) continue;
          return { stdout: "", stderr: `rm: cannot remove '${r}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!s)
            return { stdout: "", stderr: `rm: cannot remove '${r}': Is a directory
`, exitCode: 1 };
          await a(c);
        } else
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return n ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, St = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.i, n = o.shift();
    if (!n)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = n.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${n}
`, exitCode: 1 };
    const [, , r, c, l] = a, u = l.includes("g"), d = l.includes("i");
    let h;
    try {
      const p = (u ? "g" : "") + (d ? "i" : "");
      h = new RegExp(r, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${r}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: f } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), m = p.split(`
`).map((g) => g.replace(h, c)).join(`
`);
      if (s && f.length > 0) {
        for (const g of f) {
          const x = t.fs.resolvePath(g, t.cwd), $ = (await t.fs.readFile(x)).split(`
`).map((v) => v.replace(h, c)).join(`
`);
          await t.fs.writeFile(x, $);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, bt = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(i, t) {
    const { flags: e, values: o, positional: s } = C(i, ["separator", "s", "format", "f"]);
    if (s.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let n = 1, a = 1, r;
    if (s.length === 1 ? r = parseFloat(s[0]) : s.length === 2 ? (n = parseFloat(s[0]), r = parseFloat(s[1])) : s.length >= 3 ? (n = parseFloat(s[0]), a = parseFloat(s[1]), r = parseFloat(s[2])) : r = 1, isNaN(n) || isNaN(a) || isNaN(r))
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
    const c = o.s || o.separator || `
`, l = o.f || o.format, u = e.w, d = [];
    if (a > 0)
      for (let f = n; f <= r; f += a)
        d.push(String(f));
    else
      for (let f = n; f >= r; f += a)
        d.push(String(f));
    if (u) {
      const f = Math.max(...d.map((m) => m.length));
      for (let m = 0; m < d.length; m++)
        d[m] = d[m].padStart(f, "0");
    }
    if (l && typeof l == "string")
      for (let f = 0; f < d.length; f++) {
        const m = parseFloat(d[f]);
        l.includes("%g") || l.includes("%d") || l.includes("%i") ? d[f] = l.replace(/%[gdi]/, String(m)) : l.includes("%f") ? d[f] = l.replace(/%f/, m.toFixed(6)) : l.includes("%e") && (d[f] = l.replace(/%e/, m.toExponential()));
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
}, Et = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(i, t) {
    const { positional: e } = C(i);
    if (e.length === 0)
      return { stdout: "", stderr: `sleep: missing operand
`, exitCode: 1 };
    const o = e[0];
    let s = 0;
    const n = o.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
    if (!n)
      return {
        stdout: "",
        stderr: `sleep: invalid time interval '${o}'
`,
        exitCode: 1
      };
    const a = parseFloat(n[1]);
    switch (n[2] || "s") {
      case "s":
        s = a;
        break;
      case "m":
        s = a * 60;
        break;
      case "h":
        s = a * 3600;
        break;
      case "d":
        s = a * 86400;
        break;
    }
    return await new Promise((c) => globalThis.setTimeout(c, s * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, Ft = {
  name: "sort",
  description: "Sort lines of text",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i);
    try {
      const { content: s } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let n = s.split(`
`).filter(Boolean);
      return e.n ? n.sort((a, r) => parseFloat(a) - parseFloat(r)) : n.sort(), e.u && (n = [...new Set(n)]), e.r && n.reverse(), { stdout: n.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `sort: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, Pt = {
  name: "tail",
  description: "Output the last part of files",
  async exec(i, t) {
    const { values: e, positional: o } = C(i, ["n"]), s = parseInt(e.n ?? "10", 10);
    try {
      const { content: n } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: n.split(`
`).slice(-s).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `tail: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, jt = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(i, t) {
    const { flags: e, values: o, positional: s } = C(i, ["f", "C"]), n = e.c || e.create, a = e.x || e.extract, r = e.t || e.list, c = e.v || e.verbose, l = o.f, u = o.C;
    let d = t.cwd;
    u && (d = t.fs.resolvePath(u, t.cwd));
    const h = [n, a, r].filter(Boolean).length;
    if (h === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (h > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (n) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = s;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const f = [];
        async function m($, v) {
          const y = t.fs.resolvePath($, d);
          if ((await t.fs.stat(y)).type === "dir") {
            f.push({ path: v + "/", content: "", isDir: !0 });
            const E = await t.fs.readdir(y);
            for (const S of E)
              await m(y + "/" + S.name, v + "/" + S.name);
          } else {
            const E = await t.fs.readFile(y);
            f.push({ path: v, content: E, isDir: !1 });
          }
        }
        for (const $ of p)
          await m($, $);
        const g = ["FLUFFY-TAR-V1"];
        for (const $ of f)
          c && (t.stderr || console.error($.path)), g.push(`FILE:${$.path}`), g.push(`SIZE:${$.content.length}`), g.push(`TYPE:${$.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push($.content), g.push("DATA-END");
        const x = g.join(`
`), b = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(b, x), {
          stdout: c ? f.map(($) => $.path).join(`
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
        const p = t.fs.resolvePath(l, t.cwd), m = (await t.fs.readFile(p)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let g = 1;
        const x = [];
        for (; g < m.length && m[g].startsWith("FILE:"); ) {
          const b = m[g].slice(5), $ = parseInt(m[g + 1].slice(5), 10), v = m[g + 2].slice(5);
          g += 4;
          const y = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            y.push(m[g]), g++;
          const w = y.join(`
`);
          g++;
          const E = t.fs.resolvePath(b, d);
          if (v === "dir")
            await t.fs.mkdir(E, { recursive: !0 });
          else {
            const S = E.lastIndexOf("/");
            if (S > 0) {
              const F = E.slice(0, S);
              try {
                await t.fs.mkdir(F, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(E, w);
          }
          x.push(b), c && (t.stderr || console.error(b));
        }
        return {
          stdout: c ? x.join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (r) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(l, t.cwd), m = (await t.fs.readFile(p)).split(`
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
}, It = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.a, n = t.stdin;
    try {
      for (const a of o) {
        const r = t.fs.resolvePath(a, t.cwd);
        if (s) {
          let c = "";
          try {
            c = await t.fs.readFile(r);
          } catch {
          }
          await t.fs.writeFile(r, c + n);
        } else
          await t.fs.writeFile(r, n);
      }
      return { stdout: n, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: n, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, kt = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(i, t) {
    const e = i[i.length - 1] === "]" ? i.slice(0, -1) : [...i];
    try {
      return { stdout: "", stderr: "", exitCode: await N(e, t) ? 0 : 1 };
    } catch (o) {
      return { stdout: "", stderr: `test: ${o instanceof Error ? o.message : o}
`, exitCode: 2 };
    }
  }
};
async function N(i, t) {
  if (i.length === 0) return !1;
  if (i.length === 1) return i[0] !== "";
  if (i.length === 2) {
    const [s, n] = i;
    switch (s) {
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
          const a = t.fs.resolvePath(n, t.cwd), r = await t.fs.stat(a);
          return s === "-f" ? r.type === "file" : s === "-d" ? r.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (i[0] === "!" && i.length > 1)
    return !await N(i.slice(1), t);
  if (i.length === 3) {
    const [s, n, a] = i;
    switch (n) {
      case "=":
      case "==":
        return s === a;
      case "!=":
        return s !== a;
      case "-eq":
        return parseInt(s) === parseInt(a);
      case "-ne":
        return parseInt(s) !== parseInt(a);
      case "-lt":
        return parseInt(s) < parseInt(a);
      case "-le":
        return parseInt(s) <= parseInt(a);
      case "-gt":
        return parseInt(s) > parseInt(a);
      case "-ge":
        return parseInt(s) >= parseInt(a);
    }
  }
  const e = i.indexOf("-a");
  if (e > 0)
    return await N(i.slice(0, e), t) && await N(i.slice(e + 1), t);
  const o = i.indexOf("-o");
  return o > 0 ? await N(i.slice(0, o), t) || await N(i.slice(o + 1), t) : !1;
}
const Rt = {
  name: "time",
  description: "Time a command execution",
  async exec(i, t) {
    const { positional: e, flags: o } = C(i);
    if (e.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const s = o.v || o.verbose, n = o.p, a = e.join(" "), r = globalThis.performance, c = r ? r.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const d = ((r ? r.now() : Date.now()) - c) / 1e3, h = Math.floor(d / 60), p = d % 60;
    let f;
    return n ? f = `real ${d.toFixed(2)}
user 0.00
sys 0.00
` : s ? f = `        ${d.toFixed(3)} real         0.000 user         0.000 sys
` : f = `
real    ${h}m${p.toFixed(3)}s
user    0m0.000s
sys     0m0.000s
`, {
      stdout: "",
      stderr: `Command: ${a}
${f}`,
      exitCode: 0
    };
  }
}, At = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(i, t) {
    const { positional: e } = C(i);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const o of e) {
        const s = t.fs.resolvePath(o, t.cwd);
        try {
          await t.fs.stat(s);
          const n = await t.fs.readFile(s);
          await t.fs.writeFile(s, n);
        } catch {
          await t.fs.writeFile(s, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `touch: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, Tt = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.d, n = e.s, a = O(o[0] ?? ""), r = O(o[1] ?? ""), c = t.stdin;
    let l;
    if (s) {
      const u = new Set(a.split(""));
      l = c.split("").filter((d) => !u.has(d)).join("");
    } else if (a && r) {
      const u = /* @__PURE__ */ new Map();
      for (let d = 0; d < a.length; d++)
        u.set(a[d], r[Math.min(d, r.length - 1)]);
      l = c.split("").map((d) => u.get(d) ?? d).join("");
    } else
      l = c;
    if (n && r) {
      const u = new Set(r.split(""));
      let d = "", h = "";
      for (const p of l)
        u.has(p) && p === h || (d += p, h = p);
      l = d;
    }
    return { stdout: l, stderr: "", exitCode: 0 };
  }
};
function O(i) {
  let t = i;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let e = "", o = 0;
  for (; o < t.length; )
    if (o + 2 < t.length && t[o + 1] === "-") {
      const s = t.charCodeAt(o), n = t.charCodeAt(o + 2);
      for (let a = s; a <= n; a++)
        e += String.fromCharCode(a);
      o += 3;
    } else
      e += t[o], o++;
  return e;
}
const Nt = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, Mt = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(i, t) {
    const { values: e, positional: o, flags: s } = C(i, ["t", "tabs"]), n = e.t || e.tabs || "8", a = parseInt(n, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${n}'
`,
        exitCode: 1
      };
    const r = s.a || s.all;
    try {
      const { content: c } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), l = c.split(`
`), u = [];
      for (const d of l) {
        let h = "", p = 0, f = 0;
        for (let m = 0; m < d.length; m++) {
          const g = d[m];
          g === " " ? (f++, p++, p % a === 0 && (r || h.trim() === "" ? (f >= a && (h += "	".repeat(Math.floor(f / a)), f = f % a), f > 0 && (h += " ".repeat(f), f = 0)) : (h += " ".repeat(f), f = 0))) : (f > 0 && (h += " ".repeat(f), f = 0), h += g, p++);
        }
        f > 0 && (h += " ".repeat(f)), u.push(h);
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
}, Dt = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i);
    try {
      const { content: s } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), n = s.split(`
`);
      n.length > 0 && n[n.length - 1] === "" && n.pop();
      const a = [];
      let r = "", c = 0;
      for (const l of n)
        l === r ? c++ : (c > 0 && W(r, c, e, a), r = l, c = 1);
      return c > 0 && W(r, c, e, a), { stdout: a.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `uniq: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
};
function W(i, t, e, o) {
  e.d && t < 2 || (e.c ? o.push(`${String(t).padStart(7)} ${i}`) : o.push(i));
}
const qt = {
  name: "uname",
  description: "Print system information",
  async exec(i, t) {
    const { flags: e } = C(i), o = e.a, s = t.env.UNAME_SYSNAME ?? "FluffyOS", n = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", r = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (o)
      return { stdout: `${s} ${n} ${a} ${r} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: s + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(s), e.n && l.push(n), e.r && l.push(a), e.v && l.push(r), e.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Lt = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.l, n = e.w, a = e.c, r = !s && !n && !a;
    try {
      const { content: c, files: l } = await k(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, h = c.length, p = [];
      return (r || s) && p.push(String(u).padStart(6)), (r || n) && p.push(String(d).padStart(6)), (r || a) && p.push(String(h).padStart(6)), l.length === 1 && p.push(" " + o[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Ot = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(i, t) {
    const { flags: e, positional: o } = C(i), s = e.a;
    if (o.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const n = o[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", r = a.split(":"), c = [];
    for (const l of r) {
      const u = `${l}/${n}`;
      try {
        if (await t.fs.exists(u) && (await t.fs.stat(u)).type === "file" && (c.push(u), !s))
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
}, Wt = {
  name: "whoami",
  description: "Print current user name",
  async exec(i, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, zt = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(i, t) {
    const { flags: e, positional: o, values: s } = C(i, ["n", "I", "i", "d", "delimiter"]), n = e.I || e.L || e.l, a = s.I || s.i, r = s.n ? parseInt(s.n) : void 0, c = s.d || s.delimiter || /\s+/, l = e.t || e.verbose, u = e.r, d = o.length > 0 ? o.join(" ") : "echo";
    let h;
    if (typeof c == "string" ? h = t.stdin.split(c).filter(Boolean) : h = t.stdin.trim().split(c).filter(Boolean), h.length === 0) {
      if (u)
        return { stdout: "", stderr: "", exitCode: 0 };
      h = [""];
    }
    const p = [], f = [];
    if (a) {
      const m = typeof a == "string" ? a : "{}";
      for (const g of h) {
        const x = d.replace(new RegExp(Ut(m), "g"), g);
        f.push(x), l && p.push(`+ ${x}`);
      }
    } else if (r)
      for (let m = 0; m < h.length; m += r) {
        const g = h.slice(m, m + r), x = `${d} ${g.map(q).join(" ")}`;
        f.push(x), l && p.push(`+ ${x}`);
      }
    else if (n)
      for (const m of h) {
        const g = `${d} ${q(m)}`;
        f.push(g), l && p.push(`+ ${g}`);
      }
    else {
      const m = d === "echo" ? h.join(" ") : `${d} ${h.map(q).join(" ")}`;
      f.push(m), l && p.push(`+ ${m}`);
    }
    return d === "echo" && !a && !r ? p.push(...h) : p.push(...f), {
      stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function q(i) {
  return /[^a-zA-Z0-9._\-/=]/.test(i) ? `'${i.replace(/'/g, "'\\''")}'` : i;
}
function Ut(i) {
  return i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Ht = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(i, t) {
    const { positional: e } = C(i), o = e.length > 0 ? e.join(" ") : "y", s = [], n = 1e3;
    for (let a = 0; a < n; a++)
      s.push(o);
    return {
      stdout: s.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Bt = {
  awk: z,
  basename: U,
  cat: H,
  chmod: B,
  clear: _,
  cp: Y,
  curl: V,
  cut: Z,
  date: J,
  diff: K,
  dirname: tt,
  echo: et,
  env: st,
  expand: nt,
  export: rt,
  false: ot,
  find: it,
  grep: at,
  head: ct,
  hostname: lt,
  less: dt,
  ln: ft,
  ls: ut,
  mkdir: gt,
  mv: xt,
  printf: wt,
  pwd: yt,
  readlink: vt,
  realpath: Ct,
  rm: $t,
  sed: St,
  seq: bt,
  sleep: Et,
  sort: Ft,
  tail: Pt,
  tar: jt,
  tee: It,
  test: kt,
  time: Rt,
  touch: At,
  tr: Tt,
  true: Nt,
  unexpand: Mt,
  uniq: Dt,
  uname: qt,
  wc: Lt,
  which: Ot,
  whoami: Wt,
  xargs: zt,
  yes: Ht
}, _t = Object.values(Bt);
export {
  Bt as allCommands,
  z as awk,
  U as basename,
  H as cat,
  B as chmod,
  _ as clear,
  _t as commandList,
  Y as cp,
  V as curl,
  Z as cut,
  J as date,
  K as diff,
  tt as dirname,
  et as echo,
  st as env,
  nt as expand,
  rt as exportCmd,
  ot as false,
  it as find,
  at as grep,
  ct as head,
  lt as hostname,
  dt as less,
  ft as ln,
  ut as ls,
  gt as mkdir,
  xt as mv,
  wt as printf,
  yt as pwd,
  vt as readlink,
  Ct as realpath,
  $t as rm,
  St as sed,
  bt as seq,
  Et as sleep,
  Ft as sort,
  Pt as tail,
  jt as tar,
  It as tee,
  kt as test,
  Rt as time,
  At as touch,
  Tt as tr,
  Nt as true,
  qt as uname,
  Mt as unexpand,
  Dt as uniq,
  Lt as wc,
  Ot as which,
  Wt as whoami,
  zt as xargs,
  Ht as yes
};
