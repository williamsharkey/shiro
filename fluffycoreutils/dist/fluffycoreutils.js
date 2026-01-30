function y(n, t = []) {
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
        for (let l = 0; l < c.length; l++) {
          const u = c[l];
          if (o.has(u)) {
            const d = c.slice(l + 1);
            d ? s[u] = d : a + 1 < n.length && (s[u] = n[++a]);
            break;
          }
          e[u] = !0;
        }
    } else
      r.push(i);
  }
  return { flags: e, values: s, positional: r };
}
async function F(n, t, e, s, r) {
  if (n.length === 0)
    return { content: t, files: [] };
  const o = [], a = [];
  for (const i of n) {
    const c = r(i, s);
    o.push(c), a.push(await e.readFile(c));
  }
  return { content: a.join(""), files: o };
}
const V = {
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
}, X = {
  name: "awk",
  description: "Pattern scanning and processing language",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["F", "v"]);
    if (s.length === 0)
      return { stdout: "", stderr: `awk: missing program
`, exitCode: 1 };
    const r = s[0], o = s.slice(1), a = e.F || /\s+/, i = typeof a == "string" ? new RegExp(a) : a, c = {};
    if (e.v) {
      const l = e.v.split("=");
      l.length === 2 && (c[l[0]] = l[1]);
    }
    try {
      const { content: l } = await F(
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
        const x = O(h[1], [], 0, 0, c);
        x && d.push(x);
      }
      for (const x of u) {
        m++;
        const w = x.split(i).filter((b) => b !== "");
        g = w.length;
        let $ = !0;
        if (p) {
          const b = p[1], C = p[2];
          if (b)
            try {
              $ = new RegExp(b).test(x);
            } catch {
              $ = !1;
            }
          if ($) {
            const v = O(C, w, m, g, c);
            v !== null && d.push(v);
          }
        } else if (!h && !f) {
          const b = O(r, w, m, g, c);
          b !== null && d.push(b);
        }
      }
      if (f) {
        const x = O(f[1], [], m, 0, c);
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
function O(n, t, e, s, r) {
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
    for (const [c, l] of Object.entries(r))
      i = i.replace(new RegExp(`\\b${c}\\b`, "g"), l);
    return i = i.replace(/^["'](.*)["']$/, "$1"), i = i.replace(/\s+/g, " ").trim(), i;
  }
  return null;
}
const Z = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.d || e.decode, o = e.w ? parseInt(e.w) : 76, a = e.i || e["ignore-garbage"];
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
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
}, st = {
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
}, nt = {
  name: "cat",
  description: "Concatenate and display files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await F(
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
}, rt = {
  name: "chmod",
  description: "Change file mode bits",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.R;
    if (s.length < 2)
      return { stdout: "", stderr: `chmod: missing operand
`, exitCode: 1 };
    const o = s[0], a = s.slice(1), i = parseInt(o, 8);
    if (isNaN(i))
      return { stdout: "", stderr: `chmod: invalid mode: '${o}'
`, exitCode: 1 };
    async function c(l) {
      const u = t.fs.resolvePath(l, t.cwd);
      if (r)
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const h = await t.fs.readdir(u);
            for (const f of h)
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
}, ot = {
  name: "chown",
  description: "Change file owner and group",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length < 2)
      return { stdout: "", stderr: `chown: missing operand
`, exitCode: 1 };
    const r = s[0], o = s.slice(1);
    e.R;
    const a = e.v, i = r.split(":");
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
}, it = {
  name: "clear",
  description: "Clear the terminal screen",
  async exec() {
    return { stdout: "\x1B[2J\x1B[H", stderr: "", exitCode: 0 };
  }
}, at = {
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
    const r = e[1], o = e[2], a = e[3];
    try {
      const i = t.fs.resolvePath(s[0], t.cwd), c = t.fs.resolvePath(s[1], t.cwd), l = await t.fs.readFile(i), u = await t.fs.readFile(c), d = l.split(`
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
          if (!a) {
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
}, ct = {
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
}, lt = {
  name: "cp",
  description: "Copy files and directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.r || e.R;
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
    async function c(u, d) {
      const h = await t.fs.readFile(u);
      await t.fs.writeFile(d, h);
    }
    async function l(u, d) {
      await t.fs.mkdir(d, { recursive: !0 });
      const h = await t.fs.readdir(u);
      for (const f of h) {
        const p = u + "/" + f.name, m = d + "/" + f.name;
        f.type === "dir" ? await l(p, m) : await c(p, m);
      }
    }
    try {
      for (const u of a) {
        const d = t.fs.resolvePath(u, t.cwd), h = await t.fs.stat(d), f = u.split("/").pop(), p = i ? o + "/" + f : o;
        if (h.type === "dir") {
          if (!r)
            return { stdout: "", stderr: `cp: -r not specified; omitting directory '${u}'
`, exitCode: 1 };
          await l(d, p);
        } else
          await c(d, p);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (u) {
      return { stdout: "", stderr: `cp: ${u instanceof Error ? u.message : u}
`, exitCode: 1 };
    }
  }
}, dt = {
  name: "curl",
  description: "Transfer data from or to a server",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["X", "H", "d", "o", "user-agent", "header", "data", "request", "output"]);
    if (r.length === 0)
      return { stdout: "", stderr: `curl: no URL specified!
`, exitCode: 1 };
    const o = r[0], a = s.X || s.request || (s.d || s.data ? "POST" : "GET"), i = s.o || s.output, c = e.s || e.silent, l = e.i || e.include, u = e.I || e.head, d = e.L || e.location, h = {}, f = s.H || s.header;
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
        method: u ? "HEAD" : a,
        headers: h,
        redirect: d ? "follow" : "manual"
      };
      m && a !== "GET" && a !== "HEAD" && (g.body = m);
      const x = await fetch(o, g);
      let w = "";
      if ((l || u) && (w += `HTTP/1.1 ${x.status} ${x.statusText}
`, x.headers.forEach(($, b) => {
        w += `${b}: ${$}
`;
      }), w += `
`), !u) {
        const $ = await x.text();
        w += $;
      }
      if (i) {
        const $ = t.fs.resolvePath(i, t.cwd);
        return await t.fs.writeFile($, u ? "" : await x.text()), c ? { stdout: "", stderr: "", exitCode: 0 } : {
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
}, ut = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["d", "f", "c"]), r = e.d ?? "	", o = e.f, a = e.c;
    if (!o && !a)
      return { stdout: "", stderr: `cut: you must specify -f or -c
`, exitCode: 1 };
    try {
      const { content: i } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), c = ft(o ?? a), l = i.split(`
`);
      l.length > 0 && l[l.length - 1] === "" && l.pop();
      const u = [];
      for (const d of l)
        if (o) {
          const h = d.split(r), f = c.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
          u.push(f.join(r));
        } else {
          const h = d.split(""), f = c.flatMap((p) => h.slice(p.start - 1, p.end)).filter((p) => p !== void 0);
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
function ft(n) {
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
const pt = {
  name: "date",
  description: "Display date and time",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["d", "date", "r", "reference", "u"]);
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
    const a = e.u || e.utc;
    if (s.length > 0 && s[0].startsWith("+")) {
      const c = s[0].slice(1);
      return { stdout: ht(o, c, a) + `
`, stderr: "", exitCode: 0 };
    }
    return { stdout: (a ? o.toUTCString() : o.toString()) + `
`, stderr: "", exitCode: 0 };
  }
};
function ht(n, t, e = !1) {
  const s = (w) => String(w).padStart(2, "0"), r = (w) => String(w).padStart(3, "0"), o = (w) => e ? n[`getUTC${w}`]() : n[`get${w}`](), a = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], i = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], c = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], l = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], u = o("FullYear"), d = o("Month"), h = o("Date"), f = o("Hours"), p = o("Minutes"), m = o("Seconds"), g = o("Milliseconds"), x = o("Day");
  return t.replace(/%Y/g, String(u)).replace(/%y/g, String(u).slice(-2)).replace(/%m/g, s(d + 1)).replace(/%d/g, s(h)).replace(/%e/g, String(h).padStart(2, " ")).replace(/%H/g, s(f)).replace(/%I/g, s(f % 12 || 12)).replace(/%M/g, s(p)).replace(/%S/g, s(m)).replace(/%N/g, r(g) + "000000").replace(/%p/g, f >= 12 ? "PM" : "AM").replace(/%P/g, f >= 12 ? "pm" : "am").replace(/%s/g, String(Math.floor(n.getTime() / 1e3))).replace(/%A/g, a[x]).replace(/%a/g, i[x]).replace(/%w/g, String(x)).replace(/%u/g, String(x || 7)).replace(/%B/g, c[d]).replace(/%b/g, l[d]).replace(/%h/g, l[d]).replace(/%F/g, `${u}-${s(d + 1)}-${s(h)}`).replace(/%T/g, `${s(f)}:${s(p)}:${s(m)}`).replace(/%R/g, `${s(f)}:${s(p)}`).replace(/%n/g, `
`).replace(/%t/g, "	").replace(/%%/g, "%");
}
const mt = {
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
      const [r, o] = s.split("=", 2);
      return o !== void 0 ? `${r}=${o}` : r;
    }), {
      stdout: "",
      stderr: "",
      exitCode: 0
    });
  }
}, gt = {
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
        stdout: s.map((o) => {
          const a = t.env[o];
          return a !== void 0 ? `declare -- ${o}="${a}"
` : "";
        }).join(""),
        stderr: "",
        exitCode: 0
      };
    for (const r of s) {
      const [o, a] = r.split("=", 2);
      a !== void 0 && t.env && (t.env[o] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, xt = {
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
    for (const r of s) {
      const [o, a] = r.split("=", 2);
      a !== void 0 && t.env && (t.env[o] = a);
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, yt = {
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
      for (const r of s)
        delete t.env[r];
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, wt = {
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
}, Ct = {
  name: "diff",
  description: "Compare files line by line",
  async exec(n, t) {
    var h, f;
    const { flags: e, positional: s, values: r } = y(n, ["U", "context", "C"]), o = e.u || r.U !== void 0, a = r.U || r.context || r.C || (e.u ? 3 : 0), i = typeof a == "string" ? parseInt(a) : 3, c = e.q || e.brief, l = e.i, u = e.w || e["ignore-all-space"], d = e.y || e["side-by-side"];
    if (s.length < 2)
      return { stdout: "", stderr: `diff: missing operand
`, exitCode: 2 };
    try {
      const p = t.fs.resolvePath(s[0], t.cwd), m = t.fs.resolvePath(s[1], t.cwd), g = await t.fs.readFile(p), x = await t.fs.readFile(m);
      if (g === x)
        return { stdout: "", stderr: "", exitCode: 0 };
      if (c)
        return { stdout: `Files ${s[0]} and ${s[1]} differ
`, stderr: "", exitCode: 1 };
      const w = g.split(`
`), $ = x.split(`
`), b = vt(w, $, { ignoreCase: l, ignoreWhitespace: u }), C = [];
      if (o) {
        C.push(`--- ${s[0]}`), C.push(`+++ ${s[1]}`);
        let v = 0;
        for (; v < b.length; ) {
          if (b[v].type === "equal") {
            v++;
            continue;
          }
          const P = Math.max(0, v - 1);
          let E = v;
          for (; E < b.length; ) {
            const j = b[E];
            if (j.type !== "equal")
              E++;
            else if (j.lines.length <= i * 2)
              E++;
            else
              break;
          }
          const I = (((h = b[P]) == null ? void 0 : h.line1) ?? 0) + 1, R = (((f = b[P]) == null ? void 0 : f.line2) ?? 0) + 1;
          let T = 0, M = 0;
          for (let j = P; j < E; j++)
            (b[j].type === "equal" || b[j].type === "delete") && (T += b[j].lines.length), (b[j].type === "equal" || b[j].type === "add") && (M += b[j].lines.length);
          C.push(`@@ -${I},${T} +${R},${M} @@`);
          for (let j = P; j < E; j++) {
            const N = b[j];
            N.type === "equal" ? N.lines.forEach((k) => C.push(` ${k}`)) : N.type === "delete" ? N.lines.forEach((k) => C.push(`-${k}`)) : N.type === "add" && N.lines.forEach((k) => C.push(`+${k}`));
          }
          v = E;
        }
      } else if (d)
        for (const S of b)
          S.type === "equal" ? S.lines.forEach((P) => {
            const E = P.substring(0, 40).padEnd(40);
            C.push(`${E} | ${P}`);
          }) : S.type === "delete" ? S.lines.forEach((P) => {
            const E = P.substring(0, 40).padEnd(40);
            C.push(`${E} <`);
          }) : S.type === "add" && S.lines.forEach((P) => {
            C.push(`${" ".repeat(40)} > ${P}`);
          });
      else
        for (const v of b) {
          if (v.type === "equal") continue;
          const S = (v.line1 ?? 0) + 1, P = (v.line2 ?? 0) + 1;
          v.type === "delete" ? (C.push(`${S},${S + v.lines.length - 1}d${P - 1}`), v.lines.forEach((E) => C.push(`< ${E}`))) : v.type === "add" && (C.push(`${S - 1}a${P},${P + v.lines.length - 1}`), v.lines.forEach((E) => C.push(`> ${E}`)));
        }
      return { stdout: C.join(`
`) + (C.length > 0 ? `
` : ""), stderr: "", exitCode: 1 };
    } catch (p) {
      return { stdout: "", stderr: `diff: ${p instanceof Error ? p.message : p}
`, exitCode: 2 };
    }
  }
};
function vt(n, t, e = {}) {
  const s = n.length, r = t.length, o = (u) => {
    let d = u;
    return e.ignoreWhitespace && (d = d.replace(/\s+/g, "")), e.ignoreCase && (d = d.toLowerCase()), d;
  }, a = Array(s + 1).fill(0).map(() => Array(r + 1).fill(0));
  for (let u = 1; u <= s; u++)
    for (let d = 1; d <= r; d++)
      o(n[u - 1]) === o(t[d - 1]) ? a[u][d] = a[u - 1][d - 1] + 1 : a[u][d] = Math.max(a[u - 1][d], a[u][d - 1]);
  const i = [];
  let c = s, l = r;
  for (; c > 0 || l > 0; )
    c > 0 && l > 0 && o(n[c - 1]) === o(t[l - 1]) ? (i.length > 0 && i[i.length - 1].type === "equal" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "equal", lines: [n[c - 1]], line1: c - 1, line2: l - 1 }), c--, l--) : l > 0 && (c === 0 || a[c][l - 1] >= a[c - 1][l]) ? (i.length > 0 && i[i.length - 1].type === "add" ? i[i.length - 1].lines.unshift(t[l - 1]) : i.push({ type: "add", lines: [t[l - 1]], line1: c, line2: l - 1 }), l--) : (i.length > 0 && i[i.length - 1].type === "delete" ? i[i.length - 1].lines.unshift(n[c - 1]) : i.push({ type: "delete", lines: [n[c - 1]], line1: c - 1, line2: l }), c--);
  return i.reverse();
}
const $t = {
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
}, bt = {
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
}, St = {
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
}, Pt = {
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
}, Et = {
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
}, jt = {
  name: "du",
  description: "Estimate file space usage",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["max-depth", "d"]), o = s.length > 0 ? s : ["."], a = e.s, i = e.a, c = e.h, l = r["max-depth"] || r.d, u = l ? parseInt(l) : 1 / 0, d = [];
    try {
      for (const h of o) {
        const f = t.fs.resolvePath(h, t.cwd), p = await Y(f, t.fs, 0, u, i, !a, d, c), m = c ? U(p) : String(Math.ceil(p / 1024));
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
async function Y(n, t, e, s, r, o, a, i) {
  try {
    const c = await t.stat(n);
    if (c.type === "file")
      return c.size;
    if (c.type === "dir" && e < s) {
      const l = await t.readdir(n);
      let u = 0;
      for (const d of l) {
        const h = n + "/" + d.name, f = await Y(h, t, e + 1, s, r, o, a, i);
        if (u += f, r && d.type === "file") {
          const p = i ? U(f) : String(Math.ceil(f / 1024));
          a.push(`${p}	${h}`);
        }
        if (o && d.type === "dir" && e + 1 < s) {
          const p = i ? U(f) : String(Math.ceil(f / 1024));
          a.push(`${p}	${h}`);
        }
      }
      return u;
    }
    return 0;
  } catch {
    return 0;
  }
}
function U(n) {
  const t = ["", "K", "M", "G", "T"];
  let e = n, s = 0;
  for (; e >= 1024 && s < t.length - 1; )
    e /= 1024, s++;
  return Math.ceil(e) + t[s];
}
const It = {
  name: "echo",
  description: "Display text",
  async exec(n) {
    const { flags: t } = y(n), e = t.n, s = n.filter((o) => o !== "-n" && o !== "-e").join(" ");
    let r = t.e ? s.replace(/\\n/g, `
`).replace(/\\t/g, "	").replace(/\\\\/g, "\\") : s;
    return e || (r += `
`), { stdout: r, stderr: "", exitCode: 0 };
  }
}, Nt = {
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
}, Ft = {
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
}, Tt = {
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
}, Mt = {
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
}, At = {
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
}, kt = {
  name: "env",
  description: "Print environment variables",
  async exec(n, t) {
    return { stdout: Object.entries(t.env).map(([s, r]) => `${s}=${r}`).sort().join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
}, Rt = {
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
}, Dt = {
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
}, Ot = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "tabs"]), o = e.t || e.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `expand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.i || r.initial;
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
        let h = "", f = 0;
        for (let p = 0; p < d.length; p++) {
          const m = d[p];
          if (m === "	")
            if (!i || i && h.trim() === "") {
              const g = a - f % a;
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
}, Lt = {
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
const Ut = {
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
}, Wt = {
  name: "false",
  description: "Return failure",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}, qt = {
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
}, zt = {
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
}, Gt = {
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
}, Ht = {
  name: "file",
  description: "Determine file type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `file: missing operand
`, exitCode: 1 };
    const r = s.b, o = s.i || s.mime, a = s["mime-type"], i = s["mime-encoding"], c = [];
    try {
      for (const l of e) {
        const u = t.fs.resolvePath(l, t.cwd);
        try {
          if ((await t.fs.stat(u)).type === "dir") {
            const m = r ? "directory" : `${l}: directory`;
            c.push(m);
            continue;
          }
          const h = await t.fs.readFile(u), f = Bt(h, l);
          let p;
          a ? p = r ? f.mimeType : `${l}: ${f.mimeType}` : i ? p = r ? f.encoding : `${l}: ${f.encoding}` : o ? p = r ? `${f.mimeType}; charset=${f.encoding}` : `${l}: ${f.mimeType}; charset=${f.encoding}` : p = r ? f.description : `${l}: ${f.description}`, c.push(p);
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
function Bt(n, t) {
  var a;
  let e = "text/plain", s = "us-ascii", r = "ASCII text";
  if (/[^\x00-\x7F]/.test(n) && (s = "utf-8", r = "UTF-8 Unicode text"), n.length === 0)
    return e = "application/x-empty", r = "empty", { mimeType: e, encoding: s, description: r };
  const o = (a = t.split(".").pop()) == null ? void 0 : a.toLowerCase();
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
const Jt = {
  name: "find",
  description: "Search for files in a directory hierarchy",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["name", "type", "exec", "maxdepth", "mindepth", "path", "iname"]), o = s[0] ?? ".", a = e.name, i = e.iname, c = e.path, l = e.type, u = e.maxdepth ? parseInt(e.maxdepth) : 1 / 0, d = e.mindepth ? parseInt(e.mindepth) : 0, h = e.exec, f = r.print !== !1, p = t.fs.resolvePath(o, t.cwd), m = [], g = [];
    let x;
    if (a) {
      const v = a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      x = new RegExp(`^${v}$`);
    }
    let w;
    if (i) {
      const v = i.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      w = new RegExp(`^${v}$`, "i");
    }
    let $;
    if (c) {
      const v = c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      $ = new RegExp(v);
    }
    async function b(v, S, P) {
      let E;
      try {
        E = await t.fs.readdir(v);
      } catch {
        return;
      }
      for (const I of E) {
        const R = v + "/" + I.name, T = S ? S + "/" + I.name : I.name, M = o === "." ? "./" + T : o + "/" + T, j = P + 1;
        let N = !0;
        if (!(j > u)) {
          if (j < d && (N = !1), x && !x.test(I.name) && (N = !1), w && !w.test(I.name) && (N = !1), $ && !$.test(M) && (N = !1), l === "f" && I.type !== "file" && (N = !1), l === "d" && I.type !== "dir" && (N = !1), N && (f && m.push(M), h)) {
            const k = h.replace(/\{\}/g, M);
            g.push(`Executing: ${k}`);
          }
          I.type === "dir" && j < u && await b(R, T, j);
        }
      }
    }
    0 >= d && (!l || l === "d") && !x && !w && !$ && f && m.push(o === "." ? "." : o), await b(p, "", 0);
    let C = "";
    return m.length > 0 && (C = m.join(`
`) + `
`), g.length > 0 && (C += g.join(`
`) + `
`), { stdout: C, stderr: "", exitCode: 0 };
  }
}, Yt = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(e.w || e.width || "75", 10);
    r.u;
    const a = r.s;
    if (isNaN(o) || o <= 0)
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
            for (const h of u)
              l.push(...W(h, o));
          else {
            const h = u.join(" ").trim();
            h && l.push(...W(h, o));
          }
          u = [];
        }
      };
      for (const h of c) {
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
function W(n, t) {
  const e = [], s = n.split(/\s+/);
  let r = "";
  for (const o of s)
    r.length === 0 ? r = o : r.length + 1 + o.length <= t ? r += " " + o : (e.push(r), r = o);
  return r.length > 0 && e.push(r), e;
}
const _t = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["w", "width"]), o = parseInt(e.w || e.width || "80", 10);
    r.b;
    const a = r.s;
    if (isNaN(o) || o <= 0)
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
        if (u.length <= o) {
          l.push(u);
          continue;
        }
        let d = u;
        for (; d.length > o; ) {
          let h = o;
          if (a) {
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
}, Kt = {
  name: "free",
  description: "Display amount of free and used memory",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.h, r = e.b, o = e.m, a = e.g, i = [], c = 8388608, l = 4194304, u = 4194304, d = 524288, h = 1048576, f = 5242880;
    return s ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:            8.0G        4.0G        4.0G       512M        1.0G        5.0G"), i.push("Swap:           2.0G          0B        2.0G")) : r ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:    ${c * 1024} ${l * 1024} ${u * 1024} ${d * 1024} ${h * 1024} ${f * 1024}`), i.push(`Swap:   ${2097152 * 1024}           0 ${2097152 * 1024}`)) : o ? (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:           ${Math.floor(c / 1024)}        ${Math.floor(l / 1024)}        ${Math.floor(u / 1024)}         ${Math.floor(d / 1024)}        ${Math.floor(h / 1024)}        ${Math.floor(f / 1024)}`), i.push("Swap:          2048           0        2048")) : a ? (i.push("               total        used        free      shared  buff/cache   available"), i.push("Mem:               8           4           4           0           1           5"), i.push("Swap:              2           0           2")) : (i.push("               total        used        free      shared  buff/cache   available"), i.push(`Mem:        ${c}     ${l}     ${u}      ${d}     ${h}     ${f}`), i.push("Swap:       2097152           0     2097152")), {
      stdout: i.join(`
`) + `
`,
      stderr: "",
      exitCode: 0
    };
  }
}, Vt = {
  name: "grep",
  description: "Search for patterns in files",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["e"]), o = !!e.i, a = !!e.v, i = !!e.c, c = !!e.l, l = !!e.n, u = !!(e.r || e.R), d = s.e ?? r.shift();
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
    async function w(C, v) {
      let S;
      try {
        if (C === "-")
          S = t.stdin;
        else {
          const I = t.fs.resolvePath(C, t.cwd);
          S = await t.fs.readFile(I);
        }
      } catch {
        g.push(`grep: ${C}: No such file or directory`);
        return;
      }
      const P = S.split(`
`);
      P.length > 0 && P[P.length - 1] === "" && P.pop();
      let E = 0;
      for (let I = 0; I < P.length; I++)
        if (f.test(P[I]) !== a && (x = !0, E++, !i && !c)) {
          const T = m ? `${v}:` : "", M = l ? `${I + 1}:` : "";
          g.push(`${T}${M}${P[I]}`);
        }
      i && g.push(m ? `${v}:${E}` : String(E)), c && E > 0 && g.push(v);
    }
    async function $(C) {
      const v = t.fs.resolvePath(C, t.cwd);
      let S;
      try {
        S = await t.fs.readdir(v);
      } catch {
        return;
      }
      for (const P of S) {
        const E = v + "/" + P.name;
        P.type === "dir" ? await $(E) : await w(E, E);
      }
    }
    for (const C of p)
      if (C === "-")
        await w("-", "(standard input)");
      else if (u) {
        const v = t.fs.resolvePath(C, t.cwd);
        let S;
        try {
          S = await t.fs.stat(v);
        } catch {
          continue;
        }
        S.type === "dir" ? await $(v) : await w(C, C);
      } else
        await w(C, C);
    return { stdout: g.length > 0 ? g.join(`
`) + `
` : "", stderr: "", exitCode: x ? 0 : 1 };
  }
}, Xt = {
  name: "head",
  description: "Output the first part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await F(
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
}, Zt = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["n", "s", "C"]), o = r.C, a = e.n ? parseInt(e.n) : void 0, i = e.s ? parseInt(e.s) : 0;
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
      if (o) {
        for (let h = 0; h < l.length; h += 16) {
          const f = l.substring(h, h + 16), p = (i + h).toString(16).padStart(8, "0"), m = q(f.substring(0, 8)), g = q(f.substring(8, 16)), x = Qt(f);
          u.push(`${p}  ${m}  ${g}  |${x}|`);
        }
        const d = (i + l.length).toString(16).padStart(8, "0");
        u.push(d);
      } else {
        for (let h = 0; h < l.length; h += 16) {
          const f = l.substring(h, h + 16), p = (i + h).toString(16).padStart(7, "0"), m = [];
          for (let g = 0; g < f.length; g += 2) {
            const x = f.charCodeAt(g), w = g + 1 < f.length ? f.charCodeAt(g + 1) : 0, $ = (x << 8 | w).toString(16).padStart(4, "0");
            m.push($);
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
function Qt(n) {
  let t = "";
  for (let e = 0; e < 16; e++)
    if (e < n.length) {
      const s = n.charCodeAt(e);
      t += s >= 32 && s < 127 ? n[e] : ".";
    } else
      t += " ";
  return t;
}
const te = {
  name: "hostname",
  description: "Print system hostname",
  async exec(n, t) {
    return { stdout: (t.env.HOSTNAME ?? "localhost") + `
`, stderr: "", exitCode: 0 };
  }
}, ee = {
  name: "id",
  description: "Print user identity",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), r = e[0] || t.env.USER || "user", o = s.u || s.user, a = s.g || s.group, i = s.G || s.groups, c = s.n || s.name;
    s.r || s.real;
    const l = 1e3, u = 1e3, d = [1e3], h = r, f = "users", p = [];
    if (o)
      c ? p.push(h) : p.push(String(l));
    else if (a)
      c ? p.push(f) : p.push(String(u));
    else if (i)
      c ? p.push(f) : p.push(d.join(" "));
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
}, se = {
  name: "install",
  description: "Copy files and set attributes",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["m", "mode", "o", "owner", "g", "group", "t", "target-directory"]);
    e.m || e.mode;
    const o = e.t || e["target-directory"], a = r.d || r.directory, i = r.v || r.verbose;
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
      else if (o) {
        const l = t.fs.resolvePath(o, t.cwd);
        for (const u of s) {
          const d = t.fs.resolvePath(u, t.cwd), h = u.split("/").pop() || u, f = l + "/" + h, p = await t.fs.readFile(d);
          await t.fs.writeFile(f, p), i && c.push(`'${u}' -> '${o}/${h}'`);
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
            await t.fs.writeFile(g, x), i && c.push(`'${f}' -> '${l}/${m}'`);
          }
        else {
          const f = t.fs.resolvePath(u[0], t.cwd), p = await t.fs.readFile(f);
          await t.fs.writeFile(d, p), i && c.push(`'${u[0]}' -> '${l}'`);
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
}, ne = {
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
    const o = e[1] ? parseInt(e[1]) - 1 : 0, a = e[2] ? parseInt(e[2]) - 1 : 0, i = e.t || /\s+/, c = e.o, l = r.i;
    try {
      const u = t.fs.resolvePath(s[0], t.cwd), d = t.fs.resolvePath(s[1], t.cwd), h = await t.fs.readFile(u), f = await t.fs.readFile(d), p = h.split(`
`).filter((C) => C.trim() !== ""), m = f.split(`
`).filter((C) => C.trim() !== ""), g = (C) => C.map((v) => v.split(i)), x = g(p), w = g(m), $ = /* @__PURE__ */ new Map();
      for (const C of w) {
        const v = (C[a] || "").trim(), S = l ? v.toLowerCase() : v;
        $.has(S) || $.set(S, []), $.get(S).push(C);
      }
      const b = [];
      for (const C of x) {
        const v = (C[o] || "").trim(), S = l ? v.toLowerCase() : v, P = $.get(S) || [];
        for (const E of P) {
          let I;
          if (c)
            I = c.split(",").map((T) => {
              const [M, j] = T.split(".").map((k) => parseInt(k));
              return (M === 1 ? C : E)[j - 1] || "";
            }).join(" ");
          else {
            const R = C[o] || "", T = C.filter((j, N) => N !== o), M = E.filter((j, N) => N !== a);
            I = [R, ...T, ...M].join(" ");
          }
          b.push(I);
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
}, re = {
  name: "less",
  description: "View file contents with pagination",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), o = r.split(`
`), a = e.N || e.n;
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
}, oe = {
  name: "ln",
  description: "Make links between files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.s, o = e.f, a = e.v;
    if (s.length < 2)
      return { stdout: "", stderr: `ln: missing operand
`, exitCode: 1 };
    const i = t.fs.resolvePath(s[0], t.cwd), c = t.fs.resolvePath(s[1], t.cwd), l = [];
    try {
      if (await t.fs.exists(c))
        if (o)
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
      if (r && t.fs.symlink)
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
}, ie = {
  name: "ls",
  description: "List directory contents",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = s.length > 0 ? s : ["."], o = e.a, a = e.l, i = e.h, c = [];
    for (const l of r) {
      const u = t.fs.resolvePath(l, t.cwd), d = await t.fs.stat(u);
      if (d.type === "file") {
        c.push(a ? z(u.split("/").pop(), d, i) : u.split("/").pop());
        continue;
      }
      r.length > 1 && c.push(`${l}:`);
      const h = await t.fs.readdir(u), f = o ? h : h.filter((p) => !p.name.startsWith("."));
      if (f.sort((p, m) => p.name.localeCompare(m.name)), a) {
        c.push(`total ${f.length}`);
        for (const p of f)
          c.push(z(p.name, p, i));
      } else
        c.push(f.map((p) => p.type === "dir" ? p.name + "/" : p.name).join("  "));
    }
    return { stdout: c.join(`
`) + `
`, stderr: "", exitCode: 0 };
  }
};
function z(n, t, e) {
  const s = t.type === "dir" ? "d" : "-", r = t.mode ?? (t.type === "dir" ? 493 : 420), o = ae(r), a = e ? le(t.size) : String(t.size).padStart(8), i = new Date(t.mtime), c = ce(i);
  return `${s}${o}  1 user user ${a} ${c} ${n}`;
}
function ae(n) {
  let e = "";
  for (let s = 2; s >= 0; s--) {
    const r = n >> s * 3 & 7;
    for (let o = 2; o >= 0; o--)
      e += r & 1 << o ? "rwx"[2 - o] : "-";
  }
  return e;
}
function ce(n) {
  const e = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][n.getMonth()], s = String(n.getDate()).padStart(2), r = String(n.getHours()).padStart(2, "0"), o = String(n.getMinutes()).padStart(2, "0");
  return `${e} ${s} ${r}:${o}`;
}
function le(n) {
  return n < 1024 ? String(n).padStart(5) : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "K" : (n / (1024 * 1024)).toFixed(1) + "M";
}
const de = {
  name: "make",
  description: "Build automation (basic Makefile support)",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["f", "file", "C", "j"]), o = e.f || e.file || "Makefile", a = e.C;
    e.j;
    const i = r.n || r["dry-run"], c = r.p || r.print, l = s.length > 0 ? s : ["all"];
    try {
      const u = a ? t.fs.resolvePath(a, t.cwd) : t.cwd, d = t.fs.resolvePath(o, u);
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
      const f = ue(h), p = [];
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
            for (const $ of w.commands)
              c || i ? p.push($) : p.push(`# ${$}`);
        }
        for (const x of g.commands)
          c || i ? p.push(x) : p.push(`# ${x}`);
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
function ue(n) {
  const t = /* @__PURE__ */ new Map(), e = n.split(`
`);
  let s = null;
  for (let r = 0; r < e.length; r++) {
    const o = e[r];
    if (!(o.trim().startsWith("#") || o.trim() === ""))
      if (o.includes(":") && !o.startsWith("	")) {
        const a = o.indexOf(":"), i = o.substring(0, a).trim(), c = o.substring(a + 1).trim(), l = c ? c.split(/\s+/) : [];
        s = { target: i, prerequisites: l, commands: [] }, t.set(i, s);
      } else o.startsWith("	") && s && s.commands.push(o.substring(1));
  }
  return t;
}
const fe = {
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
    const a = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const c of a) {
        let l;
        if (c === "-")
          l = t.stdin;
        else {
          const h = t.fs.resolvePath(c, t.cwd);
          l = await t.fs.readFile(h);
        }
        const u = await pe(l), d = o ? "*" : " ";
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
async function pe(n) {
  let t = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    t = (t << 5) - t + r, t = t & t;
  }
  return Math.abs(t).toString(16).padStart(32, "0");
}
const he = {
  name: "mkdir",
  description: "Make directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.p;
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
}, me = {
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
      for (const a of r) {
        const i = t.fs.resolvePath(a, t.cwd), c = a.split("/").pop(), l = o ? s + "/" + c : s;
        await t.fs.rename(i, l);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (a) {
      return { stdout: "", stderr: `mv: ${a instanceof Error ? a.message : a}
`, exitCode: 1 };
    }
  }
}, ge = {
  name: "nl",
  description: "Number lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["b", "s", "w", "n", "v"]), o = e.b || "t", a = e.s || "	", i = parseInt(e.w || "6", 10), c = e.n || "rn", l = parseInt(e.v || "1", 10);
    r.p;
    const u = r.ba;
    try {
      const { content: d } = await F(
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
          const w = xe(p, i, c);
          f.push(w + a + m), p++;
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
function xe(n, t, e) {
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
const ye = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "N", "j", "w", "A"]), o = e.t || "o2", a = e.N ? parseInt(e.N) : void 0, i = e.j ? parseInt(e.j) : 0, c = e.w ? parseInt(e.w) : 16, l = e.A || "o", u = r.b || r.c || r.d || r.o || r.s || r.x;
    try {
      const { content: d } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      );
      let h = d.substring(i, a ? i + a : void 0);
      const f = [];
      let p = "o", m = 2;
      u ? r.b ? (p = "o", m = 1) : r.c ? (p = "c", m = 1) : r.d || r.s ? (p = "d", m = 2) : r.o ? (p = "o", m = 2) : r.x && (p = "x", m = 2) : o && (p = o[0] || "o", m = parseInt(o.substring(1)) || 2);
      let g = i;
      for (let x = 0; x < h.length; x += c) {
        const w = h.substring(x, x + c), $ = G(g, l), b = we(w, p, m);
        f.push(`${$} ${b}`), g += w.length;
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
function we(n, t, e) {
  const s = [];
  for (let r = 0; r < n.length; r += e) {
    const o = n.substring(r, r + e);
    let a = 0;
    for (let i = 0; i < o.length; i++)
      a = a << 8 | o.charCodeAt(i);
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
        s.push(Ce(o.charCodeAt(0)));
        break;
      case "a":
        s.push(ve(o.charCodeAt(0)));
        break;
      default:
        s.push(a.toString(8).padStart(e * 3, "0"));
    }
  }
  return s.join(" ");
}
function Ce(n) {
  return n >= 32 && n < 127 ? `  ${String.fromCharCode(n)}` : n === 0 ? " \\0" : n === 7 ? " \\a" : n === 8 ? " \\b" : n === 9 ? " \\t" : n === 10 ? " \\n" : n === 11 ? " \\v" : n === 12 ? " \\f" : n === 13 ? " \\r" : n.toString(8).padStart(3, "0");
}
function ve(n) {
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
const $e = {
  name: "paste",
  description: "Merge lines of files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["d", "delimiters"]), o = e.d || e.delimiters || "	", a = r.s;
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
      const c = [];
      if (a)
        for (const l of i) {
          const u = o.split(""), d = [];
          for (let h = 0; h < l.length; h++)
            d.push(l[h]), h < l.length - 1 && d.push(u[h % u.length]);
          c.push(d.join(""));
        }
      else {
        const l = Math.max(...i.map((d) => d.length)), u = o.split("");
        for (let d = 0; d < l; d++) {
          const h = [];
          for (let f = 0; f < i.length; f++) {
            const p = i[f][d] || "";
            h.push(p), f < i.length - 1 && h.push(u[f % u.length]);
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
}, be = {
  name: "patch",
  description: "Apply a diff file to an original",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["p", "i", "input", "o", "output"]), o = e.p ? parseInt(e.p) : 0, a = e.i || e.input, i = e.o || e.output, c = r.R || r.reverse, l = r["dry-run"];
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
      const d = Se(u), h = [];
      for (const f of d) {
        const p = H(f.newFile, o), m = H(f.oldFile, o);
        if (h.push(`patching file ${p}`), !l) {
          let g;
          try {
            const w = t.fs.resolvePath(p, t.cwd);
            g = await t.fs.readFile(w);
          } catch {
            g = "";
          }
          const x = Pe(g, f.hunks, c);
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
function Se(n) {
  const t = [], e = n.split(`
`);
  let s = null, r = null;
  for (const o of e)
    if (o.startsWith("--- "))
      s = { oldFile: o.substring(4).split("	")[0], newFile: "", hunks: [] };
    else if (o.startsWith("+++ ") && s)
      s.newFile = o.substring(4).split("	")[0], t.push(s);
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
  return t;
}
function H(n, t) {
  return n.split("/").slice(t).join("/");
}
function Pe(n, t, e) {
  const s = n.split(`
`);
  for (const r of t) {
    const o = r.oldStart - 1, a = r.oldLines, i = [];
    for (const c of r.lines) {
      const l = c[0], u = c.substring(1);
      if (e) {
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
const Ee = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n), r = s[0] || s.null;
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
}, je = {
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
              const l = a.includes(".") ? parseInt(a.split(".")[1], 10) : 6;
              r += (parseFloat(c) || 0).toFixed(l);
              break;
            }
          }
        }
      else
        r += t[o], o++;
    return { stdout: r, stderr: "", exitCode: 0 };
  }
}, Ie = {
  name: "pwd",
  description: "Print working directory",
  async exec(n, t) {
    return { stdout: t.cwd + `
`, stderr: "", exitCode: 0 };
  }
}, Ne = {
  name: "read",
  description: "Read a line from stdin",
  async exec(n, t) {
    return y(n, ["p", "n"]), t.stdin, {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, Fe = {
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
}, Te = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    if (s.length === 0)
      return { stdout: "", stderr: `realpath: missing operand
`, exitCode: 1 };
    const r = e.q || e.quiet, o = !e.s;
    e.s;
    const a = [], i = [];
    for (const u of s)
      try {
        let d = t.fs.resolvePath(u, t.cwd);
        if (o) {
          const h = d.split("/").filter((p) => p !== "" && p !== "."), f = [];
          for (const p of h)
            p === ".." ? f.length > 0 && f.pop() : f.push(p);
          d = "/" + f.join("/");
        }
        await t.fs.exists(d) ? a.push(d) : r || i.push(`realpath: ${u}: No such file or directory`);
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
}, Me = {
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
}, Ae = {
  name: "rm",
  description: "Remove files or directories",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.r || e.R, o = e.f;
    if (s.length === 0 && !o)
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
          await t.fs.unlink(c);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (i) {
      return o ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: `rm: ${i instanceof Error ? i.message : i}
`, exitCode: 1 };
    }
  }
}, ke = {
  name: "sed",
  description: "Stream editor for filtering and transforming text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.i, o = s.shift();
    if (!o)
      return { stdout: "", stderr: `sed: no expression provided
`, exitCode: 1 };
    const a = o.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
    if (!a)
      return { stdout: "", stderr: `sed: unsupported expression: ${o}
`, exitCode: 1 };
    const [, , i, c, l] = a, u = l.includes("g"), d = l.includes("i");
    let h;
    try {
      const f = (u ? "g" : "") + (d ? "i" : "");
      h = new RegExp(i, f);
    } catch {
      return { stdout: "", stderr: `sed: invalid regex: ${i}
`, exitCode: 2 };
    }
    try {
      const { content: f, files: p } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), m = f.split(`
`).map((g) => g.replace(h, c)).join(`
`);
      if (r && p.length > 0) {
        for (const g of p) {
          const x = t.fs.resolvePath(g, t.cwd), $ = (await t.fs.readFile(x)).split(`
`).map((b) => b.replace(h, c)).join(`
`);
          await t.fs.writeFile(x, $);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: m, stderr: "", exitCode: 0 };
    } catch (f) {
      return { stdout: "", stderr: `sed: ${f instanceof Error ? f.message : f}
`, exitCode: 1 };
    }
  }
}, Re = {
  name: "seq",
  description: "Generate sequences of numbers",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["separator", "s", "format", "f"]);
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
`, l = s.f || s.format, u = e.w, d = [];
    if (a > 0)
      for (let p = o; p <= i; p += a)
        d.push(String(p));
    else
      for (let p = o; p >= i; p += a)
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
      stdout: d.join(c) + ((typeof c == "string" ? c : `
`) === `
` ? `
` : ""),
      stderr: "",
      exitCode: 0
    };
  }
}, De = {
  name: "set",
  description: "Set or unset shell options and positional parameters",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["e", "u", "x", "v", "n", "o"]);
    if (n.length === 0) {
      const o = Object.entries(t.env || {}).map(([a, i]) => `${a}=${i}`).join(`
`);
      return {
        stdout: o ? o + `
` : "",
        stderr: "",
        exitCode: 0
      };
    }
    if (e.o || s.o) {
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
    return e.e, e.u, e.x, e.v, e.n, {
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }
}, Oe = {
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
    const a = s.length > 0 ? s : ["-"], i = [];
    try {
      for (const c of a) {
        let l;
        if (c === "-")
          l = t.stdin;
        else {
          const h = t.fs.resolvePath(c, t.cwd);
          l = await t.fs.readFile(h);
        }
        const u = await Le(l), d = o ? "*" : " ";
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
async function Le(n) {
  const t = globalThis;
  if (typeof t.crypto < "u" && t.crypto.subtle) {
    const r = new t.TextEncoder().encode(n), o = await t.crypto.subtle.digest("SHA-256", r);
    return Array.from(new t.Uint8Array(o)).map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  let e = 0;
  for (let s = 0; s < n.length; s++) {
    const r = n.charCodeAt(s);
    e = (e << 5) - e + r, e = e & e;
  }
  return Math.abs(e).toString(16).padStart(64, "0");
}
const Ue = {
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
}, We = {
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
}, qe = {
  name: "sort",
  description: "Sort lines of text",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n);
    try {
      const { content: r } = await F(
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
}, _ = {
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
}, ze = {
  name: ".",
  description: "Execute commands from a file in the current shell (alias for source)",
  async exec(n, t) {
    return _.exec(n, t);
  }
}, Ge = {
  name: "stat",
  description: "Display file status",
  async exec(n, t) {
    const { positional: e, flags: s, values: r } = y(n, ["c", "format"]);
    if (e.length === 0)
      return { stdout: "", stderr: `stat: missing operand
`, exitCode: 1 };
    const o = r.c || r.format, a = s.t;
    s.f;
    const i = [];
    try {
      for (const c of e) {
        const l = t.fs.resolvePath(c, t.cwd);
        try {
          const u = await t.fs.stat(l);
          if (o) {
            const d = He(c, u, o);
            i.push(d);
          } else if (a)
            i.push(`${c} ${u.size} 0 ${u.mode} 0 0 0 0 0 0 ${u.mtime}`);
          else {
            const d = u.type === "dir" ? "directory" : "regular file", h = K(u.mode), f = new Date(u.mtime).toISOString();
            i.push(`  File: ${c}`), i.push(`  Size: ${u.size}	Blocks: 0	IO Block: 4096	${d}`), i.push("Device: 0	Inode: 0	Links: 1"), i.push(`Access: (${h})	Uid: (0/root)	Gid: (0/root)`), i.push(`Access: ${f}`), i.push(`Modify: ${f}`), i.push(`Change: ${f}`);
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
function He(n, t, e) {
  return e.replace(/%n/g, n).replace(/%N/g, `'${n}'`).replace(/%s/g, String(t.size)).replace(/%b/g, "0").replace(/%f/g, t.mode.toString(16)).replace(/%a/g, t.mode.toString(8)).replace(/%A/g, K(t.mode).split("/")[1]).replace(/%F/g, t.type === "dir" ? "directory" : "regular file").replace(/%u/g, "0").replace(/%g/g, "0").replace(/%U/g, "root").replace(/%G/g, "root").replace(/%i/g, "0").replace(/%h/g, "1").replace(/%W/g, String(Math.floor(t.mtime / 1e3))).replace(/%X/g, String(Math.floor(t.mtime / 1e3))).replace(/%Y/g, String(Math.floor(t.mtime / 1e3))).replace(/%y/g, new Date(t.mtime).toISOString()).replace(/%%/g, "%");
}
const Be = {
  name: "strings",
  description: "Find printable strings in files",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["n", "bytes"]), o = parseInt(e.n || e.bytes || "4", 10), a = r.f;
    r.a;
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
        const h = Je(u, o);
        for (const f of h)
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
function Je(n, t) {
  const e = [], s = /[ -~]/;
  let r = "";
  for (let o = 0; o < n.length; o++) {
    const a = n[o];
    s.test(a) ? r += a : (r.length >= t && e.push(r), r = "");
  }
  return r.length >= t && e.push(r), e;
}
const Ye = {
  name: "tail",
  description: "Output the last part of files",
  async exec(n, t) {
    const { values: e, positional: s } = y(n, ["n"]), r = parseInt(e.n ?? "10", 10);
    try {
      const { content: o } = await F(
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
}, _e = {
  name: "tar",
  description: "Archive utility (simplified tar format)",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["f", "C"]), o = e.c || e.create, a = e.x || e.extract, i = e.t || e.list, c = e.v || e.verbose, l = s.f, u = s.C;
    let d = t.cwd;
    u && (d = t.fs.resolvePath(u, t.cwd));
    const h = [o, a, i].filter(Boolean).length;
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
        async function m($, b) {
          const C = t.fs.resolvePath($, d);
          if ((await t.fs.stat(C)).type === "dir") {
            p.push({ path: b + "/", content: "", isDir: !0 });
            const S = await t.fs.readdir(C);
            for (const P of S)
              await m(C + "/" + P.name, b + "/" + P.name);
          } else {
            const S = await t.fs.readFile(C);
            p.push({ path: b, content: S, isDir: !1 });
          }
        }
        for (const $ of f)
          await m($, $);
        const g = ["FLUFFY-TAR-V1"];
        for (const $ of p)
          c && (t.stderr || console.error($.path)), g.push(`FILE:${$.path}`), g.push(`SIZE:${$.content.length}`), g.push(`TYPE:${$.isDir ? "dir" : "file"}`), g.push("DATA-START"), g.push($.content), g.push("DATA-END");
        const x = g.join(`
`), w = t.fs.resolvePath(l, t.cwd);
        return await t.fs.writeFile(w, x), {
          stdout: c ? p.map(($) => $.path).join(`
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
          const w = m[g].slice(5), $ = parseInt(m[g + 1].slice(5), 10), b = m[g + 2].slice(5);
          g += 4;
          const C = [];
          for (; g < m.length && m[g] !== "DATA-END"; )
            C.push(m[g]), g++;
          const v = C.join(`
`);
          g++;
          const S = t.fs.resolvePath(w, d);
          if (b === "dir")
            await t.fs.mkdir(S, { recursive: !0 });
          else {
            const P = S.lastIndexOf("/");
            if (P > 0) {
              const E = S.slice(0, P);
              try {
                await t.fs.mkdir(E, { recursive: !0 });
              } catch {
              }
            }
            await t.fs.writeFile(S, v);
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
}, Ke = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.a, o = t.stdin;
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
}, Ve = {
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
          const a = t.fs.resolvePath(o, t.cwd), i = await t.fs.stat(a);
          return r === "-f" ? i.type === "file" : r === "-d" ? i.type === "dir" : !0;
        } catch {
          return !1;
        }
    }
  }
  if (n[0] === "!" && n.length > 1)
    return !await D(n.slice(1), t);
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
    return await D(n.slice(0, e), t) && await D(n.slice(e + 1), t);
  const s = n.indexOf("-o");
  return s > 0 ? await D(n.slice(0, s), t) || await D(n.slice(s + 1), t) : !1;
}
const Xe = {
  name: "time",
  description: "Time a command execution",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `time: missing command
`, exitCode: 1 };
    const r = s.v || s.verbose, o = s.p, a = e.join(" "), i = globalThis.performance, c = i ? i.now() : Date.now();
    await new Promise((m) => globalThis.setTimeout(m, 0));
    const d = ((i ? i.now() : Date.now()) - c) / 1e3, h = Math.floor(d / 60), f = d % 60;
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
      stderr: `Command: ${a}
${p}`,
      exitCode: 0
    };
  }
}, Ze = {
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
    const o = e[0], a = e.slice(1);
    if (a.length === 0)
      return {
        stdout: "",
        stderr: `timeout: missing command
`,
        exitCode: 1
      };
    let i = Qe(o);
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
function Qe(n) {
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
const ts = {
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
        const a = t.fs.resolvePath(o, t.cwd);
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
          if (r)
            continue;
          await t.fs.writeFile(a, "");
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (o) {
      return { stdout: "", stderr: `touch: ${o instanceof Error ? o.message : o}
`, exitCode: 1 };
    }
  }
}, es = {
  name: "tr",
  description: "Translate or delete characters",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.d, o = e.s, a = B(s[0] ?? ""), i = B(s[1] ?? ""), c = t.stdin;
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
      for (let a = r; a <= o; a++)
        e += String.fromCharCode(a);
      s += 3;
    } else
      e += t[s], s++;
  return e;
}
const ss = {
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
}, ns = {
  name: "kill",
  description: "Send signal to process",
  async exec(n, t) {
    const { flags: e, values: s, positional: r } = y(n, ["l", "L", "s"]);
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
}, rs = {
  name: "true",
  description: "Return success",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}, os = {
  name: "type",
  description: "Display information about command type",
  async exec(n, t) {
    const { positional: e, flags: s } = y(n);
    if (e.length === 0)
      return { stdout: "", stderr: `type: missing operand
`, exitCode: 1 };
    const r = s.a, o = s.t, a = s.p, i = [];
    let c = 0;
    for (const l of e) {
      const u = (t.env.PATH || "/bin:/usr/bin").split(":");
      let d = !1;
      for (const h of u) {
        const f = h + "/" + l;
        try {
          if (await t.fs.exists(f) && (d = !0, o ? i.push("file") : a ? i.push(f) : i.push(`${l} is ${f}`), !r))
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
}, is = {
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
}, as = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(n, t) {
    const { values: e, positional: s, flags: r } = y(n, ["t", "tabs"]), o = e.t || e.tabs || "8", a = parseInt(o, 10);
    if (isNaN(a) || a <= 0)
      return {
        stdout: "",
        stderr: `unexpand: invalid tab size: '${o}'
`,
        exitCode: 1
      };
    const i = r.a || r.all;
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
        let h = "", f = 0, p = 0;
        for (let m = 0; m < d.length; m++) {
          const g = d[m];
          g === " " ? (p++, f++, f % a === 0 && (i || h.trim() === "" ? (p >= a && (h += "	".repeat(Math.floor(p / a)), p = p % a), p > 0 && (h += " ".repeat(p), p = 0)) : (h += " ".repeat(p), p = 0))) : (p > 0 && (h += " ".repeat(p), p = 0), h += g, f++);
        }
        p > 0 && (h += " ".repeat(p)), u.push(h);
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
}, cs = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["f", "s", "w"]), o = r.f ? parseInt(r.f) : 0, a = r.s ? parseInt(r.s) : 0, i = r.w ? parseInt(r.w) : void 0, c = e.i;
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
      let h = "", f = "", p = 0;
      for (const m of u) {
        const g = ls(m, o, a, i, c);
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
function ls(n, t, e, s, r) {
  let o = n;
  return t > 0 && (o = n.split(/\s+/).slice(t).join(" ")), e > 0 && (o = o.substring(e)), s !== void 0 && (o = o.substring(0, s)), r && (o = o.toLowerCase()), o;
}
function J(n, t, e, s) {
  e.d && t < 2 || e.u && t > 1 || (e.c ? s.push(`${String(t).padStart(7)} ${n}`) : s.push(n));
}
const ds = {
  name: "uname",
  description: "Print system information",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.a, r = t.env.UNAME_SYSNAME ?? "FluffyOS", o = t.env.HOSTNAME ?? "localhost", a = t.env.UNAME_RELEASE ?? "1.0.0", i = t.env.UNAME_VERSION ?? "#1", c = t.env.UNAME_MACHINE ?? "wasm64";
    if (s)
      return { stdout: `${r} ${o} ${a} ${i} ${c}
`, stderr: "", exitCode: 0 };
    if (e.s || !e.n && !e.r && !e.v && !e.m)
      return { stdout: r + `
`, stderr: "", exitCode: 0 };
    const l = [];
    return e.s && l.push(r), e.n && l.push(o), e.r && l.push(a), e.v && l.push(i), e.m && l.push(c), { stdout: l.join(" ") + `
`, stderr: "", exitCode: 0 };
  }
}, us = {
  name: "uptime",
  description: "Tell how long the system has been running",
  async exec(n, t) {
    const { flags: e } = y(n), s = e.p || e.pretty, r = e.s || e.since, o = 86400 + 3600 * 5 + 1380, a = Math.floor(o / 86400), i = Math.floor(o % 86400 / 3600), c = Math.floor(o % 3600 / 60), l = /* @__PURE__ */ new Date(), u = new Date(l.getTime() - o * 1e3), d = [];
    if (r)
      d.push(u.toISOString());
    else if (s) {
      const h = [];
      a > 0 && h.push(`${a} day${a !== 1 ? "s" : ""}`), i > 0 && h.push(`${i} hour${i !== 1 ? "s" : ""}`), c > 0 && h.push(`${c} minute${c !== 1 ? "s" : ""}`), d.push(`up ${h.join(", ")}`);
    } else {
      const h = l.toTimeString().split(" ")[0], f = a > 0 ? `${a} day${a !== 1 ? "s" : ""}, ${i}:${String(c).padStart(2, "0")}` : `${i}:${String(c).padStart(2, "0")}`;
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
}, fs = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.l, o = e.w, a = e.c, i = !r && !o && !a;
    try {
      const { content: c, files: l } = await F(
        s,
        t.stdin,
        t.fs,
        t.cwd,
        t.fs.resolvePath
      ), u = c.split(`
`).length - (c.endsWith(`
`) ? 1 : 0), d = c.split(/\s+/).filter(Boolean).length, h = c.length, f = [];
      return (i || r) && f.push(String(u).padStart(6)), (i || o) && f.push(String(d).padStart(6)), (i || a) && f.push(String(h).padStart(6)), l.length === 1 && f.push(" " + s[0]), { stdout: f.join(" ") + `
`, stderr: "", exitCode: 0 };
    } catch (c) {
      return { stdout: "", stderr: `wc: ${c instanceof Error ? c.message : c}
`, exitCode: 1 };
    }
  }
}, ps = {
  name: "which",
  description: "Locate a command in PATH",
  async exec(n, t) {
    const { flags: e, positional: s } = y(n), r = e.a;
    if (s.length === 0)
      return { stdout: "", stderr: `which: missing argument
`, exitCode: 1 };
    const o = s[0], a = t.env.PATH || "/bin:/usr/bin:/usr/local/bin", i = a.split(":"), c = [];
    for (const l of i) {
      const u = `${l}/${o}`;
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
}, hs = {
  name: "whoami",
  description: "Print current user name",
  async exec(n, t) {
    return { stdout: (t.env.USER ?? t.env.USERNAME ?? "user") + `
`, stderr: "", exitCode: 0 };
  }
}, ms = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(n, t) {
    const { flags: e, positional: s, values: r } = y(n, ["n", "I", "i", "d", "delimiter"]), o = e.I || e.L || e.l, a = r.I || r.i, i = r.n ? parseInt(r.n) : void 0, c = r.d || r.delimiter || /\s+/, l = e.t || e.verbose, u = e.r, d = s.length > 0 ? s.join(" ") : "echo";
    let h;
    if (typeof c == "string" ? h = t.stdin.split(c).filter(Boolean) : h = t.stdin.trim().split(c).filter(Boolean), h.length === 0) {
      if (u)
        return { stdout: "", stderr: "", exitCode: 0 };
      h = [""];
    }
    const f = [], p = [];
    if (a) {
      const m = typeof a == "string" ? a : "{}";
      for (const g of h) {
        const x = d.replace(new RegExp(gs(m), "g"), g);
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
    return d === "echo" && !a && !i ? f.push(...h) : f.push(...p), {
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
function gs(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const xs = {
  name: "yes",
  description: "Output a string repeatedly until killed",
  async exec(n, t) {
    const { positional: e } = y(n), s = e.length > 0 ? e.join(" ") : "y", r = [], o = 1e3;
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
}, ys = {
  ".": ze,
  alias: V,
  awk: X,
  base64: Z,
  basename: Q,
  break: tt,
  case: et,
  cat: nt,
  chmod: rt,
  chown: ot,
  clear: it,
  comm: at,
  continue: ct,
  cp: lt,
  curl: dt,
  cut: ut,
  date: pt,
  declare: gt,
  df: wt,
  diff: Ct,
  dirname: $t,
  do: Pt,
  done: Et,
  du: jt,
  echo: It,
  elif: Tt,
  else: Mt,
  env: kt,
  esac: st,
  eval: Rt,
  exit: Dt,
  expand: Ot,
  expr: Lt,
  export: Ut,
  false: Wt,
  fi: At,
  file: Ht,
  find: Jt,
  fmt: Yt,
  fold: _t,
  for: qt,
  free: Kt,
  function: Gt,
  grep: Vt,
  head: Xt,
  hexdump: Zt,
  hostname: te,
  id: ee,
  if: Nt,
  in: zt,
  install: se,
  join: ne,
  kill: ns,
  less: re,
  ln: oe,
  local: mt,
  ls: ie,
  make: de,
  md5sum: fe,
  mkdir: he,
  mv: me,
  nl: ge,
  od: ye,
  paste: $e,
  patch: be,
  printenv: Ee,
  printf: je,
  pwd: Ie,
  read: Ne,
  readlink: Fe,
  readonly: xt,
  realpath: Te,
  return: Me,
  rm: Ae,
  sed: ke,
  seq: Re,
  set: De,
  sha256sum: Oe,
  shift: Ue,
  sleep: We,
  sort: qe,
  source: _,
  stat: Ge,
  strings: Be,
  tail: Ye,
  tar: _e,
  tee: Ke,
  test: Ve,
  then: Ft,
  time: Xe,
  timeout: Ze,
  touch: ts,
  tr: es,
  trap: ss,
  true: rs,
  type: os,
  unalias: is,
  unexpand: as,
  uniq: cs,
  unset: yt,
  uname: ds,
  until: St,
  uptime: us,
  wc: fs,
  which: ps,
  while: bt,
  whoami: hs,
  xargs: ms,
  yes: xs
}, ws = Object.values(ys);
export {
  V as alias,
  ys as allCommands,
  X as awk,
  Z as base64,
  Q as basename,
  tt as break,
  et as case,
  nt as cat,
  rt as chmod,
  ot as chown,
  it as clear,
  at as comm,
  ws as commandList,
  ct as continue,
  lt as cp,
  dt as curl,
  ut as cut,
  pt as date,
  gt as declare,
  wt as df,
  Ct as diff,
  $t as dirname,
  Pt as do,
  Et as done,
  ze as dot,
  jt as du,
  It as echo,
  Tt as elif,
  Mt as else,
  kt as env,
  st as esac,
  Rt as eval,
  Dt as exit,
  Ot as expand,
  Ut as exportCmd,
  Lt as expr,
  Wt as false,
  At as fi,
  Ht as file,
  Jt as find,
  Yt as fmt,
  _t as fold,
  qt as for,
  Kt as free,
  Gt as function,
  Vt as grep,
  Xt as head,
  Zt as hexdump,
  te as hostname,
  ee as id,
  Nt as if,
  zt as in,
  se as install,
  ne as join,
  ns as kill,
  re as less,
  oe as ln,
  mt as local,
  ie as ls,
  de as make,
  fe as md5sum,
  he as mkdir,
  me as mv,
  ge as nl,
  ye as od,
  $e as paste,
  be as patch,
  Ee as printenv,
  je as printf,
  Ie as pwd,
  Ne as read,
  Fe as readlink,
  xt as readonly,
  Te as realpath,
  Me as return,
  Ae as rm,
  ke as sed,
  Re as seq,
  De as set,
  Oe as sha256sum,
  Ue as shift,
  We as sleep,
  qe as sort,
  _ as source,
  Ge as stat,
  Be as strings,
  Ye as tail,
  _e as tar,
  Ke as tee,
  Ve as test,
  Ft as then,
  Xe as time,
  Ze as timeout,
  ts as touch,
  es as tr,
  ss as trap,
  rs as true,
  os as type,
  is as unalias,
  ds as uname,
  as as unexpand,
  cs as uniq,
  yt as unset,
  St as until,
  us as uptime,
  fs as wc,
  ps as which,
  bt as while,
  hs as whoami,
  ms as xargs,
  xs as yes
};
