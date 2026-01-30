function C(n, t = []) {
  const e = {}, s = {}, r = [], o = new Set(t);
  for (let a = 0; a < n.length; a++) {
    const i = n[a];
    if (i === "--") {
      r.push(...n.slice(a + 1));
      break;
    }
    if (i.startsWith("--")) {
      const c = i.slice(2);
      o.has(c) && a + 1 < n.length ? s[c] = n[++a] : e[c] = !0;
    } else if (i.startsWith("-") && i.length > 1 && !/^-\d/.test(i)) {
      const c = i.slice(1);
      if (o.has(c) && a + 1 < n.length)
        s[c] = n[++a];
      else
        for (let d = 0; d < c.length; d++) {
          const u = c[d];
          if (o.has(u)) {
            const l = c.slice(d + 1);
            l ? s[u] = l : a + 1 < n.length && (s[u] = n[++a]);
            break;
          }
          e[u] = !0;
        }
    } else
      r.push(i);
  }
  return { flags: e, values: s, positional: r };
}
async function T(n, t, e, s, r) {
  if (n.length === 0)
    return { content: t, files: [] };
  const o = [], a = [];
  for (const i of n) {
    const c = r(i, s);
    o.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: o };
}
const U = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, t) {
    const { values: e, positional: s } = C(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const r = s[0], o = s.slice(1), a = e.F || /\s+/, i = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (e.v) {
      const d = e.v.split("=");
      d.length === 2 && (c[d[0]] = d[1]);
    }
    try {
      const { content: d } = await T(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = d.split(`
`).filter((x) => x !== "" || d.endsWith(`
`)), l = [], h = r.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), p = r.match(/END\s*\{\s*([^}]*)\s*\}/), f = r.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let m = 0, g = 0;
      if (h) {
        const x = q(h[1], [], 0, 0, c);
        x && l.push(x);
      }
      for (const x of u) {
        m++;
        const v = x.split(i).filter(($) => $ !== "");
        g = v.length;
        let b = !0;
        if (f) {
          const $ = f[1], w = f[2];
          if ($)
            try {
              b = new RegExp($).test(x);
            } catch {
              b = !1;
            }
          if (b) {
            const y = q(w, v, m, g, c);
            y !== null && l.push(y);
          }
        } else if (!h && !p) {
          const $ = q(r, v, m, g, c);
          $ !== null && l.push($);
        }
      }
      if (p) {
        const x = q(p[1], [], m, 0, c);
        x && l.push(x);
      }
      return {
        stdout: l.join(`
`) + (l.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (d) {
      return {
        stdout: "",
        stderr: `awk: ${d instanceof Error ? d.message : d}
`,
        exitCode: 1
      };
    }
  }
};
function q(n, t, e, s, r) {
  let o = n.trim();
  if (o.startsWith("print")) {
    const a = o.substring(5).trim();
    if (!a || a === "")
      return t.join(" ");
    let i = a;
    i = i.replace(/\$0/g, t.join(" ")), i = i.replace(/\$NF/g, t[t.length - 1] || "");
    for (let c = 1; c <= t.length; c++)
      i = i.replace(new RegExp(`\\$${c}`, "g"), t[c - 1] || "");
    i = i.replace(/\bNR\b/g, String(e)), i = i.replace(/\bNF\b/g, String(s));
    for (const [c, d] of Object.entries(r))
      i = i.replace(new RegExp(`\\b${c}\\b`, "g"), d);
    return i = i.replace(/^["'](.*)["']$/, "$1"), i = i.replace(/\s+/g, " ").trim(), i;
  }
  return null;
}
const H = {
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
}, _ = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n);
    try {
      const { content: r } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return e.n ? { stdout: r.split(`
`).map((i, c) => `${String(c + 1).padStart(6)}	${i}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: r, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `cat: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, B = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = s[0], a = s.slice(1), i = parseInt(o, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function c(d) {
      const u = t.fs.resolvePath(d, t.cwd);
      if (r)
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
      for (const d of a)
        await c(d);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (d) {
      return { stdout: "", stderr: `chmod: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
}, Y = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, V = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `comm: missing operand
`,
        exitCode: 1
      };
    const r = e[1], o = e[2], a = e[3];
    try {
      const i = t.fs.resolvePath(s[0], t.cwd), c = t.fs.resolvePath(s[1], t.cwd), d = await t.fs.readFile(i), u = await t.fs.readFile(c), l = d.split(`
`).filter((g) => g !== "" || d.endsWith(`
`)), h = u.split(`
`).filter((g) => g !== "" || u.endsWith(`
`));
      l.length > 0 && l[l.length - 1] === "" && l.pop(), h.length > 0 && h[h.length - 1] === "" && h.pop();
      const p = [];
      let f = 0, m = 0;
      for (; f < l.length || m < h.length; ) {
        const g = f < l.length ? l[f] : null, x = m < h.length ? h[m] : null;
        if (g === null) {
          if (!o) {
            const v = r ? "" : "	";
            p.push(v + x);
          }
          m++;
        } else if (x === null)
          r || p.push(g), f++;
        else if (g < x)
          r || p.push(g), f++;
        else if (g > x) {
          if (!o) {
            const v = r ? "" : "	";
            p.push(v + x);
          }
          m++;
        } else {
          if (!a) {
            let v = "";
            r || (v += "	"), o || (v += "	"), p.push(v + g);
          }
          f++, m++;
        }
      }
      return {
        stdout: p.join(`
`) + (p.length > 0 ? `
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
}, Z = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.r || e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(s[s.length - 1], t.cwd), a = s.slice(0, -1);
    let i = !1;
    try {
      i = (await t.fs.stat(o)).type === "dir";
    } catch {
    }
    if (a.length > 1 && !i)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function c(u, l) {
      const h = await t.fs.readFile(u);
      await t.fs.writeFile(l, h);
    }
    async function d(u, l) {
      await t.fs.mkdir(l, { recursive: !0 });
      const h = await t.fs.readdir(u);
      for (const p of h) {
        const f = u + "/" + p.name, m = l + "/" + p.name;
        p.type === "dir" ? await d(f, m) : await c(f, m);
      }
    }
    try {
      for (const u of a) {
        const l = t.fs.resolvePath(u, t.cwd), h = await t.fs.stat(l), p = u.split("/").pop(), f = i ? o + "/" + p : o;
        if (h.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${u}'
`, exitCode: 1 };
          await d(l, f);
        } else
          await c(l, f);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `cp: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, J = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = C(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (r.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = r[0], a = s.X || s.request || (s.d || s.data ? "POST" : "GET"), i = s.o || s.output, c = e.s || e.silent, d = e.i || e.include, u = e.I || e.head, l = e.L || e.location, h = {}, p = s.H || s.header;
    if (p) {
      const g = p.split(":");
      g.length >= 2 && (h[g[0].trim()] = g.slice(1).join(":").trim());
    }
    const f = s["user-agent"] || "fluffycoreutils-curl/0.1.0";
    h["User-Agent"] = f;
    let m;
    (s.d || s.data) && (m = s.d || s.data, h["Content-Type"] || (h["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const g = {
        method: u ? "HEAD" : a,
        headers: h,
        redirect: l ? "follow" : "manual"
      };
      m && a !== "GET" && a !== "HEAD" && (g.body = m);
      const x = await fetch(o, g);
      let v = "";
      if ((d || u) && (v += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach((b, $) => {
        v += `${$}: ${b}
`;
      }), v += `
`), !u) {
        const b = await x.text();
        v += b;
      }
      if (i) {
        const b = t.fs.resolvePath(i, t.cwd);
        return await t.fs.writeFile(b, u ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${v.length}  100  ${v.length}    0     0   ${v.length}      0 --:--:-- --:--:-- --:--:--  ${v.length}
`,
          exitCode: 0
        };
      }
      return !c && !x.ok ? {
        stdout: v,
        stderr: `curl: (22) The requested URL returned error: ${x.status}
`,
        exitCode: 22
      } : { stdout: v, stderr: "", exitCode: 0 };
    } catch (g) {
      return {
        stdout: "",
        stderr: `curl: (6) Could not resolve host: ${g instanceof Error ? g.message : String(g)}
`,
        exitCode: 6
      };
    }
  }
}, K = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, t) {
    const { values: e, positional: s } = C(n, ["d", "f", "c"]), r = e.d ?? "	", o = e.f, a = e.c;
    if (!o && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = G(o ?? a), d = i.split(`
`);
      d.length > 0 && d[d.length - 1] === "" && d.pop();
      const u = [];
      for (const l of d)
        if (o) {
          const h = l.split(r), p = c.flatMap((f) => h.slice(f.start - 1, f.end)).filter((f) => f !== void 0);
          u.push(p.join(r));
        } else {
          const h = l.split(""), p = c.flatMap((f) => h.slice(f.start - 1, f.end)).filter((f) => f !== void 0);
          u.push(p.join(""));
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
function G(n) {
  return n.split(",").map((t) => {
    if (t.includes("-")) {
      const [s, r] = t.split("-");
      return {
        start: s ? parseInt(s, 10) : 1,
        end: r ? parseInt(r, 10) : 1 / 0
      };
    }
    const e = parseInt(t, 10);
    return { start: e, end: e };
  });
}
const X = {
  name: "date",
  description: "Display date and time",
  async exec(n) {
    const t = /* @__PURE__ */ new Date();
    if (n.length > 0 && n[0].startsWith("+")) {
      const e = n[0].slice(1);
      return { stdout: Q(t, e) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: t.toString() + `
`, stderr: "", exitCode: 0 };
  }
};
function Q(n, t) {
  const e = (s) => String(s).padStart(2, "0");
  return t.replace(/%Y/g, String(n.getFullYear())).replace(/%m/g, e(n.getMonth() + 1)).replace(/%d/g, e(n.getDate())).replace(/%H/g, e(n.getHours())).replace(/%M/g, e(n.getMinutes())).replace(/%S/g, e(n.getSeconds())).replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const tt = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, t) {
    var h, p;
    const { flags: e, positional: s, values: r } = C(n, ["U", "context", "C"]), o = e.u || r.U !== void 0, a = r.U || r.context || r.C || (e.u ? 3 : 0), i = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, d = e.i, u = e.w || e["ignore-all-space"], l = e.y || e["side-by-side"];
    if (s.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const f = t.fs.resolvePath(s[0], t.cwd), m = t.fs.resolvePath(s[1], t.cwd), g = await t.fs.readFile(f), x = await t.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${s[0]} and ${s[1]} differ
`, stderr: "", exitCode: 1 };
      const v = g.split(`
`), b = x.split(`
`), $ = et(v, b, { ignoreCase: d, ignoreWhitespace: u }), w = [];
      if (o) {
        w.push(`--- ${s[0]}`), w.push(`+++ ${s[1]}`);
        let y = 0;
        for (; y < $.length; ) {
          if ($[y].type === "equal") {
            y++;
            continue;
          }
          const S = Math.max(0, y - 1);
          let P = y;
          for (; P < $.length; ) {
            const F = $[P];
            if (F.type !== "equal")
              P++;
            else if (F.lines.length <= i * 2)
              P++;
            else
              break;
          }
          const j = (((h = $[S]) == null ? void 0 : h.line1) ?? 0) + 1, D = (((p = $[S]) == null ? void 0 : p.line2) ?? 0) + 1;
          let N = 0, R = 0;
          for (let F = S; F < P; F++)
            ($[F].type === "equal" || $[F].type === "delete") && (N += $[F].lines.length), ($[F].type === "equal" || $[F].type === "add") && (R += $[F].lines.length);
          w.push(`@@ -${j},${N} +${D},${R} @@`);
          for (let F = S; F < P; F++) {
            const I = $[F];
            I.type === "equal" ? I.lines.forEach((M) => w.push(` ${M}`)) : I.type === "delete" ? I.lines.forEach((M) => w.push(`-${M}`)) : I.type === "add" && I.lines.forEach((M) => w.push(`+${M}`));
          }
          y = P;
        }
      } else if (l)
        for (const E of $)
          E.type === "equal" ? E.lines.forEach((S) => {
            const P = S.substring(0, 40).padEnd(40);
            w.push(`${P} | ${S}`);
          }) : E.type === "delete" ? E.lines.forEach((S) => {
            const P = S.substring(0, 40).padEnd(40);
            w.push(`${P} <`);
          }) : E.type === "add" && E.lines.forEach((S) => {
            w.push(`${" ".repeat(40)} > ${S}`);
          });
      else
        for (const y of $) {
          if (y.type === "equal") continue;
          const E = (y.line1 ?? 0) + 1, S = (y.line2 ?? 0) + 1;
          y.type === "delete" ? (w.push(`${E},${E + y.lines.length - 1}d${S - 1}`), y.lines.forEach((P) => w.push(`< ${P}`))) : y.type === "add" && (w.push(`${E - 1}a${S},${S + y.lines.length - 1}`), y.lines.forEach((P) => w.push(`> ${P}`)));
        }
      return { stdout: w.join(`
`) + (w.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (f) {
      return { stdout: "", stderr: `diff: ${f instanceof Error ? f.message : f}
`, exitCode: 2 };
    }
  }
};
function et(n, t, e = {}) {
  const s = n.length, r = t.length, o = (u) => {
    let l = u;
    return e.ignoreWhitespace && (l = l.replace(/\s+/g, "")), e.ignoreCase && (l = l.toLowerCase()), l;
  }, a = Array(s + 1).fill(0).map(() => Array(r + 1).fill(0));
  for (let u = 1; u <= s; u++)
    for (let l = 1; l <= r; l++)
      o(n[u - 1]) === o(t[l - 1]) ? a[u][l] = a[u - 1][l - 1] + 1 : a[u][l] = Math.max(a[u - 1][l], a[u][l - 1]);
  const i = [];
  let c = s, d = r;
  for (; c > 0 || d > 0; )
    c > 0 && d > 0 && o(n[c - 1]) === o(t[d - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: d - 1 }), c--, d--) : d > 0 && (c === 0 || a[c][d - 1] >= a[c - 1][d]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(t[d - 1]) : i.push({ type: "add", lines: [t[d - 1]], line1: c, line2: d - 1 }), d--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: d }), c--);
  return i.reverse();
}
const st = {
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
}, nt = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: t } = C(n), e = t.n, s = n.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let r = t.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return e || (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
  }
}, rt = {
  name: "env",
  description: "Print environment variables",
  async exec(n, t) {
    return { stdout: Object.entries(t.env).map(([s, r]) => `${s}=${r}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, ot = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = C(n, ["t", "tabs"]), o = e.t || e.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.i || r.initial;
    try {
      const { content: c } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), d = c.split(`
`), u = [];
      for (const l of d) {
        let h = "", p = 0;
        for (let f = 0; f < l.length; f++) {
          const m = l[f];
          if (m === "	")
            if (!i || i && h.trim() === "") {
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
}, it = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(n, t) {
    const { positional: e } = C(n);
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
      const s = String(A(n.slice(0, t))), r = String(A(n.slice(t + 1))), o = parseFloat(s), a = parseFloat(r), i = !isNaN(o) && !isNaN(a);
      let c = !1;
      if (i)
        switch (e) {
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
        switch (e) {
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
        const s = new RegExp("^" + e), r = t.match(s);
        return r ? r[0].length : 0;
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
const at = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(n, t) {
    if (n.length === 0)
      return { stdout: Object.entries(t.env).map(([o, a]) => `export ${o}="${a}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], s = [];
    for (const r of n) {
      const o = r.indexOf("=");
      if (o === -1) {
        const a = r;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(a)) {
          s.push(`export: \`${a}': not a valid identifier`);
          continue;
        }
        a in t.env ? e.push(`export ${a}="${t.env[a]}"`) : e.push(`export ${a}=""`);
      } else {
        const a = r.slice(0, o);
        let i = r.slice(o + 1);
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
}, ct = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, lt = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = C(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = s[0] ?? ".", a = e.name, i = e.iname, c = e.path, d = e.type, u = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, l = e.mindepth ? parseInt(e.mindepth) : 0, h = e.exec, p = r.print !== !1, f = t.fs.resolvePath(o, t.cwd), m = [], g = [];
    let x;
    if (a) {
      const y = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${y}$`);
    }
    let v;
    if (i) {
      const y = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      v = new RegExp(`^${y}$`, "i");
    }
    let b;
    if (c) {
      const y = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      b = new RegExp(y);
    }
    async function $(y, E, S) {
      let P;
      try {
        P = await t.fs.readdir(y);
      } catch {
        return;
      }
      for (const j of P) {
        const D = y + "/" + j.name, N = E ? E + "/" + j.name : j.name, R = o === "." ? "./" + N : o + "/" + N, F = S + 1;
        let I = !0;
        if (!(F > u)) {
          if (F < l && (I = !1), x && !x.test(j.name) && (I = !1), v && !v.test(j.name) && (I = !1), b && !b.test(R) && (I = !1), d === "f" && j.type !== "file" && (I = !1), d === "d" && j.type !== "dir" && (I = !1), I && (p && m.push(R), h)) {
            const M = h.replace(/\{\}/g, R);
            g.push(`Executing: ${M}`);
          }
          j.type === "dir" && F < u && await $(D, N, F);
        }
      }
    }
    0 >= l && (!d || d === "d") && !x && !v && !b && p && m.push(o === "." ? "." : o), await $(f, "", 0);
    let w = "";
    return m.length > 0 && (w = m.join(`
`) + `
`), g.length > 0 && (w += g.join(`
`) + `
`), { stdout: w, stderr: "", exitCode: 0 };
  }
}, dt = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = C(n, ["e"]), o = !!e.i, a = !!e.v, i = !!e.c, c = !!e.l, d = !!e.n, u = !!(e.r || e.R), l = s.e ?? r.shift();
    if (!l)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const h = o ? "i" : "";
    let p;
    try {
      p = new RegExp(l, h);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${l}
`, exitCode: 2 };
    }
    const f = r.length > 0 ? r : ["-"], m = f.length > 1 || u, g = [];
    let x = !1;
    async function v(w, y) {
      let E;
      try {
        if (w === "-")
          E = t.stdin;
        else {
          const j = t.fs.resolvePath(w, t.cwd);
          E = await t.fs.readFile(j);
        }
      } catch {
        g.push(`grep: ${w}: No such file or directory`);
        return;
      }
      const S = E.split(`
`);
      S.length > 0 && S[S.length - 1] === "" && S.pop();
      let P = 0;
      for (let j = 0; j < S.length; j++)
        if (p.test(S[j]) !== a && (x = !0, P++, !i && !c)) {
          const N = m ? `${y}:` : "", R = d ? `${j + 1}:` : "";
          g.push(`${N}${R}${S[j]}`);
        }
      i && g.push(m ? `${y}:${P}` : String(P)), c && P > 0 && g.push(y);
    }
    async function b(w) {
      const y = t.fs.resolvePath(w, t.cwd);
      let E;
      try {
        E = await t.fs.readdir(y);
      } catch {
        return;
      }
      for (const S of E) {
        const P = y + "/" + S.name;
        S.type === "dir" ? await b(P) : await v(P, P);
      }
    }
    for (const w of f)
      if (w === "-")
        await v("-", "(standard input)");
      else if (u) {
        const y = t.fs.resolvePath(w, t.cwd);
        let E;
        try {
          E = await t.fs.stat(y);
        } catch {
          continue;
        }
        E.type === "dir" ? await b(y) : await v(w, w);
      } else
        await v(w, w);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, ft = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, t) {
    const { values: e, positional: s } = C(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, ut = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, pt = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = C(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const o = e[1] ? parseInt(e[1]) - 1 : 0, a = e[2] ? parseInt(e[2]) - 1 : 0, i = e.t || /\s+/, c = e.o, d = r.i;
    try {
      const u = t.fs.resolvePath(s[0], t.cwd), l = t.fs.resolvePath(s[1], t.cwd), h = await t.fs.readFile(u), p = await t.fs.readFile(l), f = h.split(`
`).filter((w) => w.trim() !== ""), m = p.split(`
`).filter((w) => w.trim() !== ""), g = (w) => w.map((y) => y.split(i)), x = g(f), v = g(m), b = /* @__PURE__ */ new Map();
      for (const w of v) {
        const y = (w[a] || "").trim(), E = d ? y.toLowerCase() : y;
        b.has(E) || b.set(E, []), b.get(E).push(w);
      }
      const $ = [];
      for (const w of x) {
        const y = (w[o] || "").trim(), E = d ? y.toLowerCase() : y, S = b.get(E) || [];
        for (const P of S) {
          let j;
          if (c)
            j = c.split(",").map((N) => {
              const [R, F] = N.split(".").map((M) => parseInt(M));
              return (R === 1 ? w : P)[F - 1] || "";
            }).join(" ");
          else {
            const D = w[o] || "", N = w.filter((F, I) => I !== o), R = P.filter((F, I) => I !== a);
            j = [D, ...N, ...R].join(" ");
          }
          $.push(j);
        }
      }
      return {
        stdout: $.join(`
`) + ($.length > 0 ? `
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
}, ht = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n);
    try {
      const { content: r } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), o = r.split(`
`), a = e.N || e.n;
      let i = "";
      return a ? i = o.map((c, d) => `${String(d + 1).padStart(6)}  ${c}`).join(`
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
}, mt = {
  name: "ln",
  description: "Make links between files",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.s;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(s[0], t.cwd), a = t.fs.resolvePath(s[1], t.cwd);
    try {
      if (r && t.fs.symlink)
        await t.fs.symlink(o, a);
      else {
        const i = await t.fs.readFile(o);
        await t.fs.writeFile(a, i);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return { stdout: "", stderr: `ln: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, gt = {
  name: "ls",
  description: "List directory contents",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = s.length > 0 ? s : ["."], o = e.a, a = e.l, i = e.h, c = [];
    for (const d of r) {
      const u = t.fs.resolvePath(d, t.cwd), l = await t.fs.stat(u);
      if (l.type === "file") {
        c.push(a ? O(u.split("/").pop(), l, i) : u.split("/").pop());
        continue;
      }
      r.length > 1 && c.push(`${d}:`);
      const h = await t.fs.readdir(u), p = o ? h : h.filter((f) => !f.name.startsWith("."));
      if (p.sort((f, m) => f.name.localeCompare(m.name)), a) {
        c.push(`total ${p.length}`);
        for (const f of p)
          c.push(O(f.name, f, i));
      } else
        c.push(p.map((f) => f.type === "dir" ? f.name + "/" : f.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function O(n, t, e) {
  const s = t.type === "dir" ? "d" : "-", r = t.mode ?? (t.type === "dir" ? 493 : 420), o = xt(r), a = e ? yt(t.size) : String(t.size).padStart(8), i = new Date(t.mtime), c = wt(i);
  return `${s}${o}  1 user user ${a} ${c} ${n}`;
}
function xt(n) {
  let e = "";
  for (let s = 2; s >= 0; s--) {
    const r = n >> s * 3 & 7;
    for (let o = 2; o >= 0; o--)
      e += r & 1 << o ? "rwx"[2 - o] : "-";
  }
  return e;
}
function wt(n) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), r = String(n.getHours()).padStart(2, "0"), o = String(n.getMinutes()).padStart(2, "0");
  return `${e} ${s} ${r}:${o}`;
}
function yt(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const vt = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const o of s) {
        const a = t.fs.resolvePath(o, t.cwd);
        await t.fs.mkdir(a, { recursive: r });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `mkdir: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, Ct = {
  name: "mv",
  description: "Move or rename files",
  async exec(n, t) {
    const { positional: e } = C(n);
    if (e.length < 2)
      return { stdout: "", stderr: `mv: missing operand
`, exitCode: 1 };
    const s = t.fs.resolvePath(e[e.length - 1], t.cwd), r = e.slice(0, -1);
    let o = !1;
    try {
      o = (await t.fs.stat(s)).type === "dir";
    } catch {
    }
    if (r.length > 1 && !o)
      return { stdout: "", stderr: `mv: target is not a directory
`, exitCode: 1 };
    try {
      for (const a of r) {
        const i = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), d = o ? s + "/" + c : s;
        await t.fs.rename(i, d);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, $t = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = C(n, ["d", "delimiters"]), o = e.d || e.delimiters || "	", a = r.s;
    s.length === 0 && s.push("-");
    try {
      const i = [];
      for (const d of s) {
        let u;
        if (d === "-")
          u = t.stdin;
        else {
          const l = t.fs.resolvePath(d, t.cwd);
          u = await t.fs.readFile(l);
        }
        i.push(u.split(`
`).filter((l, h, p) => h < p.length - 1 || l !== ""));
      }
      const c = [];
      if (a)
        for (const d of i) {
          const u = o.split(""), l = [];
          for (let h = 0; h < d.length; h++)
            l.push(d[h]), h < d.length - 1 && l.push(u[h % u.length]);
          c.push(l.join(""));
        }
      else {
        const d = Math.max(...i.map((l) => l.length)), u = o.split("");
        for (let l = 0; l < d; l++) {
          const h = [];
          for (let p = 0; p < i.length; p++) {
            const f = i[p][l] || "";
            h.push(f), p < i.length - 1 && h.push(u[p % u.length]);
          }
          c.push(h.join(""));
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
}, bt = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, t) {
    const { positional: e, flags: s } = C(n), r = s[0] || s.null;
    if (e.length === 0) {
      const o = [];
      for (const [i, c] of Object.entries(t.env))
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
      for (const i of e)
        if (i in t.env)
          o.push(t.env[i]);
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
}, Et = {
  name: "printf",
  description: "Format and print data",
  async exec(n) {
    if (n.length === 0)
      return { stdout: "", stderr: "", exitCode: 0 };
    const t = n[0], e = n.slice(1);
    let s = 0, r = "", o = 0;
    for (; o < t.length; )
      if (t[o] === "\\") {
        switch (o++, t[o]) {
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
            r += "\\" + (t[o] ?? "");
            break;
        }
        o++;
      } else if (t[o] === "%")
        if (o++, t[o] === "%")
          r += "%", o++;
        else {
          let a = "";
          for (; o < t.length && !/[sdf]/.test(t[o]); )
            a += t[o], o++;
          const i = t[o] ?? "s";
          o++;
          const c = e[s++] ?? "";
          switch (i) {
            case "s":
              r += c;
              break;
            case "d":
              r += String(parseInt(c, 10) || 0);
              break;
            case "f": {
              const d = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              r += (parseFloat(c) || 0).toFixed(d);
              break;
            }
          }
        }
      else
        r += t[o], o++;
    return { stdout: r, stderr: "", exitCode: 0 };
  }
}, St = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, Pt = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(s[0], t.cwd);
    return r ? { stdout: o + `
`, stderr: "", exitCode: 0 } : { stdout: o + `
`, stderr: "", exitCode: 0 };
  }
}, Ft = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const r = e.q || e.quiet, o = !e.s;
    e.s;
    const a = [], i = [];
    for (const u of s)
      try {
        let l = t.fs.resolvePath(u, t.cwd);
        if (o) {
          const h = l.split("/").filter((f) => f !== "" && f !== "."), p = [];
          for (const f of h)
            f === ".." ? p.length > 0 && p.pop() : p.push(f);
          l = "/" + p.join("/");
        }
        await t.fs.exists(l) ? a.push(l) : r || i.push(`realpath: ${u}: No such file or directory`);
      } catch (l) {
        r || i.push(`realpath: ${u}: ${l instanceof Error ? l.message : l}`);
      }
    const c = i.length > 0 ? i.join(`
`) + `
` : "", d = i.length > 0 ? 1 : 0;
    return {
      stdout: a.join(`
`) + (a.length > 0 ? `
` : ""),
      stderr: c,
      exitCode: d
    };
  }
}, jt = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.r || e.R, o = e.f;
    if (s.length === 0 && !o)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function a(i) {
      const c = await t.fs.readdir(i);
      for (const d of c) {
        const u = i + "/" + d.name;
        d.type === "dir" ? await a(u) : await t.fs.unlink(u);
      }
      await t.fs.rmdir(i);
    }
    try {
      for (const i of s) {
        const c = t.fs.resolvePath(i, t.cwd);
        let d;
        try {
          d = await t.fs.stat(c);
        } catch {
          if (o) continue;
          return { stdout: "", stderr: `rm: cannot remove '${i}': No such file or directory
`, exitCode: 1 };
        }
        if (d.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `rm: cannot remove '${i}': Is a directory
`, exitCode: 1 };
          await a(c);
        } else
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, It = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.i, o = s.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
`, exitCode: 1 };
    const [, , i, c, d] = a, u = d.includes("g"), l = d.includes("i");
    let h;
    try {
      const p = (u ? "g" : "") + (l ? "i" : "");
      h = new RegExp(i, p);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${i}
`, exitCode: 2 };
    }
    try {
      const { content: p, files: f } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), m = p.split(`
`).map((g) => g.replace(h, c)).join(`
`);
      if (r && f.length > 0) {
        for (const g of f) {
          const x = t.fs.resolvePath(g, t.cwd), b = (await t.fs.readFile(x)).split(`
`).map(($) => $.replace(h, c)).join(`
`);
          await t.fs.writeFile(x, b);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (p) {
      return { stdout: "", stderr: `sed: ${p instanceof Error ? p.message : p}
`, exitCode: 1 };
    }
  }
}, Nt = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = C(n, ["separator", "s", "format", "f"]);
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
`, d = s.f || s.format, u = e.w, l = [];
    if (a > 0)
      for (let f = o; f <= i; f += a)
        l.push(String(f));
    else
      for (let f = o; f >= i; f += a)
        l.push(String(f));
    if (u) {
      const f = Math.max(...l.map((m) => m.length));
      for (let m = 0; m < l.length; m++)
        l[m] = l[m].padStart(f, "0");
    }
    if (d && typeof d == "string")
      for (let f = 0; f < l.length; f++) {
        const m = parseFloat(l[f]);
        d.includes("%g") || d.includes("%d") || d.includes("%i") ? l[f] = d.replace(/%[gdi]/, String(m)) : d.includes("%f") ? l[f] = d.replace(/%f/, m.toFixed(6)) : d.includes("%e") && (l[f] = d.replace(/%e/, m.toExponential()));
      }
    return {
      stdout: l.join(c) + ((typeof c == "string" ? c : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, Rt = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(n, t) {
    const { positional: e } = C(n);
    if (e.length === 0)
      return { stdout: "", stderr: `sleep: missing operand
`, exitCode: 1 };
    const s = e[0];
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
}, Tt = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n);
    try {
      const { content: r } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let o = r.split(`
`).filter(Boolean);
      return e.n ? o.sort((a, i) => parseFloat(a) - parseFloat(i)) : o.sort(), e.u && (o = [...new Set(o)]), e.r && o.reverse(), { stdout: o.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `sort: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, At = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, t) {
    const { values: e, positional: s } = C(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, Mt = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = C(n, ["f", "C"]), o = e.c || e.create, a = e.x || e.extract, i = e.t || e.list, c = e.v || e.verbose, d = s.f, u = s.C;
    let l = t.cwd;
    u && (l = t.fs.resolvePath(u, t.cwd));
    const h = [o, a, i].filter(Boolean).length;
    if (h === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (h > 1)
      return { stdout: "", stderr: `tar: You may not specify more than one -c, -x, or -t
`, exitCode: 1 };
    try {
      if (o) {
        if (!d)
          return { stdout: "", stderr: `tar: Refusing to write archive to terminal (missing -f option?)
`, exitCode: 1 };
        const p = r;
        if (p.length === 0)
          return { stdout: "", stderr: `tar: Cowardly refusing to create an empty archive
`, exitCode: 1 };
        const f = [];
        async function m(b, $) {
          const w = t.fs.resolvePath(b, l);
          if ((await t.fs.stat(w)).type === "dir") {
            f.push({ path: $ + "/", content: "", isDir: !0 });
            const E = await t.fs.readdir(w);
            for (const S of E)
              await m(w + "/" + S.name, $ + "/" + S.name);
          } else {
            const E = await t.fs.readFile(w);
            f.push({ path: $, content: E, isDir: !1 });
          }
        }
        for (const b of p)
          await m(b, b);
        const g = ["FLUFFY-TAR-V1"];
        for (const b of f)
          c && (t.stderr || console.error(b.path)), g.push(`FILE:${b.path}`), g.push(`SIZE:${b.content.length}`), g.push(`TYPE:${b.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(b.content), g.push("DATA-END");
        const x = g.join(`
`), v = t.fs.resolvePath(d, t.cwd);
        return await t.fs.writeFile(v, x), {
          stdout: c ? f.map((b) => b.path).join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (a) {
        if (!d)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(d, t.cwd), m = (await t.fs.readFile(p)).split(`
`);
        if (m[0] !== "FLUFFY-TAR-V1")
          return { stdout: "", stderr: `tar: This does not look like a tar archive
`, exitCode: 1 };
        let g = 1;
        const x = [];
        for (; g < m.length && m[g].startsWith("FILE:"); ) {
          const v = m[g].slice(5), b = parseInt(m[g + 1].slice(5), 10), $ = m[g + 2].slice(5);
          g += 4;
          const w = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            w.push(m[g]), g++;
          const y = w.join(`
`);
          g++;
          const E = t.fs.resolvePath(v, l);
          if ($ === "dir")
            await t.fs.mkdir(E, { recursive: !0 });
          else {
            const S = E.lastIndexOf("/");
            if (S > 0) {
              const P = E.slice(0, S);
              try {
                await t.fs.mkdir(P, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(E, y);
          }
          x.push(v), c && (t.stderr || console.error(v));
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
        if (!d)
          return { stdout: "", stderr: `tar: Refusing to read archive from terminal (missing -f option?)
`, exitCode: 1 };
        const p = t.fs.resolvePath(d, t.cwd), m = (await t.fs.readFile(p)).split(`
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
}, Dt = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.a, o = t.stdin;
    try {
      for (const a of s) {
        const i = t.fs.resolvePath(a, t.cwd);
        if (r) {
          let c = "";
          try {
            c = await t.fs.readFile(i);
          } catch {
          }
          await t.fs.writeFile(i, c + o);
        } else
          await t.fs.writeFile(i, o);
      }
      return { stdout: o, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: o, stderr: `tee: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, Lt = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(n, t) {
    const e = n[n.length - 1] === "]" ? n.slice(0, -1) : [...n];
    try {
      return { stdout: "", stderr: "", exitCode: await L(e, t) ? 0 : 1 };
    } catch (s) {
      return { stdout: "", stderr: `test: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
};
async function L(n, t) {
  if (n.length === 0) return !1;
  if (n.length === 1) return n[0] !== "";
  if (n.length === 2) {
    const [r, o] = n;
    switch (r) {
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
          const a = t.fs.resolvePath(o, t.cwd), i = await t.fs.stat(a);
          return r === "-f" ? i.type === "file" : r === "-d" ? i.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (n[0] === "!" && n.length > 1)
    return !await L(n.slice(1), t);
  if (n.length === 3) {
    const [r, o, a] = n;
    switch (o) {
      case "=":
      case "==":
        return r === a;
      case "!=":
        return r !== a;
      case "-eq":
        return parseInt(r) === parseInt(a);
      case "-ne":
        return parseInt(r) !== parseInt(a);
      case "-lt":
        return parseInt(r) < parseInt(a);
      case "-le":
        return parseInt(r) <= parseInt(a);
      case "-gt":
        return parseInt(r) > parseInt(a);
      case "-ge":
        return parseInt(r) >= parseInt(a);
    }
  }
  const e = n.indexOf("-a");
  if (e > 0)
    return await L(n.slice(0, e), t) && await L(n.slice(e + 1), t);
  const s = n.indexOf("-o");
  return s > 0 ? await L(n.slice(0, s), t) || await L(n.slice(s + 1), t) : !1;
}
const qt = {
  name: "time",
  description: "Time a command execution",
  async exec(n, t) {
    const { positional: e, flags: s } = C(n);
    if (e.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const r = s.v || s.verbose, o = s.p, a = e.join(" "), i = globalThis.performance, c = i ? i.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const l = ((i ? i.now() : Date.now()) - c) / 1e3, h = Math.floor(l / 60), p = l % 60;
    let f;
    return o ? f = `real ${l.toFixed(2)}
user 0.00
sys 0.00
` : r ? f = `        ${l.toFixed(3)} real         0.000 user         0.000 sys
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
}, kt = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(n, t) {
    const { positional: e, flags: s, values: r } = C(n, ["k", "kill-after", "s", "signal"]);
    if (e.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const o = e[0], a = e.slice(1);
    if (a.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let i = Ot(o);
    if (i === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${o}'
`,
        exitCode: 1
      };
    r.k || r["kill-after"];
    const c = r.s || r.signal || "TERM", d = s["preserve-status"];
    s.foreground;
    const u = s.v || s.verbose;
    try {
      const l = a.join(" ");
      if (u)
        return {
          stdout: "",
          stderr: `timeout: would run command '${l}' with ${i}s timeout using signal ${c}
`,
          exitCode: 0
        };
      const h = i * 1e3;
      let p = !1;
      if (await new Promise((f) => {
        const m = globalThis.setTimeout(() => {
          p = !0, f(null);
        }, h);
        globalThis.clearTimeout(m), f(null);
      }), p) {
        const f = d ? 143 : 124;
        return {
          stdout: "",
          stderr: `timeout: command '${l}' timed out after ${i}s
`,
          exitCode: f
        };
      }
      return {
        stdout: `Command: ${l}
`,
        stderr: "",
        exitCode: 0
      };
    } catch (l) {
      return {
        stdout: "",
        stderr: `timeout: ${l instanceof Error ? l.message : l}
`,
        exitCode: 1
      };
    }
  }
};
function Ot(n) {
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
const Wt = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(n, t) {
    const { positional: e } = C(n);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    try {
      for (const s of e) {
        const r = t.fs.resolvePath(s, t.cwd);
        try {
          await t.fs.stat(r);
          const o = await t.fs.readFile(r);
          await t.fs.writeFile(r, o);
        } catch {
          await t.fs.writeFile(r, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (s) {
      return { stdout: "", stderr: `touch: ${s instanceof Error ? s.message : s}
`, exitCode: 1 };
    }
  }
}, zt = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.d, o = e.s, a = W(s[0] ?? ""), i = W(s[1] ?? ""), c = t.stdin;
    let d;
    if (r) {
      const u = new Set(a.split(""));
      d = c.split("").filter((l) => !u.has(l)).join("");
    } else if (a && i) {
      const u = /* @__PURE__ */ new Map();
      for (let l = 0; l < a.length; l++)
        u.set(a[l], i[Math.min(l, i.length - 1)]);
      d = c.split("").map((l) => u.get(l) ?? l).join("");
    } else
      d = c;
    if (o && i) {
      const u = new Set(i.split(""));
      let l = "", h = "";
      for (const p of d)
        u.has(p) && p === h || (l += p, h = p);
      d = l;
    }
    return { stdout: d, stderr: "", exitCode: 0 };
  }
};
function W(n) {
  let t = n;
  t = t.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), t = t.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:digit:\]/g, "0123456789"), t = t.replace(/\[:space:\]/g, ` 	
\r`), t = t.replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), t = t.replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let e = "", s = 0;
  for (; s < t.length; )
    if (s + 2 < t.length && t[s + 1] === "-") {
      const r = t.charCodeAt(s), o = t.charCodeAt(s + 2);
      for (let a = r; a <= o; a++)
        e += String.fromCharCode(a);
      s += 3;
    } else
      e += t[s], s++;
  return e;
}
const Ut = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, Ht = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = C(n, ["t", "tabs"]), o = e.t || e.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.a || r.all;
    try {
      const { content: c } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), d = c.split(`
`), u = [];
      for (const l of d) {
        let h = "", p = 0, f = 0;
        for (let m = 0; m < l.length; m++) {
          const g = l[m];
          g === " " ? (f++, p++, p % a === 0 && (i || h.trim() === "" ? (f >= a && (h += "	".repeat(Math.floor(f / a)), f = f % a), f > 0 && (h += " ".repeat(f), f = 0)) : (h += " ".repeat(f), f = 0))) : (f > 0 && (h += " ".repeat(f), f = 0), h += g, p++);
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
}, _t = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = C(n, ["f", "s", "w"]), o = r.f ? parseInt(r.f) : 0, a = r.s ? parseInt(r.s) : 0, i = r.w ? parseInt(r.w) : void 0, c = e.i;
    try {
      const { content: d } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = d.split(`
`);
      u.length > 0 && u[u.length - 1] === "" && u.pop();
      const l = [];
      let h = "", p = "", f = 0;
      for (const m of u) {
        const g = Bt(m, o, a, i, c);
        g === p ? f++ : (f > 0 && z(h, f, e, l), h = m, p = g, f = 1);
      }
      return f > 0 && z(h, f, e, l), { stdout: l.join(`
`) + (l.length > 0 ? `
` : ""), stderr: "", exitCode: 0 };
    } catch (d) {
      return { stdout: "", stderr: `uniq: ${d instanceof Error ? d.message : d}
`, exitCode: 1 };
    }
  }
};
function Bt(n, t, e, s, r) {
  let o = n;
  return t > 0 && (o = n.split(/\s+/).slice(t).join(" ")), e > 0 && (o = o.substring(e)), s !== void 0 && (o = o.substring(0, s)), r && (o = o.toLowerCase()), o;
}
function z(n, t, e, s) {
  e.d && t < 2 || e.u && t > 1 || (e.c ? s.push(`${String(t).padStart(7)} ${n}`) : s.push(n));
}
const Yt = {
  name: "uname",
  description: "Print system information",
  async exec(n, t) {
    const { flags: e } = C(n), s = e.a, r = t.env.UNAME_SYSNAME ?? "FluffyOS", o = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", i = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${r} ${o} ${a} ${i} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: r + `
`, stderr: "", exitCode: 0 };
    const d = [];
    return e.s && d.push(r), e.n && d.push(o), e.r && d.push(a), e.v && d.push(i), e.m && d.push(c), { stdout: d.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Vt = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.l, o = e.w, a = e.c, i = !r && !o && !a;
    try {
      const { content: c, files: d } = await T(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), l = c.split(/\s+/).filter(Boolean).length, h = c.length, p = [];
      return (i || r) && p.push(String(u).padStart(6)), (i || o) && p.push(String(l).padStart(6)), (i || a) && p.push(String(h).padStart(6)), d.length === 1 && p.push(" " + s[0]), { stdout: p.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Zt = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, t) {
    const { flags: e, positional: s } = C(n), r = e.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = s[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = a.split(":"), c = [];
    for (const d of i) {
      const u = `${d}/${o}`;
      try {
        if (await t.fs.exists(u) && (await t.fs.stat(u)).type === "file" && (c.push(u), !r))
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
}, Jt = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, Kt = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = C(n, ["n", "I", "i", "d", "delimiter"]), o = e.I || e.L || e.l, a = r.I || r.i, i = r.n ? parseInt(r.n) : void 0, c = r.d || r.delimiter || /\s+/, d = e.t || e.verbose, u = e.r, l = s.length > 0 ? s.join(" ") : "echo";
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
        const x = l.replace(new RegExp(Gt(m), "g"), g);
        f.push(x), d && p.push(`+ ${x}`);
      }
    } else if (i)
      for (let m = 0; m < h.length; m += i) {
        const g = h.slice(m, m + i), x = `${l} ${g.map(k).join(" ")}`;
        f.push(x), d && p.push(`+ ${x}`);
      }
    else if (o)
      for (const m of h) {
        const g = `${l} ${k(m)}`;
        f.push(g), d && p.push(`+ ${g}`);
      }
    else {
      const m = l === "echo" ? h.join(" ") : `${l} ${h.map(k).join(" ")}`;
      f.push(m), d && p.push(`+ ${m}`);
    }
    return l === "echo" && !a && !i ? p.push(...h) : p.push(...f), {
      stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
};
function k(n) {
  return /[^a-zA-Z0-9._\-/=]/.test(n) ? `'${n.replace(/'/g, "'\\''")}'` : n;
}
function Gt(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Xt = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, t) {
    const { positional: e } = C(n), s = e.length > 0 ? e.join(" ") : "y", r = [], o = 1e3;
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
}, Qt = {
  awk: U,
  basename: H,
  cat: _,
  chmod: B,
  clear: Y,
  comm: V,
  cp: Z,
  curl: J,
  cut: K,
  date: X,
  diff: tt,
  dirname: st,
  echo: nt,
  env: rt,
  expand: ot,
  expr: it,
  export: at,
  false: ct,
  find: lt,
  grep: dt,
  head: ft,
  hostname: ut,
  join: pt,
  less: ht,
  ln: mt,
  ls: gt,
  mkdir: vt,
  mv: Ct,
  paste: $t,
  printenv: bt,
  printf: Et,
  pwd: St,
  readlink: Pt,
  realpath: Ft,
  rm: jt,
  sed: It,
  seq: Nt,
  sleep: Rt,
  sort: Tt,
  tail: At,
  tar: Mt,
  tee: Dt,
  test: Lt,
  time: qt,
  timeout: kt,
  touch: Wt,
  tr: zt,
  true: Ut,
  unexpand: Ht,
  uniq: _t,
  uname: Yt,
  wc: Vt,
  which: Zt,
  whoami: Jt,
  xargs: Kt,
  yes: Xt
}, te = Object.values(Qt);
export {
  Qt as allCommands,
  U as awk,
  H as basename,
  _ as cat,
  B as chmod,
  Y as clear,
  V as comm,
  te as commandList,
  Z as cp,
  J as curl,
  K as cut,
  X as date,
  tt as diff,
  st as dirname,
  nt as echo,
  rt as env,
  ot as expand,
  at as exportCmd,
  it as expr,
  ct as false,
  lt as find,
  dt as grep,
  ft as head,
  ut as hostname,
  pt as join,
  ht as less,
  mt as ln,
  gt as ls,
  vt as mkdir,
  Ct as mv,
  $t as paste,
  bt as printenv,
  Et as printf,
  St as pwd,
  Pt as readlink,
  Ft as realpath,
  jt as rm,
  It as sed,
  Nt as seq,
  Rt as sleep,
  Tt as sort,
  At as tail,
  Mt as tar,
  Dt as tee,
  Lt as test,
  qt as time,
  kt as timeout,
  Wt as touch,
  zt as tr,
  Ut as true,
  Yt as uname,
  Ht as unexpand,
  _t as uniq,
  Vt as wc,
  Zt as which,
  Jt as whoami,
  Kt as xargs,
  Xt as yes
};
