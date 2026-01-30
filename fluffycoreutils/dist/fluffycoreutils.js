function y(n, t = []) {
  const e = {}, s = {}, r = [], o = new Set(t);
  for (let c = 0; c < n.length; c++) {
    const i = n[c];
    if (i === "--") {
      r.push(...n.slice(c + 1));
      break;
    }
    if (i.startsWith("--")) {
      const a = i.slice(2);
      o.has(a) && c + 1 < n.length ? s[a] = n[++c] : e[a] = !0;
    } else if (i.startsWith("-") && i.length > 1 && !/^-\d/.test(i)) {
      const a = i.slice(1);
      if (o.has(a) && c + 1 < n.length)
        s[a] = n[++c];
      else
        for (let l = 0; l < a.length; l++) {
          const u = a[l];
          if (o.has(u)) {
            const d = a.slice(l + 1);
            d ? s[u] = d : c + 1 < n.length && (s[u] = n[++c]);
            break;
          }
          e[u] = !0;
        }
    } else
      r.push(i);
  }
  return { flags: e, values: s, positional: r };
}
async function N(n, t, e, s, r) {
  if (n.length === 0)
    return { content: t, files: [] };
  const o = [], c = [];
  for (const i of n) {
    const a = r(i, s);
    o.push(a), c.push(await e.readFile(a));
  }
  return { content: c.join(""), files: o };
}
const Z = {
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
    const r = [];
    for (const o of e)
      s.p && r.push(`alias ${o}`);
    return {
      stdout: r.join(`
`) + (r.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, V = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const r = s[0], o = s.slice(1), c = e.F || /\s+/, i = typeof c == "string" ? new RegExp(c) : c, a = {};
    if (e.v) {
      const l = e.v.split("=");
      l.length === 2 && (a[l[0]] = l[1]);
    }
    try {
      const { content: l } = await N(
        o,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = l.split(`
`).filter((x) => x !== "" || l.endsWith(`
`)), d = [], h = r.match(/BEGIN\s*\{\s*([^}]*)\s*\}/), f = r.match(/END\s*\{\s*([^}]*)\s*\}/), p = r.match(/(?:\/([^/]*)\/\s*)?\{\s*([^}]*)\s*\}/);
      let m = 0, g = 0;
      if (h) {
        const x = W(h[1], [], 0, 0, a);
        x && d.push(x);
      }
      for (const x of u) {
        m++;
        const w = x.split(i).filter((b) => b !== "");
        g = w.length;
        let v = !0;
        if (p) {
          const b = p[1], $ = p[2];
          if (b)
            try {
              v = new RegExp(b).test(x);
            } catch {
              v = !1;
            }
          if (v) {
            const C = W($, w, m, g, a);
            C !== null && d.push(C);
          }
        } else if (!h && !f) {
          const b = W(r, w, m, g, a);
          b !== null && d.push(b);
        }
      }
      if (f) {
        const x = W(f[1], [], m, 0, a);
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
function W(n, t, e, s, r) {
  let o = n.trim();
  if (o.startsWith("print")) {
    const c = o.substring(5).trim();
    if (!c || c === "")
      return t.join(" ");
    let i = c;
    i = i.replace(/\$0/g, t.join(" ")), i = i.replace(/\$NF/g, t[t.length - 1] || "");
    for (let a = 1; a <= t.length; a++)
      i = i.replace(new RegExp(`\\$${a}`, "g"), t[a - 1] || "");
    i = i.replace(/\bNR\b/g, String(e)), i = i.replace(/\bNF\b/g, String(s));
    for (const [a, l] of Object.entries(r))
      i = i.replace(new RegExp(`\\b${a}\\b`, "g"), l);
    return i = i.replace(/^["'](.*)["']$/, "$1"), i = i.replace(/\s+/g, " ").trim(), i;
  }
  return null;
}
const X = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.d || e.decode, o = e.w ? parseInt(e.w) : 76, c = e.i || e["ignore-garbage"];
    try {
      const { content: i } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let a;
      if (r) {
        const l = c ? i.replace(/[^A-Za-z0-9+/=]/g, "") : i.replace(/\s/g, "");
        try {
          a = globalThis.atob(l);
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
          a = u.join(`
`);
        } else
          a = l;
      }
      return {
        stdout: a + (a ? `
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
}, Q = {
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
}, tt = {
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
}, et = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      return e.n ? { stdout: r.split(`
`).map((i, a) => `${String(a + 1).padStart(6)}	${i}`).join(`
`), stderr: "", exitCode: 0 } : { stdout: r, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `cat: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, st = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = s[0], c = s.slice(1), i = parseInt(o, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function a(l) {
      const u = t.fs.resolvePath(l, t.cwd);
      if (r)
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const h = await t.fs.readdir(u);
            for (const f of h)
              await a(u + "/" + f.name);
          }
        } catch {
        }
    }
    try {
      for (const l of c)
        await a(l);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `chmod: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
}, nt = {
  name: "chown",
  description: "Change file owner and group",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length < 2)
      return { stdout: "", stderr: `chown: missing operand
`, exitCode: 1 };
    const r = s[0], o = s.slice(1);
    e.R;
    const c = e.v, i = r.split(":");
    i[0], i[1];
    const a = [];
    try {
      for (const l of o)
        c && a.push(`ownership of '${l}' retained as ${r}`);
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
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
}, rt = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, ot = {
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
    const r = e[1], o = e[2], c = e[3];
    try {
      const i = t.fs.resolvePath(s[0], t.cwd), a = t.fs.resolvePath(s[1], t.cwd), l = await t.fs.readFile(i), u = await t.fs.readFile(a), d = l.split(`
`).filter((g) => g !== "" || l.endsWith(`
`)), h = u.split(`
`).filter((g) => g !== "" || u.endsWith(`
`));
      d.length > 0 && d[d.length - 1] === "" && d.pop(), h.length > 0 && h[h.length - 1] === "" && h.pop();
      const f = [];
      let p = 0, m = 0;
      for (; p < d.length || m < h.length; ) {
        const g = p < d.length ? d[p] : null, x = m < h.length ? h[m] : null;
        if (g === null) {
          if (!o) {
            const w = r ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else if (x === null)
          r || f.push(g), p++;
        else if (g < x)
          r || f.push(g), p++;
        else if (g > x) {
          if (!o) {
            const w = r ? "" : "	";
            f.push(w + x);
          }
          m++;
        } else {
          if (!c) {
            let w = "";
            r || (w += "	"), o || (w += "	"), f.push(w + g);
          }
          p++, m++;
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
}, it = {
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
}, at = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.r || e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `cp: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(s[s.length - 1], t.cwd), c = s.slice(0, -1);
    let i = !1;
    try {
      i = (await t.fs.stat(o)).type === "dir";
    } catch {
    }
    if (c.length > 1 && !i)
      return { stdout: "", stderr: `cp: target is not a directory
`, exitCode: 1 };
    async function a(u, d) {
      const h = await t.fs.readFile(u);
      await t.fs.writeFile(d, h);
    }
    async function l(u, d) {
      await t.fs.mkdir(d, { recursive: !0 });
      const h = await t.fs.readdir(u);
      for (const f of h) {
        const p = u + "/" + f.name, m = d + "/" + f.name;
        f.type === "dir" ? await l(p, m) : await a(p, m);
      }
    }
    try {
      for (const u of c) {
        const d = t.fs.resolvePath(u, t.cwd), h = await t.fs.stat(d), f = u.split("/").pop(), p = i ? o + "/" + f : o;
        if (h.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${u}'
`, exitCode: 1 };
          await l(d, p);
        } else
          await a(d, p);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `cp: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, ct = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (r.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = r[0], c = s.X || s.request || (s.d || s.data ? "POST" : "GET"), i = s.o || s.output, a = e.s || e.silent, l = e.i || e.include, u = e.I || e.head, d = e.L || e.location, h = {}, f = s.H || s.header;
    if (f) {
      const g = f.split(":");
      g.length >= 2 && (h[g[0].trim()] = g.slice(1).join(":").trim());
    }
    const p = s["user-agent"] || "fluffycoreutils-curl/0.1.0";
    h["User-Agent"] = p;
    let m;
    (s.d || s.data) && (m = s.d || s.data, h["Content-Type"] || (h["Content-Type"] = "application/x-www-form-urlencoded"));
    try {
      const g = {
        method: u ? "HEAD" : c,
        headers: h,
        redirect: d ? "follow" : "manual"
      };
      m && c !== "GET" && c !== "HEAD" && (g.body = m);
      const x = await fetch(o, g);
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
        return await t.fs.writeFile(v, u ? "" : await x.text()), a ? { stdout: "", stderr: "", exitCode: 0 } : {
          stdout: "",
          stderr: `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  ${w.length}  100  ${w.length}    0     0   ${w.length}      0 --:--:-- --:--:-- --:--:--  ${w.length}
`,
          exitCode: 0
        };
      }
      return !a && !x.ok ? {
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
}, lt = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["d", "f", "c"]), r = e.d ?? "	", o = e.f, c = e.c;
    if (!o && !c)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), a = dt(o ?? c), l = i.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const u = [];
      for (const d of l)
        if (o) {
          const h = d.split(r), f = a.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
          u.push(f.join(r));
        } else {
          const h = d.split(""), f = a.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
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
function dt(n) {
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
const ut = {
  name: "date",
  description: "Display date and time",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["d", "date", "r", "reference", "u"]);
    let o;
    if (r.d || r.date) {
      const a = r.d || r.date;
      if (o = new Date(a), isNaN(o.getTime()))
        return {
          stdout: "",
          stderr: `date: invalid date '${a}'
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
    const c = e.u || e.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const a = s[0].slice(1);
      return { stdout: ft(o, a, c) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (c ? o.toUTCString() : o.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function ft(n, t, e = !1) {
  const s = (w) => String(w).padStart(2, "0"), r = (w) => String(w).padStart(3, "0"), o = (w) => e ? n[`getUTC${w}`]() : n[`get${w}`](), c = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], a = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], u = o("FullYear"), d = o("Month"), h = o("Date"), f = o("Hours"), p = o("Minutes"), m = o("Seconds"), g = o("Milliseconds"), x = o("Day");
  return t.replace(/%Y/g, String(u)).replace(/%y/g, String(u).slice(-2)).replace(/%m/g, s(d + 1)).replace(/%d/g, s(h)).replace(/%e/g, String(h).padStart(2, " ")).replace(/%H/g, s(f)).replace(/%I/g, s(f % 12 || 12)).replace(/%M/g, s(p)).replace(/%S/g, s(m)).replace(/%N/g, r(g) + "000000").replace(/%p/g, f >= 12 ? "PM" : "AM").replace(/%P/g, f >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, c[x]).replace(/%a/g, i[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, a[d]).replace(/%b/g, l[d]).replace(/%h/g, l[d]).replace(/%F/g, `${u}-${s(d + 1)}-${s(h)}`).replace(/%T/g, `${s(f)}:${s(p)}:${s(m)}`).replace(/%R/g, `${s(f)}:${s(p)}`).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const pt = {
  name: "df",
  description: "Report file system disk space usage",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.h, r = e.i, o = [];
    return r ? (o.push("Filesystem      Inodes  IUsed   IFree IUse% Mounted on"), o.push("virtual             0      0       0    0% /")) : s ? (o.push("Filesystem      Size  Used Avail Use% Mounted on"), o.push("virtual         100G   10G   90G  10% /")) : (o.push("Filesystem     1K-blocks    Used Available Use% Mounted on"), o.push("virtual        104857600 10485760  94371840  10% /")), {
      stdout: o.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, ht = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, t) {
    var h, f;
    const { flags: e, positional: s, values: r } = y(n, ["U", "context", "C"]), o = e.u || r.U !== void 0, c = r.U || r.context || r.C || (e.u ? 3 : 0), i = typeof c == "string" ? parseInt(c) : 3, a = e.q || e.brief, l = e.i, u = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (s.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const p = t.fs.resolvePath(s[0], t.cwd), m = t.fs.resolvePath(s[1], t.cwd), g = await t.fs.readFile(p), x = await t.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (a)
        return { stdout: `Files ${s[0]} and ${s[1]} differ
`, stderr: "", exitCode: 1 };
      const w = g.split(`
`), v = x.split(`
`), b = mt(w, v, { ignoreCase: l, ignoreWhitespace: u }), $ = [];
      if (o) {
        $.push(`--- ${s[0]}`), $.push(`+++ ${s[1]}`);
        let C = 0;
        for (; C < b.length; ) {
          if (b[C].type === "equal") {
            C++;
            continue;
          }
          const P = Math.max(0, C - 1);
          let j = C;
          for (; j < b.length; ) {
            const F = b[j];
            if (F.type !== "equal")
              j++;
            else if (F.lines.length <= i * 2)
              j++;
            else
              break;
          }
          const E = (((h = b[P]) == null ? void 0 : h.line1) ?? 0) + 1, R = (((f = b[P]) == null ? void 0 : f.line2) ?? 0) + 1;
          let k = 0, M = 0;
          for (let F = P; F < j; F++)
            (b[F].type === "equal" || b[F].type === "delete") && (k += b[F].lines.length), (b[F].type === "equal" || b[F].type === "add") && (M += b[F].lines.length);
          $.push(`@@ -${E},${k} +${R},${M} @@`);
          for (let F = P; F < j; F++) {
            const I = b[F];
            I.type === "equal" ? I.lines.forEach((T) => $.push(` ${T}`)) : I.type === "delete" ? I.lines.forEach((T) => $.push(`-${T}`)) : I.type === "add" && I.lines.forEach((T) => $.push(`+${T}`));
          }
          C = j;
        }
      } else if (d)
        for (const S of b)
          S.type === "equal" ? S.lines.forEach((P) => {
            const j = P.substring(0, 40).padEnd(40);
            $.push(`${j} | ${P}`);
          }) : S.type === "delete" ? S.lines.forEach((P) => {
            const j = P.substring(0, 40).padEnd(40);
            $.push(`${j} <`);
          }) : S.type === "add" && S.lines.forEach((P) => {
            $.push(`${" ".repeat(40)} > ${P}`);
          });
      else
        for (const C of b) {
          if (C.type === "equal") continue;
          const S = (C.line1 ?? 0) + 1, P = (C.line2 ?? 0) + 1;
          C.type === "delete" ? ($.push(`${S},${S + C.lines.length - 1}d${P - 1}`), C.lines.forEach((j) => $.push(`< ${j}`))) : C.type === "add" && ($.push(`${S - 1}a${P},${P + C.lines.length - 1}`), C.lines.forEach((j) => $.push(`> ${j}`)));
        }
      return { stdout: $.join(`
`) + ($.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (p) {
      return { stdout: "", stderr: `diff: ${p instanceof Error ? p.message : p}
`, exitCode: 2 };
    }
  }
};
function mt(n, t, e = {}) {
  const s = n.length, r = t.length, o = (u) => {
    let d = u;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, c = Array(s + 1).fill(0).map(() => Array(r + 1).fill(0));
  for (let u = 1; u <= s; u++)
    for (let d = 1; d <= r; d++)
      o(n[u - 1]) === o(t[d - 1]) ? c[u][d] = c[u - 1][d - 1] + 1 : c[u][d] = Math.max(c[u - 1][d], c[u][d - 1]);
  const i = [];
  let a = s, l = r;
  for (; a > 0 || l > 0; )
    a > 0 && l > 0 && o(n[a - 1]) === o(t[l - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(n[a - 1]) : i.push({ type: "equal", lines: [n[a - 1]], line1: a - 1, line2: l - 1 }), a--, l--) : l > 0 && (a === 0 || c[a][l - 1] >= c[a - 1][l]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(t[l - 1]) : i.push({ type: "add", lines: [t[l - 1]], line1: a, line2: l - 1 }), l--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(n[a - 1]) : i.push({ type: "delete", lines: [n[a - 1]], line1: a - 1, line2: l }), a--);
  return i.reverse();
}
const gt = {
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
}, xt = {
  name: "du",
  description: "Estimate file space usage",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["max-depth", "d"]), o = s.length > 0 ? s : ["."], c = e.s, i = e.a, a = e.h, l = r["max-depth"] || r.d, u = l ? parseInt(l) : 1 / 0, d = [];
    try {
      for (const h of o) {
        const f = t.fs.resolvePath(h, t.cwd), p = await _(f, t.fs, 0, u, i, !c, d, a), m = a ? O(p) : String(Math.ceil(p / 1024));
        d.push(`${m}	${h}`);
      }
      return {
        stdout: d.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (h) {
      return {
        stdout: "",
        stderr: `du: ${h instanceof Error ? h.message : h}
`,
        exitCode: 1
      };
    }
  }
};
async function _(n, t, e, s, r, o, c, i) {
  try {
    const a = await t.stat(n);
    if (a.type === "file")
      return a.size;
    if (a.type === "dir" && e < s) {
      const l = await t.readdir(n);
      let u = 0;
      for (const d of l) {
        const h = n + "/" + d.name, f = await _(h, t, e + 1, s, r, o, c, i);
        if (u += f, r && d.type === "file") {
          const p = i ? O(f) : String(Math.ceil(f / 1024));
          c.push(`${p}	${h}`);
        }
        if (o && d.type === "dir" && e + 1 < s) {
          const p = i ? O(f) : String(Math.ceil(f / 1024));
          c.push(`${p}	${h}`);
        }
      }
      return u;
    }
    return 0;
  } catch {
    return 0;
  }
}
function O(n) {
  const t = ["", "K", "M", "G", "T"];
  let e = n, s = 0;
  for (; e >= 1024 && s < t.length - 1; )
    e /= 1024, s++;
  return Math.ceil(e) + t[s];
}
const yt = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: t } = y(n), e = t.n, s = n.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let r = t.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return e || (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
  }
}, wt = {
  name: "env",
  description: "Print environment variables",
  async exec(n, t) {
    return { stdout: Object.entries(t.env).map(([s, r]) => `${s}=${r}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, $t = {
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
}, Ct = {
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
}, vt = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "tabs"]), o = e.t || e.tabs || "8", c = parseInt(o, 10);
    if (isNaN(c) || c <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.i || r.initial;
    try {
      const { content: a } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), l = a.split(`
`), u = [];
      for (const d of l) {
        let h = "", f = 0;
        for (let p = 0; p < d.length; p++) {
          const m = d[p];
          if (m === "	")
            if (!i || i && h.trim() === "") {
              const g = c - f % c;
              h += " ".repeat(g), f += g;
            } else
              h += m, f++;
          else
            h += m, f++;
        }
        u.push(h);
      }
      return {
        stdout: u.join(`
`) + (a.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `expand: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, bt = {
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
      const s = String(A(n.slice(0, t))), r = String(A(n.slice(t + 1))), o = parseFloat(s), c = parseFloat(r), i = !isNaN(o) && !isNaN(c);
      let a = !1;
      if (i)
        switch (e) {
          case "=":
            a = o === c;
            break;
          case "!=":
            a = o !== c;
            break;
          case "<":
            a = o < c;
            break;
          case ">":
            a = o > c;
            break;
          case "<=":
            a = o <= c;
            break;
          case ">=":
            a = o >= c;
            break;
        }
      else
        switch (e) {
          case "=":
            a = s === r;
            break;
          case "!=":
            a = s !== r;
            break;
          case "<":
            a = s < r;
            break;
          case ">":
            a = s > r;
            break;
          case "<=":
            a = s <= r;
            break;
          case ">=":
            a = s >= r;
            break;
        }
      return a ? 1 : 0;
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
const St = {
  name: "export",
  description: "Set environment variables (note: in a real shell, this modifies parent environment)",
  async exec(n, t) {
    if (n.length === 0)
      return { stdout: Object.entries(t.env).map(([o, c]) => `export ${o}="${c}"`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
    const e = [], s = [];
    for (const r of n) {
      const o = r.indexOf("=");
      if (o === -1) {
        const c = r;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
          s.push(`export: \`${c}': not a valid identifier`);
          continue;
        }
        c in t.env ? e.push(`export ${c}="${t.env[c]}"`) : e.push(`export ${c}=""`);
      } else {
        const c = r.slice(0, o);
        let i = r.slice(o + 1);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
          s.push(`export: \`${c}': not a valid identifier`);
          continue;
        }
        (i.startsWith('"') && i.endsWith('"') || i.startsWith("'") && i.endsWith("'")) && (i = i.slice(1, -1)), t.env[c] = i, e.push(`export ${c}="${i}"`);
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
}, Pt = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, jt = {
  name: "file",
  description: "Determine file type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `file: missing operand
`, exitCode: 1 };
    const r = s.b, o = s.i || s.mime, c = s["mime-type"], i = s["mime-encoding"], a = [];
    try {
      for (const l of e) {
        const u = t.fs.resolvePath(l, t.cwd);
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const m = r ? "directory" : `${l}: directory`;
            a.push(m);
            continue;
          }
          const h = await t.fs.readFile(u), f = Ft(h, l);
          let p;
          c ? p = r ? f.mimeType : `${l}: ${f.mimeType}` : i ? p = r ? f.encoding : `${l}: ${f.encoding}` : o ? p = r ? `${f.mimeType}; charset=${f.encoding}` : `${l}: ${f.mimeType}; charset=${f.encoding}` : p = r ? f.description : `${l}: ${f.description}`, a.push(p);
        } catch (d) {
          a.push(`${l}: cannot open (${d instanceof Error ? d.message : d})`);
        }
      }
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
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
function Ft(n, t) {
  var c;
  let e = "text/plain", s = "us-ascii", r = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", r = "UTF-8 Unicode text"), n.length === 0)
    return e = "application/x-empty", r = "empty", { mimeType: e, encoding: s, description: r };
  const o = (c = t.split(".").pop()) == null ? void 0 : c.toLowerCase();
  if (o)
    switch (o) {
      case "js":
      case "mjs":
        e = "text/javascript", r = "JavaScript source";
        break;
      case "ts":
        e = "text/x-typescript", r = "TypeScript source";
        break;
      case "json":
        e = "application/json", r = "JSON data";
        break;
      case "html":
      case "htm":
        e = "text/html", r = "HTML document";
        break;
      case "css":
        e = "text/css", r = "CSS stylesheet";
        break;
      case "xml":
        e = "text/xml", r = "XML document";
        break;
      case "md":
        e = "text/markdown", r = "Markdown text";
        break;
      case "sh":
        e = "text/x-shellscript", r = "shell script";
        break;
      case "py":
        e = "text/x-python", r = "Python script";
        break;
      case "txt":
        e = "text/plain", r = "ASCII text";
        break;
    }
  if (n.startsWith("#!/bin/sh") || n.startsWith("#!/bin/bash"))
    e = "text/x-shellscript", r = "Bourne-Again shell script";
  else if (n.startsWith("#!/usr/bin/env node"))
    e = "text/javascript", r = "Node.js script";
  else if (n.startsWith("#!/usr/bin/env python"))
    e = "text/x-python", r = "Python script";
  else if (n.startsWith("{") && n.trim().endsWith("}"))
    try {
      JSON.parse(n), e = "application/json", r = "JSON data";
    } catch {
    }
  else n.startsWith("<?xml") ? (e = "text/xml", r = "XML document") : (n.startsWith("<!DOCTYPE html") || n.startsWith("<html")) && (e = "text/html", r = "HTML document");
  return { mimeType: e, encoding: s, description: r };
}
const Et = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = s[0] ?? ".", c = e.name, i = e.iname, a = e.path, l = e.type, u = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, h = e.exec, f = r.print !== !1, p = t.fs.resolvePath(o, t.cwd), m = [], g = [];
    let x;
    if (c) {
      const C = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${C}$`);
    }
    let w;
    if (i) {
      const C = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      w = new RegExp(`^${C}$`, "i");
    }
    let v;
    if (a) {
      const C = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      v = new RegExp(C);
    }
    async function b(C, S, P) {
      let j;
      try {
        j = await t.fs.readdir(C);
      } catch {
        return;
      }
      for (const E of j) {
        const R = C + "/" + E.name, k = S ? S + "/" + E.name : E.name, M = o === "." ? "./" + k : o + "/" + k, F = P + 1;
        let I = !0;
        if (!(F > u)) {
          if (F < d && (I = !1), x && !x.test(E.name) && (I = !1), w && !w.test(E.name) && (I = !1), v && !v.test(M) && (I = !1), l === "f" && E.type !== "file" && (I = !1), l === "d" && E.type !== "dir" && (I = !1), I && (f && m.push(M), h)) {
            const T = h.replace(/\{\}/g, M);
            g.push(`Executing: ${T}`);
          }
          E.type === "dir" && F < u && await b(R, k, F);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !w && !v && f && m.push(o === "." ? "." : o), await b(p, "", 0);
    let $ = "";
    return m.length > 0 && ($ = m.join(`
`) + `
`), g.length > 0 && ($ += g.join(`
`) + `
`), { stdout: $, stderr: "", exitCode: 0 };
  }
}, It = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(e.w || e.width || "75", 10);
    r.u;
    const c = r.s;
    if (isNaN(o) || o <= 0)
      return {
        stdout: "",
        stderr: `fmt: invalid width: '${e.w || e.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), a = i.split(`
`), l = [];
      let u = [];
      const d = () => {
        if (u.length !== 0) {
          if (c)
            for (const h of u)
              l.push(...q(h, o));
          else {
            const h = u.join(" ").trim();
            h && l.push(...q(h, o));
          }
          u = [];
        }
      };
      for (const h of a) {
        const f = h.trim();
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
function q(n, t) {
  const e = [], s = n.split(/\s+/);
  let r = "";
  for (const o of s)
    r.length === 0 ? r = o : r.length + 1 + o.length <= t ? r += " " + o : (e.push(r), r = o);
  return r.length > 0 && e.push(r), e;
}
const Nt = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(e.w || e.width || "80", 10);
    r.b;
    const c = r.s;
    if (isNaN(o) || o <= 0)
      return {
        stdout: "",
        stderr: `fold: invalid width: '${e.w || e.width}'
`,
        exitCode: 1
      };
    try {
      const { content: i } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), a = i.split(`
`), l = [];
      for (const u of a) {
        if (u.length <= o) {
          l.push(u);
          continue;
        }
        let d = u;
        for (; d.length > o; ) {
          let h = o;
          if (c) {
            const f = d.substring(0, o).lastIndexOf(" ");
            f > 0 && (h = f + 1);
          }
          l.push(d.substring(0, h)), d = d.substring(h);
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
}, kt = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.h, r = e.b, o = e.m, c = e.g, i = [], a = 8388608, l = 4194304, u = 4194304, d = 524288, h = 1048576, f = 5242880;
    return s ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), i.push("Swap:           2.0G          0B        2.0G")) : r ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:    ${a * 1024} ${l * 1024} ${u * 1024} ${d * 1024} ${h * 1024} ${f * 1024}`), i.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : o ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:           ${Math.floor(a / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(u / 1024)}         ${Math.floor(d / 1024)}        ${Math.floor(h / 1024)}        ${Math.floor(f / 1024)}`), i.push("Swap:          2048           0        2048")) : c ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:               8           4           4           0           1           5"), i.push("Swap:              2           0           2")) : (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:        ${a}     ${l}     ${u}      ${d}     ${h}     ${f}`), i.push("Swap:       2097152           0     2097152")), {
      stdout: i.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Mt = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["e"]), o = !!e.i, c = !!e.v, i = !!e.c, a = !!e.l, l = !!e.n, u = !!(e.r || e.R), d = s.e ?? r.shift();
    if (!d)
      return { stdout: "", stderr: `grep: missing pattern
`, exitCode: 2 };
    const h = o ? "i" : "";
    let f;
    try {
      f = new RegExp(d, h);
    } catch {
      return { stdout: "", stderr: `grep: invalid pattern: ${d}
`, exitCode: 2 };
    }
    const p = r.length > 0 ? r : ["-"], m = p.length > 1 || u, g = [];
    let x = !1;
    async function w($, C) {
      let S;
      try {
        if ($ === "-")
          S = t.stdin;
        else {
          const E = t.fs.resolvePath($, t.cwd);
          S = await t.fs.readFile(E);
        }
      } catch {
        g.push(`grep: ${$}: No such file or directory`);
        return;
      }
      const P = S.split(`
`);
      P.length > 0 && P[P.length - 1] === "" && P.pop();
      let j = 0;
      for (let E = 0; E < P.length; E++)
        if (f.test(P[E]) !== c && (x = !0, j++, !i && !a)) {
          const k = m ? `${C}:` : "", M = l ? `${E + 1}:` : "";
          g.push(`${k}${M}${P[E]}`);
        }
      i && g.push(m ? `${C}:${j}` : String(j)), a && j > 0 && g.push(C);
    }
    async function v($) {
      const C = t.fs.resolvePath($, t.cwd);
      let S;
      try {
        S = await t.fs.readdir(C);
      } catch {
        return;
      }
      for (const P of S) {
        const j = C + "/" + P.name;
        P.type === "dir" ? await v(j) : await w(j, j);
      }
    }
    for (const $ of p)
      if ($ === "-")
        await w("-", "(standard input)");
      else if (u) {
        const C = t.fs.resolvePath($, t.cwd);
        let S;
        try {
          S = await t.fs.stat(C);
        } catch {
          continue;
        }
        S.type === "dir" ? await v(C) : await w($, $);
      } else
        await w($, $);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, At = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await N(
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
}, Tt = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["n", "s", "C"]), o = r.C, c = e.n ? parseInt(e.n) : void 0, i = e.s ? parseInt(e.s) : 0;
    try {
      const { content: a } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let l = a.substring(i, c ? i + c : void 0);
      const u = [];
      if (o) {
        for (let h = 0; h < l.length; h += 16) {
          const f = l.substring(h, h + 16), p = (i + h).toString(16).padStart(8, "0"), m = z(f.substring(0, 8)), g = z(f.substring(8, 16)), x = Rt(f);
          u.push(`${p}  ${m}  ${g}  |${x}|`);
        }
        const d = (i + l.length).toString(16).padStart(8, "0");
        u.push(d);
      } else {
        for (let h = 0; h < l.length; h += 16) {
          const f = l.substring(h, h + 16), p = (i + h).toString(16).padStart(7, "0"), m = [];
          for (let g = 0; g < f.length; g += 2) {
            const x = f.charCodeAt(g), w = g + 1 < f.length ? f.charCodeAt(g + 1) : 0, v = (x << 8 | w).toString(16).padStart(4, "0");
            m.push(v);
          }
          u.push(`${p} ${m.join(" ")}`);
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
    } catch (a) {
      return {
        stdout: "",
        stderr: `hexdump: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
function z(n) {
  const t = [];
  for (let e = 0; e < 8; e++)
    e < n.length ? t.push(n.charCodeAt(e).toString(16).padStart(2, "0")) : t.push("  ");
  return t.join(" ");
}
function Rt(n) {
  let t = "";
  for (let e = 0; e < 16; e++)
    if (e < n.length) {
      const s = n.charCodeAt(e);
      t += s >= 32 && s < 127 ? n[e] : ".";
    } else
      t += " ";
  return t;
}
const Dt = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, Wt = {
  name: "id",
  description: "Print user identity",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), r = e[0] || t.env.USER || "user", o = s.u || s.user, c = s.g || s.group, i = s.G || s.groups, a = s.n || s.name;
    s.r || s.real;
    const l = 1e3, u = 1e3, d = [1e3], h = r, f = "users", p = [];
    if (o)
      a ? p.push(h) : p.push(String(l));
    else if (c)
      a ? p.push(f) : p.push(String(u));
    else if (i)
      a ? p.push(f) : p.push(d.join(" "));
    else {
      const m = d.map((g) => `${g}(${f})`).join(",");
      p.push(`uid=${l}(${h}) gid=${u}(${f}) groups=${m}`);
    }
    return {
      stdout: p.join(`
`) + (p.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, Lt = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    e.m || e.mode;
    const o = e.t || e["target-directory"], c = r.d || r.directory, i = r.v || r.verbose;
    if (s.length === 0)
      return { stdout: "", stderr: `install: missing operand
`, exitCode: 1 };
    const a = [];
    try {
      if (c)
        for (const l of s) {
          const u = t.fs.resolvePath(l, t.cwd);
          await t.fs.mkdir(u, { recursive: !0 }), i && a.push(`install: creating directory '${l}'`);
        }
      else if (o) {
        const l = t.fs.resolvePath(o, t.cwd);
        for (const u of s) {
          const d = t.fs.resolvePath(u, t.cwd), h = u.split("/").pop() || u, f = l + "/" + h, p = await t.fs.readFile(d);
          await t.fs.writeFile(f, p), i && a.push(`'${u}' -> '${o}/${h}'`);
        }
      } else {
        if (s.length < 2)
          return { stdout: "", stderr: `install: missing destination
`, exitCode: 1 };
        const l = s[s.length - 1], u = s.slice(0, -1), d = t.fs.resolvePath(l, t.cwd);
        let h = !1;
        try {
          h = (await t.fs.stat(d)).type === "dir";
        } catch {
          h = u.length > 1;
        }
        if (h && u.length > 1)
          for (const f of u) {
            const p = t.fs.resolvePath(f, t.cwd), m = f.split("/").pop() || f, g = d + "/" + m, x = await t.fs.readFile(p);
            await t.fs.writeFile(g, x), i && a.push(`'${f}' -> '${l}/${m}'`);
          }
        else {
          const f = t.fs.resolvePath(u[0], t.cwd), p = await t.fs.readFile(f);
          await t.fs.writeFile(d, p), i && a.push(`'${u[0]}' -> '${l}'`);
        }
      }
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
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
}, Ot = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["1", "2", "t", "o"]);
    if (s.length < 2)
      return {
        stdout: "",
        stderr: `join: missing file operand
`,
        exitCode: 1
      };
    const o = e[1] ? parseInt(e[1]) - 1 : 0, c = e[2] ? parseInt(e[2]) - 1 : 0, i = e.t || /\s+/, a = e.o, l = r.i;
    try {
      const u = t.fs.resolvePath(s[0], t.cwd), d = t.fs.resolvePath(s[1], t.cwd), h = await t.fs.readFile(u), f = await t.fs.readFile(d), p = h.split(`
`).filter(($) => $.trim() !== ""), m = f.split(`
`).filter(($) => $.trim() !== ""), g = ($) => $.map((C) => C.split(i)), x = g(p), w = g(m), v = /* @__PURE__ */ new Map();
      for (const $ of w) {
        const C = ($[c] || "").trim(), S = l ? C.toLowerCase() : C;
        v.has(S) || v.set(S, []), v.get(S).push($);
      }
      const b = [];
      for (const $ of x) {
        const C = ($[o] || "").trim(), S = l ? C.toLowerCase() : C, P = v.get(S) || [];
        for (const j of P) {
          let E;
          if (a)
            E = a.split(",").map((k) => {
              const [M, F] = k.split(".").map((T) => parseInt(T));
              return (M === 1 ? $ : j)[F - 1] || "";
            }).join(" ");
          else {
            const R = $[o] || "", k = $.filter((F, I) => I !== o), M = j.filter((F, I) => I !== c);
            E = [R, ...k, ...M].join(" ");
          }
          b.push(E);
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
}, qt = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), o = r.split(`
`), c = e.N || e.n;
      let i = "";
      return c ? i = o.map((a, l) => `${String(l + 1).padStart(6)}  ${a}`).join(`
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
}, zt = {
  name: "ln",
  description: "Make links between files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.s, o = e.f, c = e.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const i = t.fs.resolvePath(s[0], t.cwd), a = t.fs.resolvePath(s[1], t.cwd), l = [];
    try {
      if (await t.fs.exists(a))
        if (o)
          try {
            await t.fs.unlink(a);
          } catch {
          }
        else
          return {
            stdout: "",
            stderr: `ln: ${a}: File exists
`,
            exitCode: 1
          };
      if (r && t.fs.symlink)
        await t.fs.symlink(i, a), c && l.push(`'${a}' -> '${i}'`);
      else {
        const u = await t.fs.readFile(i);
        await t.fs.writeFile(a, u), c && l.push(`'${a}' => '${i}'`);
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
}, Ut = {
  name: "ls",
  description: "List directory contents",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = s.length > 0 ? s : ["."], o = e.a, c = e.l, i = e.h, a = [];
    for (const l of r) {
      const u = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(u);
      if (d.type === "file") {
        a.push(c ? U(u.split("/").pop(), d, i) : u.split("/").pop());
        continue;
      }
      r.length > 1 && a.push(`${l}:`);
      const h = await t.fs.readdir(u), f = o ? h : h.filter((p) => !p.name.startsWith("."));
      if (f.sort((p, m) => p.name.localeCompare(m.name)), c) {
        a.push(`total ${f.length}`);
        for (const p of f)
          a.push(U(p.name, p, i));
      } else
        a.push(f.map((p) => p.type === "dir" ? p.name + "/" : p.name).join("  "));
    }
    return { stdout: a.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function U(n, t, e) {
  const s = t.type === "dir" ? "d" : "-", r = t.mode ?? (t.type === "dir" ? 493 : 420), o = Ht(r), c = e ? Bt(t.size) : String(t.size).padStart(8), i = new Date(t.mtime), a = Gt(i);
  return `${s}${o}  1 user user ${c} ${a} ${n}`;
}
function Ht(n) {
  let e = "";
  for (let s = 2; s >= 0; s--) {
    const r = n >> s * 3 & 7;
    for (let o = 2; o >= 0; o--)
      e += r & 1 << o ? "rwx"[2 - o] : "-";
  }
  return e;
}
function Gt(n) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), r = String(n.getHours()).padStart(2, "0"), o = String(n.getMinutes()).padStart(2, "0");
  return `${e} ${s} ${r}:${o}`;
}
function Bt(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const Jt = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["f", "file", "C", "j"]), o = e.f || e.file || "Makefile", c = e.C;
    e.j;
    const i = r.n || r["dry-run"], a = r.p || r.print, l = s.length > 0 ? s : ["all"];
    try {
      const u = c ? t.fs.resolvePath(c, t.cwd) : t.cwd, d = t.fs.resolvePath(o, u);
      let h;
      try {
        h = await t.fs.readFile(d);
      } catch {
        return {
          stdout: "",
          stderr: `make: ${o}: No such file or directory
`,
          exitCode: 2
        };
      }
      const f = _t(h), p = [];
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
              a || i ? p.push(v) : p.push(`# ${v}`);
        }
        for (const x of g.commands)
          a || i ? p.push(x) : p.push(`# ${x}`);
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
        stderr: `make: ${u instanceof Error ? u.message : u}
`,
        exitCode: 2
      };
    }
  }
};
function _t(n) {
  const t = /* @__PURE__ */ new Map(), e = n.split(`
`);
  let s = null;
  for (let r = 0; r < e.length; r++) {
    const o = e[r];
    if (!(o.trim().startsWith("#") || o.trim() === ""))
      if (o.includes(":") && !o.startsWith("	")) {
        const c = o.indexOf(":"), i = o.substring(0, c).trim(), a = o.substring(c + 1).trim(), l = a ? a.split(/\s+/) : [];
        s = { target: i, prerequisites: l, commands: [] }, t.set(i, s);
      } else o.startsWith("	") && s && s.commands.push(o.substring(1));
  }
  return t;
}
const Yt = {
  name: "md5sum",
  description: "Compute MD5 message digest",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.c || e.check, o = e.b || e.binary;
    if (r)
      return {
        stdout: "",
        stderr: `md5sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const c = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const a of c) {
        let l;
        if (a === "-")
          l = t.stdin;
        else {
          const h = t.fs.resolvePath(a, t.cwd);
          l = await t.fs.readFile(h);
        }
        const u = await Kt(l), d = o ? "*" : " ";
        i.push(`${u}${d}${a === "-" ? "-" : a}`);
      }
      return {
        stdout: i.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `md5sum: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
async function Kt(n) {
  let t = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    t = (t << 5) - t + r, t = t & t;
  }
  return Math.abs(t).toString(16).padStart(32, "0");
}
const Zt = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.p;
    if (s.length === 0)
      return { stdout: "", stderr: `mkdir: missing operand
`, exitCode: 1 };
    try {
      for (const o of s) {
        const c = t.fs.resolvePath(o, t.cwd);
        await t.fs.mkdir(c, { recursive: r });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `mkdir: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, Vt = {
  name: "mv",
  description: "Move or rename files",
  async exec(n, t) {
    const { positional: e } = y(n);
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
      for (const c of r) {
        const i = t.fs.resolvePath(c, t.cwd), a = c.split("/").pop(), l = o ? s + "/" + a : s;
        await t.fs.rename(i, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `mv: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, Xt = {
  name: "nl",
  description: "Number lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["b", "s", "w", "n", "v"]), o = e.b || "t", c = e.s || "	", i = parseInt(e.w || "6", 10), a = e.n || "rn", l = parseInt(e.v || "1", 10);
    r.p;
    const u = r.ba;
    try {
      const { content: d } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), h = d.split(`
`), f = [];
      let p = l;
      for (const m of h) {
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
          const w = Qt(p, i, a);
          f.push(w + c + m), p++;
        } else
          f.push(" ".repeat(i) + c + m);
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
function Qt(n, t, e) {
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
const te = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "N", "j", "w", "A"]), o = e.t || "o2", c = e.N ? parseInt(e.N) : void 0, i = e.j ? parseInt(e.j) : 0, a = e.w ? parseInt(e.w) : 16, l = e.A || "o", u = r.b || r.c || r.d || r.o || r.s || r.x;
    try {
      const { content: d } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let h = d.substring(i, c ? i + c : void 0);
      const f = [];
      let p = "o", m = 2;
      u ? r.b ? (p = "o", m = 1) : r.c ? (p = "c", m = 1) : r.d || r.s ? (p = "d", m = 2) : r.o ? (p = "o", m = 2) : r.x && (p = "x", m = 2) : o && (p = o[0] || "o", m = parseInt(o.substring(1)) || 2);
      let g = i;
      for (let x = 0; x < h.length; x += a) {
        const w = h.substring(x, x + a), v = H(g, l), b = ee(w, p, m);
        f.push(`${v} ${b}`), g += w.length;
      }
      return l !== "n" && f.push(H(g, l)), {
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
function H(n, t) {
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
function ee(n, t, e) {
  const s = [];
  for (let r = 0; r < n.length; r += e) {
    const o = n.substring(r, r + e);
    let c = 0;
    for (let i = 0; i < o.length; i++)
      c = c << 8 | o.charCodeAt(i);
    switch (t) {
      case "o":
        s.push(c.toString(8).padStart(e * 3, "0"));
        break;
      case "x":
        s.push(c.toString(16).padStart(e * 2, "0"));
        break;
      case "d":
        s.push(c.toString(10).padStart(e * 3, " "));
        break;
      case "c":
        s.push(se(o.charCodeAt(0)));
        break;
      case "a":
        s.push(ne(o.charCodeAt(0)));
        break;
      default:
        s.push(c.toString(8).padStart(e * 3, "0"));
    }
  }
  return s.join(" ");
}
function se(n) {
  return n >= 32 && n < 127 ? `  ${String.fromCharCode(n)}` : n === 0 ? " \\0" : n === 7 ? " \\a" : n === 8 ? " \\b" : n === 9 ? " \\t" : n === 10 ? " \\n" : n === 11 ? " \\v" : n === 12 ? " \\f" : n === 13 ? " \\r" : n.toString(8).padStart(3, "0");
}
function ne(n) {
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
const re = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["d", "delimiters"]), o = e.d || e.delimiters || "	", c = r.s;
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
`).filter((d, h, f) => h < f.length - 1 || d !== ""));
      }
      const a = [];
      if (c)
        for (const l of i) {
          const u = o.split(""), d = [];
          for (let h = 0; h < l.length; h++)
            d.push(l[h]), h < l.length - 1 && d.push(u[h % u.length]);
          a.push(d.join(""));
        }
      else {
        const l = Math.max(...i.map((d) => d.length)), u = o.split("");
        for (let d = 0; d < l; d++) {
          const h = [];
          for (let f = 0; f < i.length; f++) {
            const p = i[f][d] || "";
            h.push(p), f < i.length - 1 && h.push(u[f % u.length]);
          }
          a.push(h.join(""));
        }
      }
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
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
}, oe = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["p", "i", "input", "o", "output"]), o = e.p ? parseInt(e.p) : 0, c = e.i || e.input, i = e.o || e.output, a = r.R || r.reverse, l = r["dry-run"];
    try {
      let u;
      if (c) {
        const f = t.fs.resolvePath(c, t.cwd);
        u = await t.fs.readFile(f);
      } else if (s.length > 0) {
        const f = t.fs.resolvePath(s[0], t.cwd);
        u = await t.fs.readFile(f);
      } else
        u = t.stdin;
      const d = ie(u), h = [];
      for (const f of d) {
        const p = G(f.newFile, o), m = G(f.oldFile, o);
        if (h.push(`patching file ${p}`), !l) {
          let g;
          try {
            const w = t.fs.resolvePath(p, t.cwd);
            g = await t.fs.readFile(w);
          } catch {
            g = "";
          }
          const x = ae(g, f.hunks, a);
          if (i) {
            const w = t.fs.resolvePath(i, t.cwd);
            await t.fs.writeFile(w, x);
          } else {
            const w = t.fs.resolvePath(p, t.cwd);
            await t.fs.writeFile(w, x);
          }
        }
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
        stderr: `patch: ${u instanceof Error ? u.message : u}
`,
        exitCode: 1
      };
    }
  }
};
function ie(n) {
  const t = [], e = n.split(`
`);
  let s = null, r = null;
  for (const o of e)
    if (o.startsWith("--- "))
      s = { oldFile: o.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (o.startsWith("+++ ") && s)
      s.newFile = o.substring(4).split("	")[0], t.push(s);
    else if (o.startsWith("@@ ") && s) {
      const c = o.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      c && (r = {
        oldStart: parseInt(c[1]),
        oldLines: parseInt(c[2]),
        newStart: parseInt(c[3]),
        newLines: parseInt(c[4]),
        lines: []
      }, s.hunks.push(r));
    } else r && (o.startsWith(" ") || o.startsWith("+") || o.startsWith("-")) && r.lines.push(o);
  return t;
}
function G(n, t) {
  return n.split("/").slice(t).join("/");
}
function ae(n, t, e) {
  const s = n.split(`
`);
  for (const r of t) {
    const o = r.oldStart - 1, c = r.oldLines, i = [];
    for (const a of r.lines) {
      const l = a[0], u = a.substring(1);
      if (e) {
        if (l === "+")
          continue;
        i.push(u);
      } else
        (l === "+" || l === " ") && i.push(u);
    }
    s.splice(o, c, ...i);
  }
  return s.join(`
`);
}
const ce = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), r = s[0] || s.null;
    if (e.length === 0) {
      const o = [];
      for (const [i, a] of Object.entries(t.env))
        o.push(`${i}=${a}`);
      const c = r ? "\0" : `
`;
      return {
        stdout: o.join(c) + (o.length > 0 ? c : ""),
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
      const c = r ? "\0" : `
`;
      return {
        stdout: o.join(c) + (o.length > 0 ? c : ""),
        stderr: "",
        exitCode: 0
      };
    }
  }
}, le = {
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
          let c = "";
          for (; o < t.length && !/[sdf]/.test(t[o]); )
            c += t[o], o++;
          const i = t[o] ?? "s";
          o++;
          const a = e[s++] ?? "";
          switch (i) {
            case "s":
              r += a;
              break;
            case "d":
              r += String(parseInt(a, 10) || 0);
              break;
            case "f": {
              const l = c.includes(".") ? parseInt(c.split(".")[1], 10) : 6;
              r += (parseFloat(a) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        r += t[o], o++;
    return { stdout: r, stderr: "", exitCode: 0 };
  }
}, de = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, ue = {
  name: "read",
  description: "Read a line from stdin",
  async exec(n, t) {
    return y(n, ["p", "n"]), t.stdin, {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, fe = {
  name: "readlink",
  description: "Print resolved symbolic links or canonical file names",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.f;
    if (s.length === 0)
      return { stdout: "", stderr: `readlink: missing operand
`, exitCode: 1 };
    const o = t.fs.resolvePath(s[0], t.cwd);
    return r ? { stdout: o + `
`, stderr: "", exitCode: 0 } : { stdout: o + `
`, stderr: "", exitCode: 0 };
  }
}, pe = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const r = e.q || e.quiet, o = !e.s;
    e.s;
    const c = [], i = [];
    for (const u of s)
      try {
        let d = t.fs.resolvePath(u, t.cwd);
        if (o) {
          const h = d.split("/").filter((p) => p !== "" && p !== "."), f = [];
          for (const p of h)
            p === ".." ? f.length > 0 && f.pop() : f.push(p);
          d = "/" + f.join("/");
        }
        await t.fs.exists(d) ? c.push(d) : r || i.push(`realpath: ${u}: No such file or directory`);
      } catch (d) {
        r || i.push(`realpath: ${u}: ${d instanceof Error ? d.message : d}`);
      }
    const a = i.length > 0 ? i.join(`
`) + `
` : "", l = i.length > 0 ? 1 : 0;
    return {
      stdout: c.join(`
`) + (c.length > 0 ? `
` : ""),
      stderr: a,
      exitCode: l
    };
  }
}, he = {
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
}, me = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.r || e.R, o = e.f;
    if (s.length === 0 && !o)
      return { stdout: "", stderr: `rm: missing operand
`, exitCode: 1 };
    async function c(i) {
      const a = await t.fs.readdir(i);
      for (const l of a) {
        const u = i + "/" + l.name;
        l.type === "dir" ? await c(u) : await t.fs.unlink(u);
      }
      await t.fs.rmdir(i);
    }
    try {
      for (const i of s) {
        const a = t.fs.resolvePath(i, t.cwd);
        let l;
        try {
          l = await t.fs.stat(a);
        } catch {
          if (o) continue;
          return { stdout: "", stderr: `rm: cannot remove '${i}': No such file or directory
`, exitCode: 1 };
        }
        if (l.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `rm: cannot remove '${i}': Is a directory
`, exitCode: 1 };
          await c(a);
        } else
          await t.fs.unlink(a);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, ge = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.i, o = s.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const c = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!c)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
`, exitCode: 1 };
    const [, , i, a, l] = c, u = l.includes("g"), d = l.includes("i");
    let h;
    try {
      const f = (u ? "g" : "") + (d ? "i" : "");
      h = new RegExp(i, f);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${i}
`, exitCode: 2 };
    }
    try {
      const { content: f, files: p } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), m = f.split(`
`).map((g) => g.replace(h, a)).join(`
`);
      if (r && p.length > 0) {
        for (const g of p) {
          const x = t.fs.resolvePath(g, t.cwd), v = (await t.fs.readFile(x)).split(`
`).map((b) => b.replace(h, a)).join(`
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
}, xe = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["separator", "s", "format", "f"]);
    if (r.length === 0)
      return { stdout: "", stderr: `seq: missing operand
`, exitCode: 1 };
    let o = 1, c = 1, i;
    if (r.length === 1 ? i = parseFloat(r[0]) : r.length === 2 ? (o = parseFloat(r[0]), i = parseFloat(r[1])) : r.length >= 3 ? (o = parseFloat(r[0]), c = parseFloat(r[1]), i = parseFloat(r[2])) : i = 1, isNaN(o) || isNaN(c) || isNaN(i))
      return {
        stdout: "",
        stderr: `seq: invalid number
`,
        exitCode: 1
      };
    if (c === 0)
      return {
        stdout: "",
        stderr: `seq: increment must not be 0
`,
        exitCode: 1
      };
    const a = s.s || s.separator || `
`, l = s.f || s.format, u = e.w, d = [];
    if (c > 0)
      for (let p = o; p <= i; p += c)
        d.push(String(p));
    else
      for (let p = o; p >= i; p += c)
        d.push(String(p));
    if (u) {
      const p = Math.max(...d.map((m) => m.length));
      for (let m = 0; m < d.length; m++)
        d[m] = d[m].padStart(p, "0");
    }
    if (l && typeof l == "string")
      for (let p = 0; p < d.length; p++) {
        const m = parseFloat(d[p]);
        l.includes("%g") || l.includes("%d") || l.includes("%i") ? d[p] = l.replace(/%[gdi]/, String(m)) : l.includes("%f") ? d[p] = l.replace(/%f/, m.toFixed(6)) : l.includes("%e") && (d[p] = l.replace(/%e/, m.toExponential()));
      }
    return {
      stdout: d.join(a) + ((typeof a == "string" ? a : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, ye = {
  name: "sha256sum",
  description: "Compute SHA256 message digest",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.c || e.check, o = e.b || e.binary;
    if (r)
      return {
        stdout: "",
        stderr: `sha256sum: --check not implemented in browser environment
`,
        exitCode: 1
      };
    const c = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const a of c) {
        let l;
        if (a === "-")
          l = t.stdin;
        else {
          const h = t.fs.resolvePath(a, t.cwd);
          l = await t.fs.readFile(h);
        }
        const u = await we(l), d = o ? "*" : " ";
        i.push(`${u}${d}${a === "-" ? "-" : a}`);
      }
      return {
        stdout: i.join(`
`) + `
`,
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `sha256sum: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
async function we(n) {
  const t = globalThis;
  if (typeof t.crypto < "u" && t.crypto.subtle) {
    const r = new t.TextEncoder().encode(n), o = await t.crypto.subtle.digest("SHA-256", r);
    return Array.from(new t.Uint8Array(o)).map((a) => a.toString(16).padStart(2, "0")).join("");
  }
  let e = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    e = (e << 5) - e + r, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(64, "0");
}
const $e = {
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
}, Ce = {
  name: "sleep",
  description: "Delay for a specified amount of time",
  async exec(n, t) {
    const { positional: e } = y(n);
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
    const c = parseFloat(o[1]);
    switch (o[2] || "s") {
      case "s":
        r = c;
        break;
      case "m":
        r = c * 60;
        break;
      case "h":
        r = c * 3600;
        break;
      case "d":
        r = c * 86400;
        break;
    }
    return await new Promise((a) => globalThis.setTimeout(a, r * 1e3)), { stdout: "", stderr: "", exitCode: 0 };
  }
}, ve = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let o = r.split(`
`).filter(Boolean);
      return e.n ? o.sort((c, i) => parseFloat(c) - parseFloat(i)) : o.sort(), e.u && (o = [...new Set(o)]), e.r && o.reverse(), { stdout: o.join(`
`) + `
`, stderr: "", exitCode: 0 };
    } catch (r) {
      return { stdout: "", stderr: `sort: ${r instanceof Error ? r.message : r}
`, exitCode: 1 };
    }
  }
}, Y = {
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
      const r = t.fs.resolvePath(s, t.cwd), o = await t.fs.readFile(r);
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
}, be = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(n, t) {
    return Y.exec(n, t);
  }
}, Se = {
  name: "stat",
  description: "Display file status",
  async exec(n, t) {
    const { positional: e, flags: s, values: r } = y(n, ["c", "format"]);
    if (e.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const o = r.c || r.format, c = s.t;
    s.f;
    const i = [];
    try {
      for (const a of e) {
        const l = t.fs.resolvePath(a, t.cwd);
        try {
          const u = await t.fs.stat(l);
          if (o) {
            const d = Pe(a, u, o);
            i.push(d);
          } else if (c)
            i.push(`${a} ${u.size} 0 ${u.mode} 0 0 0 0 0 0 ${u.mtime}`);
          else {
            const d = u.type === "dir" ? "directory" : "regular file", h = K(u.mode), f = new Date(u.mtime).toISOString();
            i.push(`  File: ${a}`), i.push(`  Size: ${u.size}	Blocks: 0	IO Block: 4096	${d}`), i.push("Device: 0	Inode: 0	Links: 1"), i.push(`Access: (${h})	Uid: (0/root)	Gid: (0/root)`), i.push(`Access: ${f}`), i.push(`Modify: ${f}`), i.push(`Change: ${f}`);
          }
        } catch (u) {
          i.push(`stat: cannot stat '${a}': ${u instanceof Error ? u.message : u}`);
        }
      }
      return {
        stdout: i.join(`
`) + (i.length > 0 ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `stat: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
};
function K(n) {
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
function Pe(n, t, e) {
  return e.replace(/%n/g, n).replace(/%N/g, `'${n}'`).replace(/%s/g, String(t.size)).replace(/%b/g, "0").replace(/%f/g, t.mode.toString(16)).replace(/%a/g, t.mode.toString(8)).replace(/%A/g, K(t.mode).split("/")[1]).replace(/%F/g, t.type === "dir" ? "directory" : "regular file").replace(/%u/g, "0").replace(/%g/g, "0").replace(/%U/g, "root").replace(/%G/g, "root").replace(/%i/g, "0").replace(/%h/g, "1").replace(/%W/g, String(Math.floor(t.mtime / 1e3))).replace(/%X/g, String(Math.floor(t.mtime / 1e3))).replace(/%Y/g, String(Math.floor(t.mtime / 1e3))).replace(/%y/g, new Date(t.mtime).toISOString()).replace(/%%/g, "%");
}
const je = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["n", "bytes"]), o = parseInt(e.n || e.bytes || "4", 10), c = r.f;
    r.a;
    try {
      const i = s.length > 0 ? s : ["-"], a = [];
      for (const l of i) {
        let u, d = l;
        if (l === "-")
          u = t.stdin, d = "(standard input)";
        else {
          const f = t.fs.resolvePath(l, t.cwd);
          u = await t.fs.readFile(f);
        }
        const h = Fe(u, o);
        for (const f of h)
          c ? a.push(`${d}: ${f}`) : a.push(f);
      }
      return {
        stdout: a.join(`
`) + (a.length > 0 ? `
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
function Fe(n, t) {
  const e = [], s = /[ -~]/;
  let r = "";
  for (let o = 0; o < n.length; o++) {
    const c = n[o];
    s.test(c) ? r += c : (r.length >= t && e.push(r), r = "");
  }
  return r.length >= t && e.push(r), e;
}
const Ee = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await N(
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
}, Ie = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["f", "C"]), o = e.c || e.create, c = e.x || e.extract, i = e.t || e.list, a = e.v || e.verbose, l = s.f, u = s.C;
    let d = t.cwd;
    u && (d = t.fs.resolvePath(u, t.cwd));
    const h = [o, c, i].filter(Boolean).length;
    if (h === 0)
      return { stdout: "", stderr: `tar: You must specify one of -c, -x, or -t
`, exitCode: 1 };
    if (h > 1)
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
        const p = [];
        async function m(v, b) {
          const $ = t.fs.resolvePath(v, d);
          if ((await t.fs.stat($)).type === "dir") {
            p.push({ path: b + "/", content: "", isDir: !0 });
            const S = await t.fs.readdir($);
            for (const P of S)
              await m($ + "/" + P.name, b + "/" + P.name);
          } else {
            const S = await t.fs.readFile($);
            p.push({ path: b, content: S, isDir: !1 });
          }
        }
        for (const v of f)
          await m(v, v);
        const g = ["FLUFFY-TAR-V1"];
        for (const v of p)
          a && (t.stderr || console.error(v.path)), g.push(`FILE:${v.path}`), g.push(`SIZE:${v.content.length}`), g.push(`TYPE:${v.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push(v.content), g.push("DATA-END");
        const x = g.join(`
`), w = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(w, x), {
          stdout: a ? p.map((v) => v.path).join(`
`) + `
` : "",
          stderr: "",
          exitCode: 0
        };
      }
      if (c) {
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
          const $ = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            $.push(m[g]), g++;
          const C = $.join(`
`);
          g++;
          const S = t.fs.resolvePath(w, d);
          if (b === "dir")
            await t.fs.mkdir(S, { recursive: !0 });
          else {
            const P = S.lastIndexOf("/");
            if (P > 0) {
              const j = S.slice(0, P);
              try {
                await t.fs.mkdir(j, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(S, C);
          }
          x.push(w), a && (t.stderr || console.error(w));
        }
        return {
          stdout: a ? x.join(`
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
}, Ne = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.a, o = t.stdin;
    try {
      for (const c of s) {
        const i = t.fs.resolvePath(c, t.cwd);
        if (r) {
          let a = "";
          try {
            a = await t.fs.readFile(i);
          } catch {
          }
          await t.fs.writeFile(i, a + o);
        } else
          await t.fs.writeFile(i, o);
      }
      return { stdout: o, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: o, stderr: `tee: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, ke = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(n, t) {
    const e = n[n.length - 1] === "]" ? n.slice(0, -1) : [...n];
    try {
      return { stdout: "", stderr: "", exitCode: await D(e, t) ? 0 : 1 };
    } catch (s) {
      return { stdout: "", stderr: `test: ${s instanceof Error ? s.message : s}
`, exitCode: 2 };
    }
  }
};
async function D(n, t) {
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
          const c = t.fs.resolvePath(o, t.cwd), i = await t.fs.stat(c);
          return r === "-f" ? i.type === "file" : r === "-d" ? i.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (n[0] === "!" && n.length > 1)
    return !await D(n.slice(1), t);
  if (n.length === 3) {
    const [r, o, c] = n;
    switch (o) {
      case "=":
      case "==":
        return r === c;
      case "!=":
        return r !== c;
      case "-eq":
        return parseInt(r) === parseInt(c);
      case "-ne":
        return parseInt(r) !== parseInt(c);
      case "-lt":
        return parseInt(r) < parseInt(c);
      case "-le":
        return parseInt(r) <= parseInt(c);
      case "-gt":
        return parseInt(r) > parseInt(c);
      case "-ge":
        return parseInt(r) >= parseInt(c);
    }
  }
  const e = n.indexOf("-a");
  if (e > 0)
    return await D(n.slice(0, e), t) && await D(n.slice(e + 1), t);
  const s = n.indexOf("-o");
  return s > 0 ? await D(n.slice(0, s), t) || await D(n.slice(s + 1), t) : !1;
}
const Me = {
  name: "time",
  description: "Time a command execution",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const r = s.v || s.verbose, o = s.p, c = e.join(" "), i = globalThis.performance, a = i ? i.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const d = ((i ? i.now() : Date.now()) - a) / 1e3, h = Math.floor(d / 60), f = d % 60;
    let p;
    return o ? p = `real ${d.toFixed(2)}
user 0.00
sys 0.00
` : r ? p = `        ${d.toFixed(3)} real         0.000 user         0.000 sys
` : p = `
real    ${h}m${f.toFixed(3)}s
user    0m0.000s
sys     0m0.000s
`, {
      stdout: "",
      stderr: `Command: ${c}
${p}`,
      exitCode: 0
    };
  }
}, Ae = {
  name: "timeout",
  description: "Run a command with a time limit",
  async exec(n, t) {
    const { positional: e, flags: s, values: r } = y(n, ["k", "kill-after", "s", "signal"]);
    if (e.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing duration
`,
        exitCode: 1
      };
    const o = e[0], c = e.slice(1);
    if (c.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let i = Te(o);
    if (i === null)
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${o}'
`,
        exitCode: 1
      };
    r.k || r["kill-after"];
    const a = r.s || r.signal || "TERM", l = s["preserve-status"];
    s.foreground;
    const u = s.v || s.verbose;
    try {
      const d = c.join(" ");
      if (u)
        return {
          stdout: "",
          stderr: `timeout: would run command '${d}' with ${i}s timeout using signal ${a}
`,
          exitCode: 0
        };
      const h = i * 1e3;
      let f = !1;
      if (await new Promise((p) => {
        const m = globalThis.setTimeout(() => {
          f = !0, p(null);
        }, h);
        globalThis.clearTimeout(m), p(null);
      }), f) {
        const p = l ? 143 : 124;
        return {
          stdout: "",
          stderr: `timeout: command '${d}' timed out after ${i}s
`,
          exitCode: p
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
function Te(n) {
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
const Re = {
  name: "touch",
  description: "Change file timestamps or create empty files",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `touch: missing operand
`, exitCode: 1 };
    const r = s.c;
    try {
      for (const o of e) {
        const c = t.fs.resolvePath(o, t.cwd);
        let i = !1;
        try {
          await t.fs.stat(c), i = !0;
        } catch {
          i = !1;
        }
        if (i) {
          const a = await t.fs.readFile(c);
          await t.fs.writeFile(c, a);
        } else {
          if (r)
            continue;
          await t.fs.writeFile(c, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `touch: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, De = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.d, o = e.s, c = B(s[0] ?? ""), i = B(s[1] ?? ""), a = t.stdin;
    let l;
    if (r) {
      const u = new Set(c.split(""));
      l = a.split("").filter((d) => !u.has(d)).join("");
    } else if (c && i) {
      const u = /* @__PURE__ */ new Map();
      for (let d = 0; d < c.length; d++)
        u.set(c[d], i[Math.min(d, i.length - 1)]);
      l = a.split("").map((d) => u.get(d) ?? d).join("");
    } else
      l = a;
    if (o && i) {
      const u = new Set(i.split(""));
      let d = "", h = "";
      for (const f of l)
        u.has(f) && f === h || (d += f, h = f);
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
      const r = t.charCodeAt(s), o = t.charCodeAt(s + 2);
      for (let c = r; c <= o; c++)
        e += String.fromCharCode(c);
      s += 3;
    } else
      e += t[s], s++;
  return e;
}
const We = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, Le = {
  name: "type",
  description: "Display information about command type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `type: missing operand
`, exitCode: 1 };
    const r = s.a, o = s.t, c = s.p, i = [];
    let a = 0;
    for (const l of e) {
      const u = (t.env.PATH || "/bin:/usr/bin").split(":");
      let d = !1;
      for (const h of u) {
        const f = h + "/" + l;
        try {
          if (await t.fs.exists(f) && (d = !0, o ? i.push("file") : c ? i.push(f) : i.push(`${l} is ${f}`), !r))
            break;
        } catch {
        }
      }
      d || (!o && !c && i.push(`type: ${l}: not found`), a = 1);
    }
    return {
      stdout: i.join(`
`) + (i.length > 0 ? `
` : ""),
      stderr: "",
      exitCode: a
    };
  }
}, Oe = {
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
}, qe = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "tabs"]), o = e.t || e.tabs || "8", c = parseInt(o, 10);
    if (isNaN(c) || c <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.a || r.all;
    try {
      const { content: a } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), l = a.split(`
`), u = [];
      for (const d of l) {
        let h = "", f = 0, p = 0;
        for (let m = 0; m < d.length; m++) {
          const g = d[m];
          g === " " ? (p++, f++, f % c === 0 && (i || h.trim() === "" ? (p >= c && (h += "	".repeat(Math.floor(p / c)), p = p % c), p > 0 && (h += " ".repeat(p), p = 0)) : (h += " ".repeat(p), p = 0))) : (p > 0 && (h += " ".repeat(p), p = 0), h += g, f++);
        }
        p > 0 && (h += " ".repeat(p)), u.push(h);
      }
      return {
        stdout: u.join(`
`) + (a.endsWith(`
`) ? `
` : ""),
        stderr: "",
        exitCode: 0
      };
    } catch (a) {
      return {
        stdout: "",
        stderr: `unexpand: ${a instanceof Error ? a.message : a}
`,
        exitCode: 1
      };
    }
  }
}, ze = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["f", "s", "w"]), o = r.f ? parseInt(r.f) : 0, c = r.s ? parseInt(r.s) : 0, i = r.w ? parseInt(r.w) : void 0, a = e.i;
    try {
      const { content: l } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = l.split(`
`);
      u.length > 0 && u[u.length - 1] === "" && u.pop();
      const d = [];
      let h = "", f = "", p = 0;
      for (const m of u) {
        const g = Ue(m, o, c, i, a);
        g === f ? p++ : (p > 0 && J(h, p, e, d), h = m, f = g, p = 1);
      }
      return p > 0 && J(h, p, e, d), { stdout: d.join(`
`) + (d.length > 0 ? `
` : ""), stderr: "", exitCode: 0 };
    } catch (l) {
      return { stdout: "", stderr: `uniq: ${l instanceof Error ? l.message : l}
`, exitCode: 1 };
    }
  }
};
function Ue(n, t, e, s, r) {
  let o = n;
  return t > 0 && (o = n.split(/\s+/).slice(t).join(" ")), e > 0 && (o = o.substring(e)), s !== void 0 && (o = o.substring(0, s)), r && (o = o.toLowerCase()), o;
}
function J(n, t, e, s) {
  e.d && t < 2 || e.u && t > 1 || (e.c ? s.push(`${String(t).padStart(7)} ${n}`) : s.push(n));
}
const He = {
  name: "uname",
  description: "Print system information",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.a, r = t.env.UNAME_SYSNAME ?? "FluffyOS", o = t.env.HOSTNAME ?? "localhost", c = t.env.UNAME_RELEASE ?? "1.0.0", i = t.env.UNAME_VERSION ?? "#1", a = t.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${r} ${o} ${c} ${i} ${a}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: r + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(r), e.n && l.push(o), e.r && l.push(c), e.v && l.push(i), e.m && l.push(a), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, Ge = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.p || e.pretty, r = e.s || e.since, o = 86400 + 3600 * 5 + 1380, c = Math.floor(o / 86400), i = Math.floor(o % 86400 / 3600), a = Math.floor(o % 3600 / 60), l = /* @__PURE__ */ new Date(), u = new Date(l.getTime() - o * 1e3), d = [];
    if (r)
      d.push(u.toISOString());
    else if (s) {
      const h = [];
      c > 0 && h.push(`${c} day${c !== 1 ? "s" : ""}`), i > 0 && h.push(`${i} hour${i !== 1 ? "s" : ""}`), a > 0 && h.push(`${a} minute${a !== 1 ? "s" : ""}`), d.push(`up ${h.join(", ")}`);
    } else {
      const h = l.toTimeString().split(" ")[0], f = c > 0 ? `${c} day${c !== 1 ? "s" : ""}, ${i}:${String(a).padStart(2, "0")}` : `${i}:${String(a).padStart(2, "0")}`;
      d.push(` ${h} up ${f}, 1 user, load average: 0.50, 0.40, 0.35`);
    }
    return {
      stdout: d.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Be = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.l, o = e.w, c = e.c, i = !r && !o && !c;
    try {
      const { content: a, files: l } = await N(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = a.split(`
`).length - (a.endsWith(`
`) ? 1 : 0), d = a.split(/\s+/).filter(Boolean).length, h = a.length, f = [];
      return (i || r) && f.push(String(u).padStart(6)), (i || o) && f.push(String(d).padStart(6)), (i || c) && f.push(String(h).padStart(6)), l.length === 1 && f.push(" " + s[0]), { stdout: f.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `wc: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, Je = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = s[0], c = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = c.split(":"), a = [];
    for (const l of i) {
      const u = `${l}/${o}`;
      try {
        if (await t.fs.exists(u) && (await t.fs.stat(u)).type === "file" && (a.push(u), !r))
          break;
      } catch {
        continue;
      }
    }
    return a.length === 0 ? {
      stdout: "",
      stderr: `which: no ${o} in (${c})
`,
      exitCode: 1
    } : {
      stdout: a.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, _e = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, Ye = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["n", "I", "i", "d", "delimiter"]), o = e.I || e.L || e.l, c = r.I || r.i, i = r.n ? parseInt(r.n) : void 0, a = r.d || r.delimiter || /\s+/, l = e.t || e.verbose, u = e.r, d = s.length > 0 ? s.join(" ") : "echo";
    let h;
    if (typeof a == "string" ? h = t.stdin.split(a).filter(Boolean) : h = t.stdin.trim().split(a).filter(Boolean), h.length === 0) {
      if (u)
        return { stdout: "", stderr: "", exitCode: 0 };
      h = [""];
    }
    const f = [], p = [];
    if (c) {
      const m = typeof c == "string" ? c : "{}";
      for (const g of h) {
        const x = d.replace(new RegExp(Ke(m), "g"), g);
        p.push(x), l && f.push(`+ ${x}`);
      }
    } else if (i)
      for (let m = 0; m < h.length; m += i) {
        const g = h.slice(m, m + i), x = `${d} ${g.map(L).join(" ")}`;
        p.push(x), l && f.push(`+ ${x}`);
      }
    else if (o)
      for (const m of h) {
        const g = `${d} ${L(m)}`;
        p.push(g), l && f.push(`+ ${g}`);
      }
    else {
      const m = d === "echo" ? h.join(" ") : `${d} ${h.map(L).join(" ")}`;
      p.push(m), l && f.push(`+ ${m}`);
    }
    return d === "echo" && !c && !i ? f.push(...h) : f.push(...p), {
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
function Ke(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const Ze = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? e.join(" ") : "y", r = [], o = 1e3;
    for (let c = 0; c < o; c++)
      r.push(s);
    return {
      stdout: r.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Ve = {
  ".": be,
  alias: Z,
  awk: V,
  base64: X,
  basename: Q,
  break: tt,
  cat: et,
  chmod: st,
  chown: nt,
  clear: rt,
  comm: ot,
  continue: it,
  cp: at,
  curl: ct,
  cut: lt,
  date: ut,
  df: pt,
  diff: ht,
  dirname: gt,
  du: xt,
  echo: yt,
  env: wt,
  eval: $t,
  exit: Ct,
  expand: vt,
  expr: bt,
  export: St,
  false: Pt,
  file: jt,
  find: Et,
  fmt: It,
  fold: Nt,
  free: kt,
  grep: Mt,
  head: At,
  hexdump: Tt,
  hostname: Dt,
  id: Wt,
  install: Lt,
  join: Ot,
  less: qt,
  ln: zt,
  ls: Ut,
  make: Jt,
  md5sum: Yt,
  mkdir: Zt,
  mv: Vt,
  nl: Xt,
  od: te,
  paste: re,
  patch: oe,
  printenv: ce,
  printf: le,
  pwd: de,
  read: ue,
  readlink: fe,
  realpath: pe,
  return: he,
  rm: me,
  sed: ge,
  seq: xe,
  sha256sum: ye,
  shift: $e,
  sleep: Ce,
  sort: ve,
  source: Y,
  stat: Se,
  strings: je,
  tail: Ee,
  tar: Ie,
  tee: Ne,
  test: ke,
  time: Me,
  timeout: Ae,
  touch: Re,
  tr: De,
  true: We,
  type: Le,
  unalias: Oe,
  unexpand: qe,
  uniq: ze,
  uname: He,
  uptime: Ge,
  wc: Be,
  which: Je,
  whoami: _e,
  xargs: Ye,
  yes: Ze
}, Xe = Object.values(Ve);
export {
  Z as alias,
  Ve as allCommands,
  V as awk,
  X as base64,
  Q as basename,
  tt as break,
  et as cat,
  st as chmod,
  nt as chown,
  rt as clear,
  ot as comm,
  Xe as commandList,
  it as continue,
  at as cp,
  ct as curl,
  lt as cut,
  ut as date,
  pt as df,
  ht as diff,
  gt as dirname,
  be as dot,
  xt as du,
  yt as echo,
  wt as env,
  $t as eval,
  Ct as exit,
  vt as expand,
  St as exportCmd,
  bt as expr,
  Pt as false,
  jt as file,
  Et as find,
  It as fmt,
  Nt as fold,
  kt as free,
  Mt as grep,
  At as head,
  Tt as hexdump,
  Dt as hostname,
  Wt as id,
  Lt as install,
  Ot as join,
  qt as less,
  zt as ln,
  Ut as ls,
  Jt as make,
  Yt as md5sum,
  Zt as mkdir,
  Vt as mv,
  Xt as nl,
  te as od,
  re as paste,
  oe as patch,
  ce as printenv,
  le as printf,
  de as pwd,
  ue as read,
  fe as readlink,
  pe as realpath,
  he as return,
  me as rm,
  ge as sed,
  xe as seq,
  ye as sha256sum,
  $e as shift,
  Ce as sleep,
  ve as sort,
  Y as source,
  Se as stat,
  je as strings,
  Ee as tail,
  Ie as tar,
  Ne as tee,
  ke as test,
  Me as time,
  Ae as timeout,
  Re as touch,
  De as tr,
  We as true,
  Le as type,
  Oe as unalias,
  He as uname,
  qe as unexpand,
  ze as uniq,
  Ge as uptime,
  Be as wc,
  Je as which,
  _e as whoami,
  Ye as xargs,
  Ze as yes
};
