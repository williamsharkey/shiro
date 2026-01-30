function P(i, t = []) {
  const e = {}, r = {}, n = [], o = new Set(t);
  for (let a = 0; a < i.length; a++) {
    const s = i[a];
    if (s === "--") {
      n.push(...i.slice(a + 1));
      break;
    }
    if (s.startsWith("--")) {
      const c = s.slice(2);
      o.has(c) && a + 1 < i.length ? r[c] = i[++a] : e[c] = !0;
    } else if (s.startsWith("-") && s.length > 1 && !/^-\d/.test(s)) {
      const c = s.slice(1);
      if (o.has(c) && a + 1 < i.length)
        r[c] = i[++a];
      else
        for (let l = 0; l < c.length; l++) {
          const f = c[l];
          if (o.has(f)) {
            const d = c.slice(l + 1);
            d ? r[f] = d : a + 1 < i.length && (r[f] = i[++a]);
            break;
          }
          e[f] = !0;
        }
    } else
      n.push(s);
  }
  return { flags: e, values: r, positional: n };
}
async function R(i, t, e, r, n) {
  if (i.length === 0)
    return { content: t, files: [] };
  const o = [], a = [];
  for (const s of i) {
    const c = n(s, r);
    o.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: o };
}
const z = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(i, t) {
    const { values: e, positional: r } = P(i, ["F", "v"]);
    if (r.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const n = r[0], o = r.slice(1), a = e.F || /\s+/, s = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (e.v) {
      const l = e.v.split("=");
      l.length === 2 && (c[l[0]] = l[1]);
    }
    try {
      const { content: l } = await R(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), f = l.split(`
`).filter((x) => x !== "" || l.endsWith(`
`)), d = [], g = n.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), p = n.match(/END\s*\{\s*([^}]*)\s*\}/), u = n.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let h = 0, m = 0;
      if (g) {
        const x = T(g[1], [], 0, 0, c);
        x && d.push(x);
      }
      for (const x of f) {
        h++;
        const S = x.split(s).filter((v) => v !== "");
        m = S.length;
        let C = !0;
        if (u) {
          const v = u[1], y = u[2];
          if (v)
            try {
              C = new RegExp(v).test(x);
            } catch {
              C = !1;
            }
          if (C) {
            const w = T(y, S, h, m, c);
            w !== null && d.push(w);
          }
        } else if (!g && !p) {
          const v = T(n, S, h, m, c);
          v !== null && d.push(v);
        }
      }
      if (p) {
        const x = T(p[1], [], h, 0, c);
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
function T(i, t, e, r, n) {
  let o = i.trim();
  if (o.startsWith("print")) {
    const a = o.substring(5).trim();
    if (!a || a === "")
      return t.join(" ");
    let s = a;
    s = s.replace(/\$0/g, t.join(" ")), s = s.replace(/\$NF/g, t[t.length - 1] || "");
    for (let c = 1; c <= t.length; c++)
      s = s.replace(new RegExp(`\\$${c}`, "g"), t[c - 1] || "");
    s = s.replace(/\bNR\b/g, String(e)), s = s.replace(/\bNF\b/g, String(r));
    for (const [c, l] of Object.entries(n))
      s = s.replace(new RegExp(`\\b${c}\\b`, "g"), l);
    return s = s.replace(/^["'](.*)["']$/, "$1"), s = s.replace(/\s+/g, " ").trim(), s;
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
    const { flags: e, positional: r } = P(i);
    try {
      const { content: n } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return e.n ? { stdout: n.split(`
`).map((s, c) => `${String(c + 1).padStart(6)}	${s}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: n, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `cat: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, B = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.R;
    if (r.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = r[0], a = r.slice(1), s = parseInt(o, 8);
    if (isNaN(s))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function c(l) {
      const f = t.fs.resolvePath(l, t.cwd);
      if (n)
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
    const { flags: e, positional: r } = P(i), n = e.r || e.R;
    if (r.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(r[r.length - 1], t.cwd), a = r.slice(0, -1);
    let s = !1;
    try {
      s = (await t.fs.stat(o)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !s)
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
        const d = t.fs.resolvePath(f, t.cwd), g = await t.fs.stat(d), p = f.split("/").pop(), u = s ? o + "/" + p : o;
        if (g.type === "dir") {
          if (!n)
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
}, V = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(i, t) {
    const { flags: e, values: r, positional: n } = P(i, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (n.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = n[0], a = r.X || r.request || (r.d || r.data ? "POST" : "GET"), s = r.o || r.output, c = e.s || e.silent, l = e.i || e.include, f = e.I || e.head, d = e.L || e.location, g = {}, p = r.H || r.header;
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
      const x = await fetch(o, m);
      let S = "";
      if ((l || f) && (S += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((C, v) => {
        S += `${v}: ${C}
`;
      }), S += `
`), !f) {
        const C = await x.text();
        S += C;
      }
      if (s) {
        const C = t.fs.resolvePath(s, t.cwd);
        return await t.fs.writeFile(C, f ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${S.length}  100  ${S.length}    0     0   ${S.length}      0 --:--:-- --:--:-- --:--:--  ${S.length}
`,
          exitCode: 0
        };
      }
      return !c && !x.ok ? {
        stdout: S,
        stderr: `curl: (22) The requested URL returned error: ${x.status}
`,
        exitCode: 22
      } : { stdout: S, stderr: "", exitCode: 0 };
    } catch (m) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${m instanceof Error ? m.message : String(m)}
`,
        exitCode: 6
      };
    }
  }
}, Z = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(i, t) {
    const { values: e, positional: r } = P(i, ["d", "f", "c"]), n = e.d ?? "	", o = e.f, a = e.c;
    if (!o && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: s } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = G(o ?? a), l = s.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const f = [];
      for (const d of l)
        if (o) {
          const g = d.split(n), p = c.flatMap((u) => g.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(n));
        } else {
          const g = d.split(""), p = c.flatMap((u) => g.slice(u.start - 1, u.end)).filter((u) => u !== void 0);
          f.push(p.join(""));
        }
      return { stdout: f.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `cut: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
};
function G(i) {
  return i.split(",").map((t) => {
    if (t.includes("-")) {
      const [r, n] = t.split("-");
      return {
        start: r ? parseInt(r, 10) : 1,
        end: n ? parseInt(n, 10) : 1 / 0
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
  const e = (r) => String(r).padStart(2, "0");
  return t.replace(/%Y/g, String(i.getFullYear())).replace(/%m/g, e(i.getMonth() + 1)).replace(/%d/g, e(i.getDate())).replace(/%H/g, e(i.getHours())).replace(/%M/g, e(i.getMinutes())).replace(/%S/g, e(i.getSeconds())).replace(/%s/g, String(Math.floor(i.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const K = {
  name: "diff",
  description: "Compare files line by line",
  async exec(i, t) {
    var g, p;
    const { flags: e, positional: r, values: n } = P(i, ["U", "context", "C"]), o = e.u || n.U !== void 0, a = n.U || n.context || n.C || (e.u ? 3 : 0), s = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, l = e.i, f = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (r.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const u = t.fs.resolvePath(r[0], t.cwd), h = t.fs.resolvePath(r[1], t.cwd), m = await t.fs.readFile(u), x = await t.fs.readFile(h);
      if (m === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${r[0]} and ${r[1]} differ
`, stderr: "", exitCode: 1 };
      const S = m.split(`
`), C = x.split(`
`), v = Q(S, C, { ignoreCase: l, ignoreWhitespace: f }), y = [];
      if (o) {
        y.push(`--- ${r[0]}`), y.push(`+++ ${r[1]}`);
        let w = 0;
        for (; w < v.length; ) {
          if (v[w].type === "equal") {
            w++;
            continue;
          }
          const $ = Math.max(0, w - 1);
          let F = w;
          for (; F < v.length; ) {
            const b = v[F];
            if (b.type !== "equal")
              F++;
            else if (b.lines.length <= s * 2)
              F++;
            else
              break;
          }
          const j = (((g = v[$]) == null ? void 0 : g.line1) ?? 0) + 1, M = (((p = v[$]) == null ? void 0 : p.line2) ?? 0) + 1;
          let k = 0, A = 0;
          for (let b = $; b < F; b++)
            (v[b].type === "equal" || v[b].type === "delete") && (k += v[b].lines.length), (v[b].type === "equal" || v[b].type === "add") && (A += v[b].lines.length);
          y.push(`@@ -${j},${k} +${M},${A} @@`);
          for (let b = $; b < F; b++) {
            const I = v[b];
            I.type === "equal" ? I.lines.forEach((N) => y.push(` ${N}`)) : I.type === "delete" ? I.lines.forEach((N) => y.push(`-${N}`)) : I.type === "add" && I.lines.forEach((N) => y.push(`+${N}`));
          }
          w = F;
        }
      } else if (d)
        for (const E of v)
          E.type === "equal" ? E.lines.forEach(($) => {
            const F = $.substring(0, 40).padEnd(40);
            y.push(`${F} | ${$}`);
          }) : E.type === "delete" ? E.lines.forEach(($) => {
            const F = $.substring(0, 40).padEnd(40);
            y.push(`${F} <`);
          }) : E.type === "add" && E.lines.forEach(($) => {
            y.push(`${" ".repeat(40)} > ${$}`);
          });
      else
        for (const w of v) {
          if (w.type === "equal") continue;
          const E = (w.line1 ?? 0) + 1, $ = (w.line2 ?? 0) + 1;
          w.type === "delete" ? (y.push(`${E},${E + w.lines.length - 1}d${$ - 1}`), w.lines.forEach((F) => y.push(`< ${F}`))) : w.type === "add" && (y.push(`${E - 1}a${$},${$ + w.lines.length - 1}`), w.lines.forEach((F) => y.push(`> ${F}`)));
        }
      return { stdout: y.join(`
`) + (y.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (u) {
      return { stdout: "", stderr: `diff: ${u instanceof Error ? u.message : u}
`, exitCode: 2 };
    }
  }
};
function Q(i, t, e = {}) {
  const r = i.length, n = t.length, o = (f) => {
    let d = f;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(r + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let f = 1; f <= r; f++)
    for (let d = 1; d <= n; d++)
      o(i[f - 1]) === o(t[d - 1]) ? a[f][d] = a[f - 1][d - 1] + 1 : a[f][d] = Math.max(a[f - 1][d], a[f][d - 1]);
  const s = [];
  let c = r, l = n;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && o(i[c - 1]) === o(t[l - 1]) ? (s.length > 0 && s[s.length - 1].type === "equal" ? s[s.length - 1].lines.unshift(i[c - 1]) : s.push({ type: "equal", lines: [i[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (s.length > 0 && s[s.length - 1].type === "add" ? s[s.length - 1].lines.unshift(t[l - 1]) : s.push({ type: "add", lines: [t[l - 1]], line1: c, line2: l - 1 }), l--) : (s.length > 0 && s[s.length - 1].type === "delete" ? s[s.length - 1].lines.unshift(i[c - 1]) : s.push({ type: "delete", lines: [i[c - 1]], line1: c - 1, line2: l }), c--);
  return s.reverse();
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
    const { flags: t } = P(i), e = t.n, r = i.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let n = t.e ? r.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : r;
    return e || (n += `
`), { stdout: n, stderr: "", exitCode: 0 };
  }
}, st = {
  name: "env",
  description: "Print environment variables",
  async exec(i, t) {
    return { stdout: Object.entries(t.env).map(([r, n]) => `${r}=${n}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, nt = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(i, t) {
    if (i.length === 0)
      return { stdout: Object.entries(t.env).map(([o, a]) => `export ${o}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], r = [];
    for (const n of i) {
      const o = n.indexOf("=");
      if (o === -1) {
        const a = n;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          r.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in t.env ? e.push(`export ${a}="${t.env[a]}"`) : e.push(`export ${a}=""`);
      } else {
        const a = n.slice(0, o);
        let s = n.slice(o + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          r.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) && (s = s.slice(1, -1)), t.env[a] = s, e.push(`export ${a}="${s}"`);
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
}, rt = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, ot = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(i, t) {
    const { values: e, positional: r, flags: n } = P(i, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = r[0] ?? ".", a = e.name, s = e.iname, c = e.path, l = e.type, f = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, g = e.exec, p = n.print !== !1, u = t.fs.resolvePath(o, t.cwd), h = [], m = [];
    let x;
    if (a) {
      const w = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${w}$`);
    }
    let S;
    if (s) {
      const w = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      S = new RegExp(`^${w}$`, "i");
    }
    let C;
    if (c) {
      const w = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      C = new RegExp(w);
    }
    async function v(w, E, $) {
      let F;
      try {
        F = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const j of F) {
        const M = w + "/" + j.name, k = E ? E + "/" + j.name : j.name, A = o === "." ? "./" + k : o + "/" + k, b = $ + 1;
        let I = !0;
        if (!(b > f)) {
          if (b < d && (I = !1), x && !x.test(j.name) && (I = !1), S && !S.test(j.name) && (I = !1), C && !C.test(A) && (I = !1), l === "f" && j.type !== "file" && (I = !1), l === "d" && j.type !== "dir" && (I = !1), I && (p && h.push(A), g)) {
            const N = g.replace(/\{\}/g, A);
            m.push(`Executing: ${N}`);
          }
          j.type === "dir" && b < f && await v(M, k, b);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !S && !C && p && h.push(o === "." ? "." : o), await v(u, "", 0);
    let y = "";
    return h.length > 0 && (y = h.join(`
`) + `
`), m.length > 0 && (y += m.join(`
`) + `
`), { stdout: y, stderr: "", exitCode: 0 };
  }
}, it = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(i, t) {
    const { flags: e, values: r, positional: n } = P(i, ["e"]), o = !!e.i, a = !!e.v, s = !!e.c, c = !!e.l, l = !!e.n, f = !!(e.r || e.R), d = r.e ?? n.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const g = o ? "i" : "";
    let p;
    try {
      p = new RegExp(d, g);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const u = n.length > 0 ? n : ["-"], h = u.length > 1 || f, m = [];
    let x = !1;
    async function S(y, w) {
      let E;
      try {
        if (y === "-")
          E = t.stdin;
        else {
          const j = t.fs.resolvePath(y, t.cwd);
          E = await t.fs.readFile(j);
        }
      } catch {
        m.push(`grep: ${y}: No such file or directory`);
        return;
      }
      const $ = E.split(`
`);
      $.length > 0 && $[$.length - 1] === "" && $.pop();
      let F = 0;
      for (let j = 0; j < $.length; j++)
        if (p.test($[j]) !== a && (x = !0, F++, !s && !c)) {
          const k = h ? `${w}:` : "", A = l ? `${j + 1}:` : "";
          m.push(`${k}${A}${$[j]}`);
        }
      s && m.push(h ? `${w}:${F}` : String(F)), c && F > 0 && m.push(w);
    }
    async function C(y) {
      const w = t.fs.resolvePath(y, t.cwd);
      let E;
      try {
        E = await t.fs.readdir(w);
      } catch {
        return;
      }
      for (const $ of E) {
        const F = w + "/" + $.name;
        $.type === "dir" ? await C(F) : await S(F, F);
      }
    }
    for (const y of u)
      if (y === "-")
        await S("-", "(standard input)");
      else if (f) {
        const w = t.fs.resolvePath(y, t.cwd);
        let E;
        try {
          E = await t.fs.stat(w);
        } catch {
          continue;
        }
        E.type === "dir" ? await C(w) : await S(y, y);
      } else
        await S(y, y);
    return { stdout: m.length > 0 ? m.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, at = {
  name: "head",
  description: "Output the first part of files",
  async exec(i, t) {
    const { values: e, positional: r } = P(i, ["n"]), n = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: o.split(`
`).slice(0, n).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `head: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, ct = {
  name: "hostname",
  description: "Print system hostname",
  async exec(i, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, lt = {
  name: "less",
  description: "View file contents with pagination",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i);
    try {
      const { content: n } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), o = n.split(`
`), a = e.N || e.n;
      let s = "";
      return a ? s = o.map((c, l) => `${String(l + 1).padStart(6)}  ${c}`).join(`
`) : s = n, s && !s.endsWith(`
`) && (s += `
`), { stdout: s, stderr: "", exitCode: 0 };
    } catch (n) {
      return {
        stdout: "",
        stderr: `less: ${n instanceof Error ? n.message : n}
`,
        exitCode: 1
      };
    }
  }
}, dt = {
  name: "ln",
  description: "Make links between files",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.s;
    if (r.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(r[0], t.cwd), a = t.fs.resolvePath(r[1], t.cwd);
    try {
      if (n && t.fs.symlink)
        await t.fs.symlink(o, a);
      else {
        const s = await t.fs.readFile(o);
        await t.fs.writeFile(a, s);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `ln: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, ft = {
  name: "ls",
  description: "List directory contents",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = r.length > 0 ? r : ["."], o = e.a, a = e.l, s = e.h, c = [];
    for (const l of n) {
      const f = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(f);
      if (d.type === "file") {
        c.push(a ? L(f.split("/").pop(), d, s) : f.split("/").pop());
        continue;
      }
      n.length > 1 && c.push(`${l}:`);
      const g = await t.fs.readdir(f), p = o ? g : g.filter((u) => !u.name.startsWith("."));
      if (p.sort((u, h) => u.name.localeCompare(h.name)), a) {
        c.push(`total ${p.length}`);
        for (const u of p)
          c.push(L(u.name, u, s));
      } else
        c.push(p.map((u) => u.type === "dir" ? u.name + "/" : u.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function L(i, t, e) {
  const r = t.type === "dir" ? "d" : "-", n = t.mode ?? (t.type === "dir" ? 493 : 420), o = ut(n), a = e ? ht(t.size) : String(t.size).padStart(8), s = new Date(t.mtime), c = pt(s);
  return `${r}${o}  1 user user ${a} ${c} ${i}`;
}
function ut(i) {
  let e = "";
  for (let r = 2; r >= 0; r--) {
    const n = i >> r * 3 & 7;
    for (let o = 2; o >= 0; o--)
      e += n & 1 << o ? "rwx"[2 - o] : "-";
  }
  return e;
}
function pt(i) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i.getMonth()], r = String(i.getDate()).padStart(2), n = String(i.getHours()).padStart(2, "0"), o = String(i.getMinutes()).padStart(2, "0");
  return `${e} ${r} ${n}:${o}`;
}
function ht(i) {
  return i < 1024 ? String(i).padStart(5) : i < 1024 * 1024 ? (i / 1024).toFixed(1) + "K" : (i / (1024 * 1024)).toFixed(1) + "M";
}
const mt = {
  name: "mkdir",
  description: "Make directories",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.p;
    if (r.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const o of r) {
        const a = t.fs.resolvePath(o, t.cwd);
        await t.fs.mkdir(a, { recursive: n });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `mkdir: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, gt = {
  name: "mv",
  description: "Move or rename files",
  async exec(i, t) {
    const { positional: e } = P(i);
    if (e.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const r = t.fs.resolvePath(e[e.length - 1], t.cwd), n = e.slice(0, -1);
    let o = !1;
    try {
      o = (await t.fs.stat(r)).type === "dir";
    } catch {
    }
    if (n.length > 1 && !o)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const a of n) {
        const s = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), l = o ? r + "/" + c : r;
        await t.fs.rename(s, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, xt = {
  name: "printf",
  description: "Format and print data",
  async exec(i) {
    if (i.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = i[0], e = i.slice(1);
    let r = 0, n = "", o = 0;
    for (; o < t.length; )
      if (t[o] === "\\") {
        switch (o++, t[o]) {
          case "n":
            n += `
`;
            break;
          case "t":
            n += "	";
            break;
          case "\\":
            n += "\\";
            break;
          case '"':
            n += '"';
            break;
          default:
            n += "\\" + (t[o] ?? "");
            break;
        }
        o++;
      } else if (t[o] === "%")
        if (o++, t[o] === "%")
          n += "%", o++;
        else {
          let a = "";
          for (; o < t.length && !/[sdf]/.test(t[o]); )
            a += t[o], o++;
          const s = t[o] ?? "s";
          o++;
          const c = e[r++] ?? "";
          switch (s) {
            case "s":
              n += c;
              break;
            case "d":
              n += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const l = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              n += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        n += t[o], o++;
    return { stdout: n, stderr: "", exitCode: 0 };
  }
}, wt = {
  name: "pwd",
  description: "Print working directory",
  async exec(i, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, yt = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.f;
    if (r.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(r[0], t.cwd);
    return n ? { stdout: o + `
`, stderr: "", exitCode: 0 } : { stdout: o + `
`, stderr: "", exitCode: 0 };
  }
}, vt = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i);
    if (r.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const n = e.q || e.quiet, o = !e.s;
    e.s;
    const a = [], s = [];
    for (const f of r)
      try {
        let d = t.fs.resolvePath(f, t.cwd);
        if (o) {
          const g = d.split("/").filter((u) => u !== "" && u !== "."), p = [];
          for (const u of g)
            u === ".." ? p.length > 0 && p.pop() : p.push(u);
          d = "/" + p.join("/");
        }
        await t.fs.exists(d) ? a.push(d) : n || s.push(`realpath: ${f}: No such file or directory`);
      } catch (d) {
        n || s.push(`realpath: ${f}: ${d instanceof Error ? d.message : d}`);
      }
    const c = s.length > 0 ? s.join(`
`) + `
` : "", l = s.length > 0 ? 1 : 0;
    return {
      stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
      stderr: c,
      exitCode: l
    };
  }
}, Ct = {
  name: "rm",
  description: "Remove files or directories",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.r || e.R, o = e.f;
    if (r.length === 0 && !o)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(s) {
      const c = await t.fs.readdir(s);
      for (const l of c) {
        const f = s + "/" + l.name;
        l.type === "dir" ? await a(f) : await t.fs.unlink(f);
      }
      await t.fs.rmdir(s);
    }
    try {
      for (const s of r) {
        const c = t.fs.resolvePath(s, t.cwd);
        let l;
        try {
          l = await t.fs.stat(c);
        } catch {
          if (o) continue;
          return { stdout: "", stderr: `rm: cannot remove '${s}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!n)
            return { stdout: "", stderr: `rm: cannot remove '${s}': Is a directory
`, exitCode: 1 };
          await a(c);
        } else
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (s) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, $t = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.i, o = r.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
`, exitCode: 1 };
    const [, , s, c, l] = a, f = l.includes("g"), d = l.includes("i");
    let g;
    try {
      const p = (f ? "g" : "") + (d ? "i" : "");
      g = new RegExp(s, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${s}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: u } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), h = p.split(`
`).map((m) => m.replace(g, c)).join(`
`);
      if (n && u.length > 0) {
        for (const m of u) {
          const x = t.fs.resolvePath(m, t.cwd), C = (await t.fs.readFile(x)).split(`
`).map((v) => v.replace(g, c)).join(`
`);
          await t.fs.writeFile(x, C);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: h, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, St = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(i, t) {
    const { flags: e, values: r, positional: n } = P(i, ["separator", "s", "format", "f"]);
    if (n.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let o = 1, a = 1, s;
    if (n.length === 1 ? s = parseFloat(n[0]) : n.length === 2 ? (o = parseFloat(n[0]), s = parseFloat(n[1])) : n.length >= 3 ? (o = parseFloat(n[0]), a = parseFloat(n[1]), s = parseFloat(n[2])) : s = 1, isNaN(o) || isNaN(a) || isNaN(s))
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
      for (let u = o; u <= s; u += a)
        d.push(String(u));
    else
      for (let u = o; u >= s; u += a)
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
}, Et = {
  name: "sort",
  description: "Sort lines of text",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i);
    try {
      const { content: n } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let o = n.split(`
`).filter(Boolean);
      return e.n ? o.sort((a, s) => parseFloat(a) - parseFloat(s)) : o.sort(), e.u && (o = [...new Set(o)]), e.r && o.reverse(), { stdout: o.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `sort: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
}, Pt = {
  name: "tail",
  description: "Output the last part of files",
  async exec(i, t) {
    const { values: e, positional: r } = P(i, ["n"]), n = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return { stdout: o.split(`
`).slice(-n).join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `tail: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, Ft = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(i, t) {
    const { flags: e, values: r, positional: n } = P(i, ["f", "C"]), o = e.c || e.create, a = e.x || e.extract, s = e.t || e.list, c = e.v || e.verbose, l = r.f, f = r.C;
    let d = t.cwd;
    f && (d = t.fs.resolvePath(f, t.cwd));
    const g = [o, a, s].filter(Boolean).length;
    if (g === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (g > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (o) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = n;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const u = [];
        async function h(C, v) {
          const y = t.fs.resolvePath(C, d);
          if ((await t.fs.stat(y)).type === "dir") {
            u.push({ path: v + "/", content: "", isDir: !0 });
            const E = await t.fs.readdir(y);
            for (const $ of E)
              await h(y + "/" + $.name, v + "/" + $.name);
          } else {
            const E = await t.fs.readFile(y);
            u.push({ path: v, content: E, isDir: !1 });
          }
        }
        for (const C of p)
          await h(C, C);
        const m = ["FLUFFY-TAR-V1"];
        for (const C of u)
          c && (t.stderr || console.error(C.path)), m.push(`FILE:${C.path}`), m.push(`SIZE:${C.content.length}`), m.push(`TYPE:${C.isDir ? "dir" : "file"}`), m.push("DATA-START"), m.push(C.content), m.push("DATA-END");
        const x = m.join(`
`), S = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(S, x), {
          stdout: c ? u.map((C) => C.path).join(`
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
        const x = [];
        for (; m < h.length && h[m].startsWith("FILE:"); ) {
          const S = h[m].slice(5), C = parseInt(h[m + 1].slice(5), 10), v = h[m + 2].slice(5);
          m += 4;
          const y = [];
          for (; m < h.length && h[m] !== "DATA-END"; )
            y.push(h[m]), m++;
          const w = y.join(`
`);
          m++;
          const E = t.fs.resolvePath(S, d);
          if (v === "dir")
            await t.fs.mkdir(E, { recursive: !0 });
          else {
            const $ = E.lastIndexOf("/");
            if ($ > 0) {
              const F = E.slice(0, $);
              try {
                await t.fs.mkdir(F, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(E, w);
          }
          x.push(S), c && (t.stderr || console.error(S));
        }
        return {
          stdout: c ? x.join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (s) {
        if (!l)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(l, t.cwd), h = (await t.fs.readFile(p)).split(`
`);
        if (h[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        const m = [];
        for (let x = 1; x < h.length; x++)
          h[x].startsWith("FILE:") && m.push(h[x].slice(5));
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
}, bt = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.a, o = t.stdin;
    try {
      for (const a of r) {
        const s = t.fs.resolvePath(a, t.cwd);
        if (n) {
          let c = "";
          try {
            c = await t.fs.readFile(s);
          } catch {
          }
          await t.fs.writeFile(s, c + o);
        } else
          await t.fs.writeFile(s, o);
      }
      return { stdout: o, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: o, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, jt = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(i, t) {
    const e = i[i.length - 1] === "]" ? i.slice(0, -1) : [...i];
    try {
      return { stdout: "", stderr: "", exitCode: await D(e, t) ? 0 : 1 };
    } catch (r) {
      return { stdout: "", stderr: `test: ${r instanceof Error ? r.message : r}
`, exitCode: 2 };
    }
  }
};
async function D(i, t) {
  if (i.length === 0) return !1;
  if (i.length === 1) return i[0] !== "";
  if (i.length === 2) {
    const [n, o] = i;
    switch (n) {
      case "-z":
        return o === "";
      case "-n":
        return o !== "";
      case "!":
        return o === "";
      case "-e":
      case "-f":
      case "-d":
        try {
          const a = t.fs.resolvePath(o, t.cwd), s = await t.fs.stat(a);
          return n === "-f" ? s.type === "file" : n === "-d" ? s.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (i[0] === "!" && i.length > 1)
    return !await D(i.slice(1), t);
  if (i.length === 3) {
    const [n, o, a] = i;
    switch (o) {
      case "=":
      case "==":
        return n === a;
      case "!=":
        return n !== a;
      case "-eq":
        return parseInt(n) === parseInt(a);
      case "-ne":
        return parseInt(n) !== parseInt(a);
      case "-lt":
        return parseInt(n) < parseInt(a);
      case "-le":
        return parseInt(n) <= parseInt(a);
      case "-gt":
        return parseInt(n) > parseInt(a);
      case "-ge":
        return parseInt(n) >= parseInt(a);
    }
  }
  const e = i.indexOf("-a");
  if (e > 0)
    return await D(i.slice(0, e), t) && await D(i.slice(e + 1), t);
  const r = i.indexOf("-o");
  return r > 0 ? await D(i.slice(0, r), t) || await D(i.slice(r + 1), t) : !1;
}
const It = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(i, t) {
    const { positional: e } = P(i);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const r of e) {
        const n = t.fs.resolvePath(r, t.cwd);
        try {
          await t.fs.stat(n);
          const o = await t.fs.readFile(n);
          await t.fs.writeFile(n, o);
        } catch {
          await t.fs.writeFile(n, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `touch: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, Rt = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.d, o = e.s, a = O(r[0] ?? ""), s = O(r[1] ?? ""), c = t.stdin;
    let l;
    if (n) {
      const f = new Set(a.split(""));
      l = c.split("").filter((d) => !f.has(d)).join("");
    } else if (a && s) {
      const f = /* @__PURE__ */ new Map();
      for (let d = 0; d < a.length; d++)
        f.set(a[d], s[Math.min(d, s.length - 1)]);
      l = c.split("").map((d) => f.get(d) ?? d).join("");
    } else
      l = c;
    if (o && s) {
      const f = new Set(s.split(""));
      let d = "", g = "";
      for (const p of l)
        f.has(p) && p === g || (d += p, g = p);
      l = d;
    }
    return { stdout: l, stderr: "", exitCode: 0 };
  }
};
function O(i) {
  let t = i;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let e = "", r = 0;
  for (; r < t.length; )
    if (r + 2 < t.length && t[r + 1] === "-") {
      const n = t.charCodeAt(r), o = t.charCodeAt(r + 2);
      for (let a = n; a <= o; a++)
        e += String.fromCharCode(a);
      r += 3;
    } else
      e += t[r], r++;
  return e;
}
const kt = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, At = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i);
    try {
      const { content: n } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), o = n.split(`
`);
      o.length > 0 && o[o.length - 1] === "" && o.pop();
      const a = [];
      let s = "", c = 0;
      for (const l of o)
        l === s ? c++ : (c > 0 && W(s, c, e, a), s = l, c = 1);
      return c > 0 && W(s, c, e, a), { stdout: a.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (n) {
      return { stdout: "", stderr: `uniq: ${n instanceof Error ? n.message : n}
`, exitCode: 1 };
    }
  }
};
function W(i, t, e, r) {
  e.d && t < 2 || (e.c ? r.push(`${String(t).padStart(7)} ${i}`) : r.push(i));
}
const Nt = {
  name: "uname",
  description: "Print system information",
  async exec(i, t) {
    const { flags: e } = P(i), r = e.a, n = t.env.UNAME_SYSNAME ?? "FluffyOS", o = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", s = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (r)
      return { stdout: `${n} ${o} ${a} ${s} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: n + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(n), e.n && l.push(o), e.r && l.push(a), e.v && l.push(s), e.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Dt = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.l, o = e.w, a = e.c, s = !n && !o && !a;
    try {
      const { content: c, files: l } = await R(
        r,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), f = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, g = c.length, p = [];
      return (s || n) && p.push(String(f).padStart(6)), (s || o) && p.push(String(d).padStart(6)), (s || a) && p.push(String(g).padStart(6)), l.length === 1 && p.push(" " + r[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Mt = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(i, t) {
    const { flags: e, positional: r } = P(i), n = e.a;
    if (r.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = r[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", s = a.split(":"), c = [];
    for (const l of s) {
      const f = `${l}/${o}`;
      try {
        if (await t.fs.exists(f) && (await t.fs.stat(f)).type === "file" && (c.push(f), !n))
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
}, Tt = {
  name: "whoami",
  description: "Print current user name",
  async exec(i, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, qt = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(i, t) {
    const { flags: e, positional: r, values: n } = P(i, ["n", "I", "i", "d", "delimiter"]), o = e.I || e.L || e.l, a = n.I || n.i, s = n.n ? parseInt(n.n) : void 0, c = n.d || n.delimiter || /\s+/, l = e.t || e.verbose, f = e.r, d = r.length > 0 ? r.join(" ") : "echo";
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
        const x = d.replace(new RegExp(Lt(h), "g"), m);
        u.push(x), l && p.push(`+ ${x}`);
      }
    } else if (s)
      for (let h = 0; h < g.length; h += s) {
        const m = g.slice(h, h + s), x = `${d} ${m.map(q).join(" ")}`;
        u.push(x), l && p.push(`+ ${x}`);
      }
    else if (o)
      for (const h of g) {
        const m = `${d} ${q(h)}`;
        u.push(m), l && p.push(`+ ${m}`);
      }
    else {
      const h = d === "echo" ? g.join(" ") : `${d} ${g.map(q).join(" ")}`;
      u.push(h), l && p.push(`+ ${h}`);
    }
    return d === "echo" && !a && !s ? p.push(...g) : p.push(...u), {
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
function Lt(i) {
  return i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Ot = {
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
  export: nt,
  false: rt,
  find: ot,
  grep: it,
  head: at,
  hostname: ct,
  less: lt,
  ln: dt,
  ls: ft,
  mkdir: mt,
  mv: gt,
  printf: xt,
  pwd: wt,
  readlink: yt,
  realpath: vt,
  rm: Ct,
  sed: $t,
  seq: St,
  sort: Et,
  tail: Pt,
  tar: Ft,
  tee: bt,
  test: jt,
  touch: It,
  tr: Rt,
  true: kt,
  uniq: At,
  uname: Nt,
  wc: Dt,
  which: Mt,
  whoami: Tt,
  xargs: qt
}, Wt = Object.values(Ot);
export {
  Ot as allCommands,
  z as awk,
  U as basename,
  H as cat,
  B as chmod,
  _ as clear,
  Wt as commandList,
  Y as cp,
  V as curl,
  Z as cut,
  J as date,
  K as diff,
  tt as dirname,
  et as echo,
  st as env,
  nt as exportCmd,
  rt as false,
  ot as find,
  it as grep,
  at as head,
  ct as hostname,
  lt as less,
  dt as ln,
  ft as ls,
  mt as mkdir,
  gt as mv,
  xt as printf,
  wt as pwd,
  yt as readlink,
  vt as realpath,
  Ct as rm,
  $t as sed,
  St as seq,
  Et as sort,
  Pt as tail,
  Ft as tar,
  bt as tee,
  jt as test,
  It as touch,
  Rt as tr,
  kt as true,
  Nt as uname,
  At as uniq,
  Dt as wc,
  Mt as which,
  Tt as whoami,
  qt as xargs
};
